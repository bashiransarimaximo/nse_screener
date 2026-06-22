import { Router } from "express";
import YahooFinance from "yahoo-finance2";
import { RunScreenBody } from "@nse/api-zod";
import { logger } from "../lib/logger";
import { db, runSnapshots } from "@nse/db";
import { desc, gte, sql } from "drizzle-orm";
import { saveAllTickers } from "../tickerHistory";
import {
  type OHLCV,
  loadCache,
  saveCache,
  deleteCache,
  getCacheStats,
  getCacheFileModTime,
} from "../priceCache";
import {
  computeFactors,
  buildSyntheticData,
  zscore,
  sleep,
  type SymbolFactors,
} from "./indicators";
import {
  fetchFundamentals,
  stockCagr3YFromBars,
  type FundamentalData,
} from "./fundamentals";

const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

const router = Router();

// ---------------------------------------------------------------------------
// Fetch strategy
//   INITIAL_WARMUP_DAYS  — calendar days to fetch when no cache exists.
//     730 (≈ 500 trading days) gives EMA(26) convergence of (25/27)^500 ≈ 0.
//     This fully matches TradingView which runs indicators from a stock's first bar.
//   OVERLAP_DAYS — how many calendar days before the newest cached bar we
//     always re-fetch from Yahoo.  Catches retroactive adjClose changes caused
//     by dividends / splits that Yahoo applies to all historical bars.
// ---------------------------------------------------------------------------
const INITIAL_WARMUP_DAYS = 1095;
const OVERLAP_DAYS = 90;
// Skip Yahoo fetch if the cached file was written within this window — makes
// repeat same-day runs near-instant while still refreshing once per session.
const PRICE_CACHE_FRESH_MS = 4 * 60 * 60 * 1000; // 4 hours

function adjustedBars(
  quotes: Array<{
    date: Date;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    adjClose?: number | null;
    volume: number | null;
  }>
): OHLCV[] {
  return quotes
    .filter(
      (q) =>
        q.close != null &&
        q.open != null &&
        q.high != null &&
        q.low != null &&
        q.volume != null
    )
    .map((q) => {
      // Scale all OHLC fields by adjClose/close so that TradingView-compatible
      // adjusted prices are used everywhere (RSI, ADX true-range, MACD, ROC).
      const raw = q.close!;
      const adj = q.adjClose ?? raw;
      const ratio = raw !== 0 ? adj / raw : 1;
      return {
        date: new Date(q.date),
        open:   (q.open   ?? 0) * ratio,
        high:   (q.high   ?? 0) * ratio,
        low:    (q.low    ?? 0) * ratio,
        close:  adj,
        volume: q.volume ?? 0,
      };
    });
}

async function fetchYahooData(
  symbol: string,
  _numDays: number,
  attempt = 0
): Promise<OHLCV[] | null> {
  const ticker = symbol.startsWith("^") ? symbol : symbol.includes(".") ? symbol : `${symbol}.NS`;
  const cached = loadCache(ticker);

  // Fast path — skip network call if cache was written within the freshness window.
  // This makes repeat same-day runs near-instant (no Yahoo round-trips).
  if (attempt === 0 && cached && cached.length > 0) {
    const mtime = getCacheFileModTime(ticker);
    if (mtime !== null && Date.now() - mtime < PRICE_CACHE_FRESH_MS) {
      return cached;
    }
  }

  const fullStart = new Date();
  fullStart.setDate(fullStart.getDate() - INITIAL_WARMUP_DAYS);

  let fetchStart: Date;
  if (cached && cached.length > 0) {
    fetchStart = new Date(cached[cached.length - 1].date);
    fetchStart.setDate(fetchStart.getDate() - OVERLAP_DAYS);
    if (fetchStart < fullStart) fetchStart = fullStart;
  } else {
    fetchStart = fullStart;
  }

  // Use yesterday as period2 on retry attempts to skip today's incomplete bar
  const period2 = new Date();
  if (attempt > 0) period2.setDate(period2.getDate() - 1);

  try {
    const quotes = await yahooFinance.historical(
      ticker,
      { period1: fetchStart, period2, interval: "1d" },
      { validateResult: false }
    );

    if (!quotes || quotes.length === 0) {
      return cached && cached.length > 0 ? cached : null;
    }

    const freshBars = adjustedBars(quotes);

    let merged: OHLCV[];
    if (cached && cached.length > 0) {
      // Detect retroactive corporate-action repricing
      const freshByDate = new Map(
        freshBars.map((b) => [b.date.toISOString().slice(0, 10), b])
      );
      let retroactive = false;
      for (const cb of cached) {
        const fb = freshByDate.get(cb.date.toISOString().slice(0, 10));
        if (fb && cb.close > 0 && Math.abs(fb.close / cb.close - 1) > 0.01) {
          retroactive = true;
          logger.info(
            { ticker, cached: cb.close, fresh: fb.close },
            "retroactive price adjustment detected — rebuilding cache"
          );
          break;
        }
      }

      if (retroactive) {
        deleteCache(ticker);
        return fetchYahooData(symbol, _numDays, attempt);
      }

      const fetchStartMs = fetchStart.getTime();
      const oldBars = cached.filter((b) => b.date.getTime() < fetchStartMs);
      merged = [...oldBars, ...freshBars];
    } else {
      merged = freshBars;
    }

    merged.sort((a, b) => a.date.getTime() - b.date.getTime());
    const deduped: OHLCV[] = merged.filter(
      (b, i) => i === 0 || b.date.getTime() !== merged[i - 1].date.getTime()
    );

    saveCache(ticker, deduped);
    return deduped;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ symbol: ticker, attempt, err: msg }, "fetchYahooData error");

    const is429 =
      msg.includes("429") ||
      msg.includes("Too Many") ||
      msg.includes("rate") ||
      msg.includes("HTTP 429");
    if (is429 && attempt < 2) {
      await sleep(2000 + attempt * 2000);
      return fetchYahooData(symbol, _numDays, attempt + 1);
    }

    const isNullValues = msg.includes("null values") || msg.includes("SOME (but not all)");
    if (isNullValues && attempt === 0) {
      logger.info({ ticker }, "null close on today's bar — retrying with period2=yesterday");
      return fetchYahooData(symbol, _numDays, attempt + 1);
    }

    if (cached && cached.length > 0) {
      logger.info({ ticker }, "fetch failed — serving cached data");
      return cached;
    }
    return null;
  }
}

