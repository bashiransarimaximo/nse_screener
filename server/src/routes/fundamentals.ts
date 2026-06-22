import fs from "fs";
import path from "path";
import YahooFinance from "yahoo-finance2";
import { logger } from "../lib/logger";

const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical", "yahooSurvey"] });

export interface TsEntry {
  date: string;
  revenue: number | null;
  netIncome: number | null;
}

export interface FundamentalsRaw {
  fetchedAt: string;
  pe: number | null;
  roe: number | null;
  roa: number | null;
  opm: number | null;
  stockCagr1Y: number | null;
  evToEbitda: number | null;
  sector: string | null;
  quarterlyTs: TsEntry[];
  annualTs: TsEntry[];
}

export interface FundamentalData {
  pe: number | null;
  peg: number | null;
  roe: number | null;
  roa: number | null;
  evToEbitda: number | null;
  salesGrowthAnnual: number | null;
  salesCagr3Y: number | null;
  salesGrowthQtrYoY: number | null;
  profitGrowthAnnual: number | null;
  profitGrowthQtrYoY: number | null;
  opm: number | null;
  stockCagr1Y: number | null;
  sector: string | null;
  latestQuarterDate: string | null;
  epsAcceleration: boolean | null;
  fetchedAt: string;
}

export const FUND_DIR = path.join(process.cwd(), "data", "fundamentals");
export const FUND_TTL_MS = 24 * 60 * 60 * 1000;

export function fundPath(ticker: string): string {
  const safe = ticker.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(FUND_DIR, `${safe}.json`);
}

/** Derive all computed growth metrics from cached raw arrays — no API calls. */
export function computeFromRaw(raw: FundamentalsRaw): FundamentalData {
  const result: FundamentalData = {
    pe: raw.pe, peg: null, roe: raw.roe, roa: raw.roa ?? null,
    evToEbitda: raw.evToEbitda ?? null,
    opm: raw.opm, stockCagr1Y: raw.stockCagr1Y,
    salesGrowthAnnual: null, salesCagr3Y: null, salesGrowthQtrYoY: null,
    profitGrowthAnnual: null, profitGrowthQtrYoY: null,
    sector: raw.sector ?? null, latestQuarterDate: null,
    epsAcceleration: null,
    fetchedAt: raw.fetchedAt,
  };

  // Quarterly YoY — find the quarter closest to 1 year before the latest (±100 days)
  const qSorted = [...raw.quarterlyTs].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  if (qSorted.length > 0) {
    result.latestQuarterDate = qSorted[qSorted.length - 1].date;
  }
  if (qSorted.length >= 2) {
    const latest = qSorted[qSorted.length - 1];
    const targetMs = new Date(latest.date).getTime() - 365 * 24 * 60 * 60 * 1000;
    let bestMatch: TsEntry | null = null;
    let bestDiff = Infinity;
    for (const q of qSorted.slice(0, qSorted.length - 1)) {
      const diff = Math.abs(new Date(q.date).getTime() - targetMs);
      if (diff < bestDiff && diff < 100 * 24 * 60 * 60 * 1000) { bestDiff = diff; bestMatch = q; }
    }
    if (bestMatch) {
      if (latest.revenue   != null && bestMatch.revenue   && bestMatch.revenue   !== 0)
        result.salesGrowthQtrYoY  = pct(latest.revenue,   bestMatch.revenue);
      if (latest.netIncome != null && bestMatch.netIncome != null && bestMatch.netIncome !== 0)
        result.profitGrowthQtrYoY = pct(latest.netIncome, bestMatch.netIncome);
    }
  }

  // EPS Acceleration: sequential QoQ profit growth rate is positive and improving.
  // Uses 3 most recent quarters (avoids seasonality issues vs pure YoY which needs 5 quarters).
  // Flag when: (a) latest Q profit is positive, (b) QoQ growth is positive, (c) growth rate > prior QoQ.
  if (qSorted.length >= 3) {
    const q0 = qSorted[qSorted.length - 1];
    const q1 = qSorted[qSorted.length - 2];
    const q2 = qSorted[qSorted.length - 3];
    if (q0.netIncome != null && q1.netIncome != null && q2.netIncome != null
        && q0.netIncome > 0 && q1.netIncome !== 0 && q2.netIncome !== 0) {
      const g0 = (q0.netIncome - q1.netIncome) / Math.abs(q1.netIncome);
      const g1 = (q1.netIncome - q2.netIncome) / Math.abs(q2.netIncome);
      result.epsAcceleration = g0 > 0 && g0 > g1;
    }
  }

  // Annual — latest FY vs prior FY; and 3Y CAGR (latest vs 3 FYs ago)
  const aSorted = [...raw.annualTs].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  if (aSorted.length >= 2) {
    const cur  = aSorted[aSorted.length - 1];
    const prev = aSorted[aSorted.length - 2];
    if (cur.revenue   != null && prev.revenue   && prev.revenue   !== 0)
      result.salesGrowthAnnual  = pct(cur.revenue,   prev.revenue);
    if (cur.netIncome != null && prev.netIncome != null && prev.netIncome !== 0)
      result.profitGrowthAnnual = pct(cur.netIncome, prev.netIncome);
  }
  if (aSorted.length >= 4) {
    const cur3  = aSorted[aSorted.length - 1].revenue;
    const base3 = aSorted[aSorted.length - 4].revenue;
    if (cur3 != null && base3 != null && base3 > 0)
      result.salesCagr3Y = Math.round((Math.pow(cur3 / base3, 1 / 3) - 1) * 1000) / 10;
  }

  // PEG = PE / annual earnings growth % — meaningful only when growth > 0
  if (result.pe != null && result.profitGrowthAnnual != null && result.profitGrowthAnnual > 0) {
    result.peg = Math.round((result.pe / result.profitGrowthAnnual) * 100) / 100;
  }

  return result;
}