type RawConfig = NonNullable<NonNullable<(typeof RunScreenBody._type)["config"]>>;

export function buildCfg(rawConfig: RawConfig | null | undefined) {
  return {
    lookbackDays:        rawConfig?.lookbackDays        ?? 90,
    minHistoryDays:      rawConfig?.minHistoryDays      ?? 60,
    rocPeriod:           rawConfig?.rocPeriod           ?? 20,
    rsiPeriod:           rawConfig?.rsiPeriod           ?? 14,
    adxPeriod:           rawConfig?.adxPeriod           ?? 14,
    macdFast:            rawConfig?.macdFast            ?? 12,
    macdSlow:            rawConfig?.macdSlow            ?? 26,
    macdSignal:          rawConfig?.macdSignal          ?? 9,
    obvLookback:         rawConfig?.obvLookback         ?? 20,
    accelRocPeriod:      rawConfig?.accelRocPeriod      ?? 10,
    accelDiffPeriod:     rawConfig?.accelDiffPeriod     ?? 5,
    twoWeekOffset:       rawConfig?.twoWeekOffset       ?? 10,
    weightRoc:           rawConfig?.weightRoc           ?? 0.35,
    weightMacd:          rawConfig?.weightMacd          ?? 0.25,
    weightObv:           rawConfig?.weightObv           ?? 0.20,
    weightRsi:           rawConfig?.weightRsi           ?? 0.20,
    useSyntheticData:    rawConfig?.useSyntheticData    ?? false,
    supertrendAtrPeriod: 10,
    supertrendFactor:    3.0,
  };
}

export async function runScreenLogic(
  symbols: string[],
  cfg: ReturnType<typeof buildCfg>,
  onProgress?: (done: number, total: number, phase: "prices" | "fundamentals") => void
) {
  const startMs = Date.now();
  const dataMap = new Map<string, OHLCV[]>();
  const fundMap = new Map<string, FundamentalData>();
  let niftyBars: OHLCV[] | null = null;
  let niftyBarsPromise: Promise<OHLCV[] | null> | null = null;
  let niftyRegime: "BULL" | "BEAR" | "NEUTRAL" = "NEUTRAL";

  if (cfg.useSyntheticData) {
    const synth = buildSyntheticData(symbols, cfg.lookbackDays);
    for (const [k, v] of synth) dataMap.set(k, v);
    onProgress?.(symbols.length * 2, symbols.length * 2, "fundamentals");
  } else {
    // Price pipeline and fundamentals pipeline run concurrently.
    // They use different Yahoo endpoints so they don't share a rate-limit bucket.
    // Progress total = symbols.length * 2:
    //   done 0..N      → prices phase
    //   done N..2N     → fundamentals phase
    const totalProgress = symbols.length * 2;
    let priceDone = 0;
    let fundDone = 0;

    const pricePipeline = async () => {
      const FETCH_CONCURRENCY = 5;
      for (let batchStart = 0; batchStart < symbols.length; batchStart += FETCH_CONCURRENCY) {
        const batch = symbols.slice(batchStart, batchStart + FETCH_CONCURRENCY);
        const results = await Promise.all(
          batch.map((sym) => fetchYahooData(sym, cfg.lookbackDays))
        );
        for (let j = 0; j < batch.length; j++) {
          const data = results[j];
          if (data && data.length >= cfg.minHistoryDays) {
            dataMap.set(batch[j], data);
          }
          priceDone++;
          onProgress?.(priceDone, totalProgress, "prices");
        }
        if (batchStart + FETCH_CONCURRENCY < symbols.length) {
          await sleep(400);
        }
      }
    };

    const fundPipeline = async () => {
      const FUND_BATCH = 5;
      for (let i = 0; i < symbols.length; i += FUND_BATCH) {
        const batch = symbols.slice(i, i + FUND_BATCH);
        const fds = await Promise.all(batch.map(fetchFundamentals));
        batch.forEach((s, j) => fundMap.set(s, fds[j]));
        fundDone += batch.length;
        onProgress?.(symbols.length + fundDone, totalProgress, "fundamentals");
        if (i + FUND_BATCH < symbols.length) await sleep(200);
      }
    };

    // Fetch Nifty 50 concurrently with the stock pipelines
    niftyBarsPromise = fetchYahooData("^NSEI", cfg.lookbackDays);
    await Promise.all([pricePipeline(), fundPipeline()]);
    niftyBars = await niftyBarsPromise;
    // Market regime: Nifty close vs its 200-day EMA (±2% buffer avoids noise at the boundary)
    if (niftyBars && niftyBars.length >= 200) {
      const nc = niftyBars.map(b => b.close);
      const a200 = 2 / 201;
      let ema200 = nc[0];
      for (let i = 1; i < nc.length; i++) ema200 = a200 * nc[i] + (1 - a200) * ema200;
      const nLast = nc[nc.length - 1];
      if      (nLast > ema200 * 1.02) niftyRegime = "BULL";
      else if (nLast < ema200 * 0.98) niftyRegime = "BEAR";
    }
  }

  const factorMap = new Map<string, SymbolFactors>();
  for (const [sym, bars] of dataMap.entries()) {
    const f = computeFactors(bars, cfg);
    if (f) factorMap.set(sym, f);
  }

  if (factorMap.size === 0) {
    return {
      results: [] as ReturnType<typeof buildResults>,
      scoredCount: 0,
      totalSymbols: symbols.length,
      dateCurrent: new Date().toISOString().split("T")[0],
      date2WAgo: new Date().toISOString().split("T")[0],
      durationMs: Date.now() - startMs,
      marketRegime: niftyRegime,
    };
  }

  const scored = buildResults(factorMap, fundMap, cfg, dataMap, niftyBars);
  const first = scored[0];
  return {
    results: scored,
    scoredCount: scored.length,
    totalSymbols: symbols.length,
    dateCurrent: first?.dateCurrent ?? new Date().toISOString().split("T")[0],
    date2WAgo: first?.date2WAgo ?? new Date().toISOString().split("T")[0],
    durationMs: Date.now() - startMs,
    marketRegime: niftyRegime,
  };
}

// ---------------------------------------------------------------------------
// In-memory job store for async screening
// ---------------------------------------------------------------------------
type ScreenResult = Awaited<ReturnType<typeof runScreenLogic>>;

interface ScreenJob {
  status: "pending" | "done" | "error";
  result?: ScreenResult;
  error?: string;
  progress: { done: number; total: number; phase: "prices" | "fundamentals" };
  createdAt: number;
}

const screenJobs = new Map<string, ScreenJob>();

// Prune jobs older than 1 hour to avoid unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [id, job] of screenJobs) {
    if (job.createdAt < cutoff) screenJobs.delete(id);
  }
}, 60_000).unref();

// ─── Technical Grade helpers ──────────────────────────────────────────────────

function rsiZone(rsi: number): number {
  if (rsi >= 55 && rsi <= 75) return 1.00;
  if (rsi > 75 && rsi <= 82) return 0.70;
  if (rsi > 82)               return 0.30;
  if (rsi >= 45 && rsi < 55)  return 0.50;
  return 0.10;
}

function bbPctBZone(bb: number): number {
  if (bb >= 0.60 && bb <= 1.00) return 1.00;
  if (bb > 1.00)                 return 0.70;
  if (bb >= 0.40 && bb < 0.60)  return 0.50;
  if (bb >= 0.20 && bb < 0.40)  return 0.25;
  return 0.10;
}

function betaZone(beta: number): number {
  // Calibrated for NSE momentum universe — typical large/mid-cap β is 0.70–1.40.
  // Previous thresholds (sweet spot 0.25–0.55) were penalising almost all NSE stocks.
  if (beta >= 0.70 && beta <= 1.20) return 1.00; // ideal: market-correlated momentum
  if (beta >  1.20 && beta <= 1.50) return 0.75; // elevated but still tradeable
  if (beta >= 0.50 && beta <  0.70) return 0.60; // slightly defensive
  if (beta >  1.50)                  return 0.40; // too volatile
  if (beta >= 0.00 && beta <  0.50) return 0.35; // very defensive / poorly correlated
  return 0.25;                                     // negative beta
}

/** Winsorise to [lo, hi] percentiles to prevent outlier distortion. */
function winsorise(vals: (number | null)[], lo = 0.05, hi = 0.90): (number | null)[] {
  const sorted = (vals.filter((v): v is number => v != null)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return vals;
  const loVal = sorted[Math.floor(lo * (sorted.length - 1))];
  const hiVal = sorted[Math.floor(hi * (sorted.length - 1))];
  return vals.map(v => v == null ? null : Math.max(loVal, Math.min(hiVal, v)));
}

/** Cross-sectional percentile rank → 0–1. ascending=true means higher value = higher rank. */
function pctRank(vals: (number | null)[], ascending = true): (number | null)[] {
  const indexed = vals
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v != null);
  if (indexed.length === 0) return vals.map(() => null);
  indexed.sort((a, b) => ascending ? a.v - b.v : b.v - a.v);
  const rankMap = new Map<number, number>();
  indexed.forEach((x, rank) => rankMap.set(x.i, (rank + 1) / indexed.length));
  return vals.map((v, i) => v != null ? (rankMap.get(i) ?? null) : null);
}

/**
 * Combine [score, weight] pairs into a weighted average.
 * Null scores are dropped and their weight is redistributed to available components.
 * Returns null only when every score is null.
 */
function weightedCombine(pairs: [number | null, number][]): number | null {
  const valid = pairs.filter((p): p is [number, number] => p[0] != null);
  if (valid.length === 0) return null;
  const totalW = valid.reduce((s, [, w]) => s + w, 0);
  return valid.reduce((s, [v, w]) => s + v * w, 0) / totalW;
}