export function pct(cur: number, prev: number): number {
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

/** Compute annualised 3-year stock price CAGR from daily OHLCV bars. */
export function stockCagr3YFromBars(bars: { date: Date; close: number }[]): number | null {
  if (bars.length < 50) return null;
  const latest = bars[bars.length - 1];
  const targetMs = latest.date.getTime() - 3 * 365 * 24 * 60 * 60 * 1000;
  let best: { date: Date; close: number } | null = null;
  let bestDiff = Infinity;
  for (const b of bars) {
    const diff = Math.abs(b.date.getTime() - targetMs);
    if (diff < bestDiff && diff < 60 * 24 * 60 * 60 * 1000) { bestDiff = diff; best = b; }
  }
  if (!best || best.close <= 0 || latest.close <= 0) return null;
  return Math.round((Math.pow(latest.close / best.close, 1 / 3) - 1) * 1000) / 10;
}

export function loadFundCache(ticker: string): FundamentalsRaw | null {
  const p = fundPath(ticker);
  if (!fs.existsSync(p)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8")) as FundamentalsRaw;
    if (!d.quarterlyTs || !d.annualTs || typeof d.evToEbitda === "undefined") return null; // old cache format — force re-fetch
    if (Date.now() - new Date(d.fetchedAt).getTime() > FUND_TTL_MS) return null;
    return d;
  } catch { return null; }
}

export function saveFundCache(ticker: string, raw: FundamentalsRaw): void {
  if (!fs.existsSync(FUND_DIR)) fs.mkdirSync(FUND_DIR, { recursive: true });
  fs.writeFileSync(fundPath(ticker), JSON.stringify(raw));
}

export async function fetchFundamentals(symbol: string): Promise<FundamentalData> {
  const ticker = symbol.includes(".") ? symbol : `${symbol}.NS`;

  const cached = loadFundCache(ticker);
  if (cached) return computeFromRaw(cached);

  const raw: FundamentalsRaw = {
    fetchedAt: new Date().toISOString(),
    pe: null, roe: null, roa: null, opm: null, stockCagr1Y: null,
    evToEbitda: null, sector: null,
    quarterlyTs: [], annualTs: [],
  };

  try {
    const summary = await yahooFinance.quoteSummary(
      ticker,
      { modules: ["financialData", "summaryDetail", "defaultKeyStatistics", "assetProfile"] as never[] },
      { validateResult: false }
    );
    const fd  = (summary as Record<string, unknown>).financialData       as Record<string, unknown> | undefined;
    const sd  = (summary as Record<string, unknown>).summaryDetail        as Record<string, unknown> | undefined;
    const dks = (summary as Record<string, unknown>).defaultKeyStatistics as Record<string, unknown> | undefined;
    if (fd) {
      if (typeof fd.operatingMargins === "number") raw.opm = Math.round(fd.operatingMargins * 1000) / 10;
      if (typeof fd.returnOnEquity   === "number") raw.roe = Math.round(fd.returnOnEquity   * 1000) / 10;
      if (typeof fd.returnOnAssets   === "number") raw.roa = Math.round(fd.returnOnAssets   * 1000) / 10;
    }
    const ap = (summary as Record<string, unknown>).assetProfile as Record<string, unknown> | undefined;
    if (typeof ap?.sector === "string") raw.sector = ap.sector;
    if (typeof sd?.trailingPE === "number" && (sd.trailingPE as number) > 0)
      raw.pe = Math.round((sd.trailingPE as number) * 10) / 10;
    const c52 = dks?.["52WeekChange"];
    if (typeof c52 === "number") raw.stockCagr1Y = Math.round(c52 * 1000) / 10;
    const evEbitda = dks?.enterpriseToEbitda;
    if (typeof evEbitda === "number" && evEbitda > 0) raw.evToEbitda = Math.round(evEbitda * 10) / 10;
  } catch (err) {
    logger.warn({ symbol: ticker, err: String(err) }, "fetchFundamentals (quoteSummary) error");
  }

  const ftsType = yahooFinance as unknown as {
    fundamentalsTimeSeries: (
      sym: string, opts: Record<string, unknown>, qopts: Record<string, unknown>
    ) => Promise<Array<{ date?: Date; totalRevenue?: number; netIncome?: number }>>
  };

  // Quarterly and annual time-series fetched concurrently — independent calls
  const period1q = new Date();
  period1q.setFullYear(period1q.getFullYear() - 3);
  const period1a = new Date();
  period1a.setFullYear(period1a.getFullYear() - 5);

  const [qResult, aResult] = await Promise.allSettled([
    ftsType.fundamentalsTimeSeries(
      ticker,
      { period1: period1q.toISOString().split("T")[0], type: "quarterly", module: "financials" },
      { validateResult: false }
    ),
    ftsType.fundamentalsTimeSeries(
      ticker,
      { period1: period1a.toISOString().split("T")[0], type: "annual", module: "financials" },
      { validateResult: false }
    ),
  ]);

  if (qResult.status === "fulfilled") {
    raw.quarterlyTs = qResult.value
      .filter(q => q.date)
      .map(q => ({
        date: new Date(q.date!).toISOString().split("T")[0],
        revenue:   q.totalRevenue  ?? null,
        netIncome: q.netIncome     ?? null,
      }));
  } else {
    logger.warn({ symbol: ticker, err: String(qResult.reason) }, "fetchFundamentals (quarterly timeSeries) error");
  }

  if (aResult.status === "fulfilled") {
    raw.annualTs = aResult.value
      .filter(q => q.date)
      .map(q => ({
        date: new Date(q.date!).toISOString().split("T")[0],
        revenue:   q.totalRevenue  ?? null,
        netIncome: q.netIncome     ?? null,
      }));
  } else {
    logger.warn({ symbol: ticker, err: String(aResult.reason) }, "fetchFundamentals (annual timeSeries) error");
  }

  saveFundCache(ticker, raw);
  return computeFromRaw(raw);
}