function buildResults(
  factorMap: Map<string, SymbolFactors>,
  fundMap: Map<string, FundamentalData>,
  cfg: ReturnType<typeof buildCfg>,
  dataMap: Map<string, OHLCV[]>,
  niftyBars: OHLCV[] | null
) {
  // Pre-compute Nifty ROC once (same period as stock rocPeriod)
  let niftyRoc: number | null = null;
  if (niftyBars && niftyBars.length > cfg.rocPeriod) {
    const nLast = niftyBars[niftyBars.length - 1].close;
    const nBase = niftyBars[niftyBars.length - 1 - cfg.rocPeriod].close;
    if (nBase > 0) niftyRoc = ((nLast - nBase) / nBase) * 100;
  }

  // Pre-compute Nifty daily returns keyed by date (YYYY-MM-DD).
  // Date-aligned approach: stock bars and Nifty bars may have different missing days
  // (NSE holidays not in ^NSEI, or vice-versa). Positional alignment would pair
  // wrong returns and introduce phantom zero-return days, deflating variance and
  // biasing beta downward for illiquid stocks.
  const BETA_PERIOD = 252;
  const niftyReturnByDate = new Map<string, number>();
  if (niftyBars && niftyBars.length >= 2) {
    const start = Math.max(1, niftyBars.length - BETA_PERIOD);
    for (let i = start; i < niftyBars.length; i++) {
      const prev = niftyBars[i - 1].close;
      if (prev > 0) {
        const dk = niftyBars[i].date.toISOString().split("T")[0];
        niftyReturnByDate.set(dk, (niftyBars[i].close - prev) / prev);
      }
    }
  }

  const syms = Array.from(factorMap.keys());
  const rocCurrent    = syms.map((s) => factorMap.get(s)!.rocCurrent);
  const roc2W         = syms.map((s) => factorMap.get(s)!.roc2WAgo);
  const macdCurrent   = syms.map((s) => factorMap.get(s)!.macdCurrent);
  const macd2W        = syms.map((s) => factorMap.get(s)!.macd2WAgo);
  const obvCurrent    = syms.map((s) => factorMap.get(s)!.obvCurrent);
  const obv2W         = syms.map((s) => factorMap.get(s)!.obv2WAgo);
  const rsiCurrentArr = syms.map((s) => factorMap.get(s)!.rsiCurrent);
  const rsi2WArr      = syms.map((s) => factorMap.get(s)!.rsi2WAgo);

  const zRocC   = zscore(rocCurrent);
  const zRoc2W  = zscore(roc2W);
  const zMacdC  = zscore(macdCurrent);
  const zMacd2W = zscore(macd2W);
  const zObvC   = zscore(obvCurrent);
  const zObv2W  = zscore(obv2W);
  const zRsiC   = zscore(rsiCurrentArr);
  const zRsi2W  = zscore(rsi2WArr);

  const results = syms.map((sym, i) => {
    const f = factorMap.get(sym)!;
    const compositeCurrent =
      cfg.weightRoc  * (zRocC[i]  ?? 0) +
      cfg.weightMacd * (zMacdC[i] ?? 0) +
      cfg.weightObv  * (zObvC[i]  ?? 0) +
      cfg.weightRsi  * (zRsiC[i]  ?? 0);
    const composite2W =
      cfg.weightRoc  * (zRoc2W[i]  ?? 0) +
      cfg.weightMacd * (zMacd2W[i] ?? 0) +
      cfg.weightObv  * (zObv2W[i]  ?? 0) +
      cfg.weightRsi  * (zRsi2W[i]  ?? 0);
    return {
      symbol: sym,
      compositeScoreCurrent: round(compositeCurrent),
      compositeScore2WAgo:   round(composite2W),
      compositeScoreChange:  round(compositeCurrent - composite2W),
      rocCurrent:  round(f.rocCurrent),
      roc2WAgo:    round(f.roc2WAgo),
      rocDiff:     round(f.rocCurrent - f.roc2WAgo),
      zRocCurrent: round(zRocC[i]  ?? 0),
      zRoc2WAgo:   round(zRoc2W[i] ?? 0),
      macdCurrent:  round(f.macdCurrent),
      macd2WAgo:    round(f.macd2WAgo),
      zMacdCurrent: round(zMacdC[i]  ?? 0),
      zMacd2WAgo:   round(zMacd2W[i] ?? 0),
      obvCurrent:  round(f.obvCurrent),
      obv2WAgo:    round(f.obv2WAgo),
      obvDiff:     round(f.obvCurrent - f.obv2WAgo),
      zObvCurrent: round(zObvC[i]  ?? 0),
      zObv2WAgo:   round(zObv2W[i] ?? 0),
      rsiCurrent: round(f.rsiCurrent),
      rsi2WAgo:   round(f.rsi2WAgo),
      rsiDiff:    round(f.rsiCurrent - f.rsi2WAgo),
      adxCurrent: round(f.adxCurrent),
      adx2WAgo:   round(f.adx2WAgo),
      adxDiff:    round(f.adxCurrent - f.adx2WAgo),
      supertrendBullish: f.supertrendBullish,
      supertrendValue:   round(f.supertrendValue),
      emaRank: f.emaRank,
      pe:                 fundMap.get(sym)?.pe                ?? null,
      roe:                fundMap.get(sym)?.roe               ?? null,
      evToEbitda:         fundMap.get(sym)?.evToEbitda        ?? null,
      salesGrowthAnnual:  fundMap.get(sym)?.salesGrowthAnnual  ?? null,
      salesCagr3Y:        fundMap.get(sym)?.salesCagr3Y        ?? null,
      salesGrowthQtrYoY:  fundMap.get(sym)?.salesGrowthQtrYoY  ?? null,
      profitGrowthAnnual: fundMap.get(sym)?.profitGrowthAnnual ?? null,
      profitGrowthQtrYoY: fundMap.get(sym)?.profitGrowthQtrYoY ?? null,
      epsAcceleration:    fundMap.get(sym)?.epsAcceleration    ?? null,
      opm:                fundMap.get(sym)?.opm                ?? null,
      stockCagr1Y:        fundMap.get(sym)?.stockCagr1Y        ?? null,
      stockCagr3Y:        stockCagr3YFromBars(dataMap.get(sym) ?? []),
      cmfCurrent:         round(f.cmfCurrent),
      highPct52w:         round(f.highPct52w),
      lowPct52w:          round(f.lowPct52w),
      rsVsNifty:          niftyRoc != null ? round(f.rocCurrent - niftyRoc) : null,
      volRatio:           round(f.volRatio),
      atrPct:             round(f.atrPct),
      bbPctB:             round(f.bbPctB),
      bbPctB2W:           round(f.bbPctB2WAgo),
      roa:                fundMap.get(sym)?.roa                ?? null,
      sector:             fundMap.get(sym)?.sector             ?? null,
      latestQuarterDate:  fundMap.get(sym)?.latestQuarterDate  ?? null,
      beta1Y:             (() => {
        if (niftyReturnByDate.size < 20) return null;
        const stockBars = dataMap.get(sym) ?? [];
        if (stockBars.length < 2) return null;
        const startIdx = Math.max(1, stockBars.length - BETA_PERIOD);
        // Collect (stockReturn, niftyReturn) pairs only for dates present in both series
        const pairs: [number, number][] = [];
        for (let i = startIdx; i < stockBars.length; i++) {
          const dk = stockBars[i].date.toISOString().split("T")[0];
          const nr = niftyReturnByDate.get(dk);
          if (nr === undefined) continue; // NSE holiday or Nifty gap — skip
          const prev = stockBars[i - 1].close;
          if (prev <= 0) continue;
          pairs.push([(stockBars[i].close - prev) / prev, nr]);
        }
        if (pairs.length < 20) return null;
        const pN    = pairs.length;
        const sMean = pairs.reduce((a, [s]) => a + s, 0) / pN;
        const nMean = pairs.reduce((a, [, n]) => a + n, 0) / pN;
        let cov = 0, nVar = 0;
        for (const [s, n] of pairs) { cov += (s - sMean) * (n - nMean); nVar += (n - nMean) ** 2; }
        return nVar > 0 ? round(cov / nVar) : null;
      })(),
      peg:                fundMap.get(sym)?.peg                ?? null,
      dateCurrent: f.dateCurrent.toISOString().split("T")[0],
      date2WAgo:   f.date2WAgo.toISOString().split("T")[0],
      technicalGrade: "" as string,
      technicalScore: 0 as number,
      scoreSubA: 0 as number,
      scoreSubB: 0 as number,
      scoreSubC: 0 as number,
      vqGrade:    "" as string,
      vqScore:    null as number | null,
      vqFlags:    "" as string,
      techFlags:  "" as string,
      conviction: "" as string,
      bearishDivergence: false,
    };
  });

  // ─── Technical Grade (cross-sectional — needs full results array) ──────────
  if (results.length > 1) {
    // Single extraction pass — avoids 17 separate results.map iterations
    const rN = results.length;
    const _tRocC   = new Array<number>(rN),         _tRocD   = new Array<number>(rN),
          _tAdxC   = new Array<number>(rN),         _tAdxD   = new Array<number>(rN),
          _tEmaR   = new Array<number>(rN),         _tMacdC  = new Array<number>(rN),
          _tMacdCh = new Array<number>(rN),         _tObvC   = new Array<number>(rN),
          _tObvD   = new Array<number>(rN),         _tVol    = new Array<number>(rN),
          _tAtr    = new Array<number>(rN),         _tRsiD   = new Array<number>(rN),
          _t52H    = new Array<number>(rN),         _t52L    = new Array<number>(rN),
          _tBbChg  = new Array<number>(rN),
          _tCmf    = new Array<number | null>(rN),  _tRs     = new Array<number | null>(rN);
    for (let i = 0; i < rN; i++) {
      const r = results[i];
      _tRocC[i]   = r.rocCurrent;              _tRocD[i]   = r.rocDiff;
      _tAdxC[i]   = r.adxCurrent;              _tAdxD[i]   = r.adxDiff;
      _tEmaR[i]   = r.emaRank;                 _tMacdC[i]  = r.macdCurrent;
      _tMacdCh[i] = r.macdCurrent - r.macd2WAgo;
      _tObvC[i]   = r.obvCurrent;              _tObvD[i]   = r.obvDiff;
      _tCmf[i]    = r.cmfCurrent;              _tRs[i]     = r.rsVsNifty;
      _t52H[i]    = r.highPct52w;              _t52L[i]    = r.lowPct52w;
      _tVol[i]    = r.volRatio;               _tAtr[i]    = r.atrPct;
      _tRsiD[i]   = r.rsiDiff;
      _tBbChg[i]  = r.bbPctB - (r.bbPctB2W ?? r.bbPctB);
    }

    const prRoc    = pctRank(_tRocC);
    const prRocD   = pctRank(_tRocD);
    const prAdx    = pctRank(_tAdxC);
    const prAdxD   = pctRank(_tAdxD);
    const prEmaR   = pctRank(_tEmaR,  false); // lower EMA rank = better
    const prMacd   = pctRank(winsorise(_tMacdC));
    const prMacdCh = pctRank(winsorise(_tMacdCh));
    const prObv    = pctRank(winsorise(_tObvC));
    const prObvD   = pctRank(winsorise(_tObvD));
    const prCmf    = pctRank(_tCmf);
    const prRs     = pctRank(_tRs);
    const pr52H    = pctRank(_t52H);
    const pr52L    = pctRank(_t52L);
    const prVol    = pctRank(_tVol);
    const prAtr    = pctRank(_tAtr,  false); // lower ATR = smoother = better
    const prRsiD   = pctRank(_tRsiD);
    const prBbChg  = pctRank(_tBbChg);

    results.forEach((r, i) => {
      const stBin  = r.supertrendBullish ? 1.0 : 0.0;
      const zsRsi  = rsiZone(r.rsiCurrent);
      const zsBB   = bbPctBZone(r.bbPctB);
      const zsBeta = r.beta1Y != null ? betaZone(r.beta1Y) : 0.5;

      // Sub-Score A: Momentum State (current strength)
      const A =
        0.20 * (prRoc[i]  ?? 0.5) +
        0.12 * zsRsi +
        0.10 * (prAdx[i]  ?? 0.5) +
        0.08 * (prEmaR[i] ?? 0.5) +
        0.05 * stBin +
        0.09 * (prMacd[i] ?? 0.5) +
        0.09 * (prObv[i]  ?? 0.5) +
        0.05 * (prCmf[i]  ?? 0.5) +
        0.08 * zsBB +
        0.08 * (prRs[i]   ?? 0.5) +   // +1% from 52W Low (which was below rounding noise)
        0.06 * (pr52H[i]  ?? 0.5);

      // Sub-Score B: Momentum Change (2-week acceleration)
      // RSI change reduced 20%→10%: highly correlated with ROC change (~0.7–0.8 empirically).
      // BB%B change added at 10%: range-relative momentum shift captures band-expansion acceleration.
      const B =
        0.30 * (prRocD[i]   ?? 0.5) +
        0.20 * (prObvD[i]   ?? 0.5) +
        0.10 * (prRsiD[i]   ?? 0.5) +
        0.10 * (prBbChg[i]  ?? 0.5) +
        0.15 * (prMacdCh[i] ?? 0.5) +
        0.15 * (prAdxD[i]   ?? 0.5);

      // Sub-Score C: Risk Quality
      // ATR reduced from 50%→30%: the old weight structurally penalised volatile
      // mid/small-caps even with strong momentum (unintended large-cap filter).
      // Beta raised to 40%: directional market correlation is the more meaningful
      // risk signal for a momentum strategy. Volume raised to 30%.
      const C =
        0.30 * (prAtr[i]  ?? 0.5) +
        0.40 * zsBeta +
        0.30 * (prVol[i]  ?? 0.5);

      const rawScore = Math.round((A * 0.50 + B * 0.35 + C * 0.15) * 1000) / 10;
      r.scoreSubA = Math.round(A * 1000) / 1000;
      r.scoreSubB = Math.round(B * 1000) / 1000;
      r.scoreSubC = Math.round(C * 1000) / 1000;
      // Bearish divergence: price accelerating (ROC diff >+2%) while RSI falling (<-3).
      // Signals momentum exhaustion. Only deducts when Supertrend is still bullish
      // (if bearish, the Supertrend penalty already applies).
      const bearishDiv = (r.rocDiff ?? 0) > 2 && (r.rsiDiff ?? 0) < -3;
      r.bearishDivergence = bearishDiv;
      // Volume-Price Divergence: price ROC accelerating (+>1%) but OBV declining.
      // Signals distribution — buyers are pushing price up without volume conviction.
      // Only deducts when ST is bullish and bearishDiv is not already triggering.
      const volPriceDiv = !bearishDiv && (r.rocDiff ?? 0) > 1 && (r.obvDiff ?? 0) < 0;
      // Bullish divergence: price ROC declining (<−2%) while RSI recovering (+>3%).
      // Early reversal signal — reduces the ST bearish penalty by 4 pts.
      const bullishDiv = !bearishDiv && (r.rocDiff ?? 0) < -2 && (r.rsiDiff ?? 0) > 3;
      // Volume Breakout: volume spike ≥2× avg AND price trending up.
      // Signals institutional participation confirming the move (+3 pts, bullish only).
      const volBreakout = !bearishDiv && r.supertrendBullish === true && (r.volRatio ?? 0) >= 2.0 && (r.rocCurrent ?? 0) > 0;
      // Supertrend deduction — bearish primary trend subtracts 12 pts instead of
      // hard-capping at C, which was too blunt (e.g. score 85 → stuck at 59).
      const score = r.supertrendBullish
        ? Math.min(100, Math.max(0, rawScore - (bearishDiv ? 6 : 0) - (volPriceDiv ? 4 : 0) + (volBreakout ? 3 : 0)))
        : Math.max(0, rawScore - 12 + (bullishDiv ? 4 : 0));
      let grade: string;
      if      (score >= 75) grade = "A";
      else if (score >= 60) grade = "B";
      else if (score >= 45) grade = "C";
      else if (score >= 30) grade = "D";
      else                   grade = "F";

      r.technicalGrade = grade;
      r.technicalScore = score;

      // Tech Flags — surface key structural signals alongside the grade.
      // All inputs already computed at this point.
      const tFlags: string[] = [];
      if (!r.supertrendBullish)                      tFlags.push("ST_BEARISH");
      if (bearishDiv)                                tFlags.push("BEARISH_DIV");
      if (bullishDiv)                                tFlags.push("BULL_DIV");
      if (volPriceDiv)                               tFlags.push("VOL_DIV");
      if (volBreakout)                               tFlags.push("VOL_BREAKOUT");
      if ((r.rsiCurrent ?? 0) > 80)                  tFlags.push("OVERBOUGHT");
      if ((r.emaRank ?? 0) >= 5)                     tFlags.push("BELOW_EMA200");
      if ((r.highPct52w ?? -100) > -5)               tFlags.push("NEAR_BREAKOUT");
      r.techFlags = tFlags.join(",");
    });
  }

  // ─── Valuation & Quality Grade ─────────────────────────────────────────────
  if (results.length > 1) {
    // Single extraction pass — avoids 15 separate results.map iterations
    const rN = results.length;
    const _pe    = new Array<number | null>(rN), _peg   = new Array<number | null>(rN),
          _ev    = new Array<number | null>(rN), _roe   = new Array<number | null>(rN),
          _opm   = new Array<number | null>(rN), _pga   = new Array<number | null>(rN),
          _pgq   = new Array<number | null>(rN), _sgq   = new Array<number | null>(rN),
          _scagr = new Array<number | null>(rN), _roa   = new Array<number | null>(rN);
    // _sc1 / _sc3 (Stock CAGR 1Y/3Y) intentionally excluded from VQ computation.
    // Price-return data is already captured in Sub-Score A (ROC, RS vs Nifty, 52W High).
    // Including it in VQ Pillar 4 then feeding both into Conviction creates a circular
    // dependency where high-momentum stocks get rewarded twice for the same price move.
    const sortedOpms: number[] = [];
    for (let i = 0; i < rN; i++) {
      const r = results[i];
      _pe[i]    = r.pe;                 _peg[i]   = r.peg;
      _ev[i]    = r.evToEbitda;         _roe[i]   = r.roe;
      _opm[i]   = r.opm;               _pga[i]   = r.profitGrowthAnnual;
      _pgq[i]   = r.profitGrowthQtrYoY; _sgq[i]  = r.salesGrowthQtrYoY;
      _scagr[i] = r.salesCagr3Y;
      _roa[i]   = r.roa;
      if (r.opm != null) sortedOpms.push(r.opm);
    }
    sortedOpms.sort((a, b) => a - b);
    // medianOpm removed — ROCE proxy now uses ROE + ROA direct blend (see rocePrx below)

    // ROCE proxy: 60% ROE + 40% ROA.
    // Replaces the OPM-ratio approximation which inflated scores for high-margin businesses
    // regardless of capital turnover. ROA is a direct capital efficiency metric from Yahoo.
    const rocePrx: (number | null)[] = _roe.map((roe, i) => {
      const roa = _roa[i];
      if (roe == null && roa == null) return null;
      if (roe == null) return roa;
      if (roa == null) return roe;
      return 0.6 * roe + 0.4 * roa;
    });

    // Winsorise outlier fields before ranking
    const peW  = winsorise(_pe,  0.05, 0.90);
    const pegW = winsorise(_peg, 0.05, 0.90);
    const evW  = winsorise(_ev,  0.05, 0.90);
    const pgaW = winsorise(_pga, 0.05, 0.95);
    const pgqW = winsorise(_pgq, 0.05, 0.95);
    // Percentile ranks
    const prPeg    = pctRank(pegW,   false); // lower = better
    const prEvEb   = pctRank(evW,    false);
    const prPe     = pctRank(peW,    false);
    const prRoce   = pctRank(rocePrx);
    const prOpm    = pctRank(_opm);
    const prScagr3 = pctRank(_scagr);
    const prPga    = pctRank(pgaW);
    const prSgq    = pctRank(_sgq);
    const prPgq    = pctRank(pgqW);

    results.forEach((r, i) => {
      // Pillar 1: Valuation (30%)
      const p1 = weightedCombine([
        [prPeg[i],  0.40],
        [prEvEb[i], 0.35],
        [prPe[i],   0.25],
      ]);

      // Pillar 2: Quality (30%)
      const p2 = weightedCombine([
        [prRoce[i], 0.55],
        [prOpm[i],  0.45],
      ]);

      // Pillar 3: Growth (25%)
      const p3 = weightedCombine([
        [prScagr3[i], 0.35],
        [prPga[i],    0.30],
        [prSgq[i],    0.20],
        [prPgq[i],    0.15],
      ]);

      // Pillar 4 (Market Validation via Stock CAGR) removed.
      // Weights redistributed: P1 30%→35%, P2 30%→35%, P3 25%→30%.
      const pillars: [number | null, number][] = [
        [p1, 0.35], [p2, 0.35], [p3, 0.30],
      ];
      const coveredW = pillars.filter(([s]) => s != null).reduce((sum, [, w]) => sum + w, 0);
      let vqScore: number | null = null;
      let vqGrade = "N/A";
      if (coveredW >= 0.40) {
        const raw = pillars.filter(([s]) => s != null)
          .reduce((sum, [s, w]) => sum + (s as number) * w, 0) / coveredW;
        vqScore = Math.round(raw * 1000) / 10;
        if      (vqScore >= 75) vqGrade = "A";
        else if (vqScore >= 60) vqGrade = "B";
        else if (vqScore >= 45) vqGrade = "C";
        else if (vqScore >= 30) vqGrade = "D";
        else                     vqGrade = "F";
      }

      // Special flags
      const flags: string[] = [];
      if ((r.roe != null && r.roe < 0) || (r.opm != null && r.opm < 0)) flags.push("LOSS_MAKING");
      if (p1 != null && p3 != null && p1 < 0.20 && p3 > 0.70) flags.push("GROWTH_PRICED");
      if (r.stockCagr3Y == null) flags.push("NEW_LISTING");
      if (r.epsAcceleration === true) flags.push("EPS_ACCEL");

      // Continuous Conviction — uses raw scores, not discretised grades.
      // Removes cliff edges: Tech 61 and 74 were both Grade B, giving identical conviction.
      const ts = r.technicalScore;
      const vs = r.vqScore;
      let conviction: string;
      if      (ts >= 65 && vs != null && vs >= 65)            conviction = "HIGH";
      else if (ts >= 65 && (vs == null || vs < 65))           conviction = "MOMENTUM";
      else if (ts >= 40 && ts < 65 && vs != null && vs >= 65) conviction = "VALUE_WATCH";
      else if (ts < 40  || (vs != null && vs < 35))           conviction = "AVOID";
      else                                                     conviction = "NEUTRAL";

      r.vqGrade   = vqGrade;
      r.vqScore   = vqScore;
      r.vqFlags   = flags.join(",");
      r.conviction = conviction;
    });
  }

  results.sort((a, b) => b.compositeScoreCurrent - a.compositeScoreCurrent);
  return results;
}

// ---------------------------------------------------------------------------
// POST /screen/start — kick off a background screening job; returns jobId
//                      immediately (< 50 ms) so no proxy timeout is hit.
// GET  /screen/jobs/:jobId — poll for progress + result.
// ---------------------------------------------------------------------------
router.post("/screen/start", (req, res) => {
  const parseResult = RunScreenBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { symbols, config: rawConfig } = parseResult.data;
  const cfg = buildCfg(rawConfig);
  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const job: ScreenJob = {
    status: "pending",
    progress: { done: 0, total: symbols.length * 2, phase: "prices" },
    createdAt: Date.now(),
  };
  screenJobs.set(jobId, job);

  // 5-minute safety timeout — marks the job as error if Yahoo Finance stalls indefinitely
  const timeoutId = setTimeout(() => {
    const j = screenJobs.get(jobId);
    if (j && j.status === "pending") {
      j.status = "error";
      j.error = "Timed out after 5 minutes — Yahoo Finance may be unreachable";
    }
  }, 5 * 60 * 1000);

  void runScreenLogic(symbols, cfg, (done, total, phase) => {
    const j = screenJobs.get(jobId);
    if (j) j.progress = { done, total, phase };
  }).then((result) => {
    clearTimeout(timeoutId);
    const j = screenJobs.get(jobId);
    if (j) { j.status = "done"; j.result = result; }
    saveAllTickers(result.results, result.dateCurrent);
  }).catch((err) => {
    clearTimeout(timeoutId);
    const j = screenJobs.get(jobId);
    if (j) { j.status = "error"; j.error = String(err); }
  });

  res.json({ jobId, total: symbols.length });
});

router.get("/screen/jobs/:jobId", (req, res) => {
  const job = screenJobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json({
    status: job.status,
    progress: job.progress,
    result: job.status === "done" ? job.result : undefined,
    error: job.status === "error" ? job.error : undefined,
  });
});

// ---------------------------------------------------------------------------
// GET  /screen/cache-stats — how much data is cached
// POST /screen/cache-clear — wipe all cached price data (forces full re-fetch)
// ---------------------------------------------------------------------------
router.get("/screen/cache-stats", (_req, res) => {
  res.json(getCacheStats());
});

router.post("/screen/cache-clear", (_req, res) => {
  const { cachedSymbols } = getCacheStats();
  const { execSync } = require("child_process");
  try {
    execSync(`rm -rf "${process.cwd()}/data/cache"`);
    logger.info({ cleared: cachedSymbols }, "price cache cleared");
    res.json({ cleared: cachedSymbols });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// GET /screener/runs — fetch historical run snapshots
// ---------------------------------------------------------------------------
router.get("/screener/runs", async (req, res) => {
  try {
    const days = Math.min(parseInt(String(req.query.days ?? "90"), 10) || 90, 365);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const rows = await db
      .select()
      .from(runSnapshots)
      .where(gte(runSnapshots.runDate, cutoffStr))
      .orderBy(desc(runSnapshots.runDate))
      .limit(90);
    res.json(rows);
  } catch (e) {
    req.log.error({ err: e }, "getRunHistory failed");
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /screener/runs — upsert a run snapshot by runDate
// ---------------------------------------------------------------------------
router.post("/screener/runs", async (req, res) => {
  const { runDate, results } = req.body as { runDate?: unknown; results?: unknown };
  if (typeof runDate !== "string" || !Array.isArray(results)) {
    res.status(400).json({ error: "runDate (string) and results (array) are required" });
    return;
  }
  try {
    const [row] = await db
      .insert(runSnapshots)
      .values({ runDate, symbolCount: results.length, results: results as object[] })
      .onConflictDoUpdate({
        target: runSnapshots.runDate,
        set: {
          scoredAt: sql`now()`,
          symbolCount: results.length,
          results: results as object[],
        },
      })
      .returning();
    res.status(201).json(row);
  } catch (e) {
    req.log.error({ err: e }, "saveRunSnapshot failed");
    res.status(500).json({ error: String(e) });
  }
});

// ---------------------------------------------------------------------------
// POST /screen — kept for backward-compat (synthetic-data runs are instant)
// ---------------------------------------------------------------------------
router.post("/screen", async (req, res) => {
  const parseResult = RunScreenBody.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { symbols, config: rawConfig } = parseResult.data;
  const cfg = buildCfg(rawConfig);
  const payload = await runScreenLogic(symbols, cfg);
  saveAllTickers(payload.results, payload.dateCurrent);
  res.json(payload);
});

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export default router;
