import type { OHLCV } from "../priceCache";

export function calcRoc(close: number[], period: number): number[] {
  return close.map((c, i) => {
    if (i < period || close[i - period] === 0) return NaN;
    return ((c - close[i - period]) / close[i - period]) * 100;
  });
}

export function ema(values: number[], span: number): number[] {
  const alpha = 2 / (span + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  let initialized = false;
  let prev = 0;
  for (let i = 0; i < values.length; i++) {
    if (isNaN(values[i])) continue;
    if (!initialized) {
      prev = values[i];
      result[i] = prev;
      initialized = true;
    } else {
      prev = alpha * values[i] + (1 - alpha) * prev;
      result[i] = prev;
    }
  }
  return result;
}

export function calcMacdHist(
  close: number[],
  fast: number,
  slow: number,
  signal: number
): number[] {
  const emaFast = ema(close, fast);
  const emaSlow = ema(close, slow);
  const macdLine = close.map((_, i) =>
    isNaN(emaFast[i]) || isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i]
  );
  const signalLine = ema(macdLine, signal);
  return close.map((_, i) =>
    isNaN(macdLine[i]) || isNaN(signalLine[i]) ? NaN : macdLine[i] - signalLine[i]
  );
}

export function calcObv(close: number[], volume: number[]): number[] {
  const obv: number[] = new Array(close.length).fill(0);
  for (let i = 1; i < close.length; i++) {
    const diff = close[i] - close[i - 1];
    const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    obv[i] = obv[i - 1] + dir * volume[i];
  }
  return obv;
}

// ---------------------------------------------------------------------------
// CMF — Chaikin Money Flow (period = 20 by convention)
//   MFM = ((close - low) - (high - close)) / (high - low)   → -1..1
//   CMF = Σ(MFM × volume, N) / Σ(volume, N)
// ---------------------------------------------------------------------------
export function calcCmf(
  high: number[], low: number[], close: number[], volume: number[], period: number
): number[] {
  const n = close.length;
  const result = new Array<number>(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let sumMFV = 0, sumVol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const hl = high[j] - low[j];
      const mfm = hl === 0 ? 0 : ((close[j] - low[j]) - (high[j] - close[j])) / hl;
      sumMFV += mfm * volume[j];
      sumVol  += volume[j];
    }
    result[i] = sumVol === 0 ? 0 : sumMFV / sumVol;
  }
  return result;
}

export function calcRsi(close: number[], period: number): number[] {
  // Wilder's RSI — correct implementation:
  //   1. Seed avgGain/avgLoss with the simple average of the first `period` changes
  //   2. From period+1 onwards apply Wilder's smoothing: (prev*(period-1) + current) / period
  const result: number[] = new Array(close.length).fill(NaN);
  if (close.length < period + 1) return result;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsi = (ag: number, al: number) =>
    al === 0 ? 100 : 100 - 100 / (1 + ag / al);

  result[period] = rsi(avgGain, avgLoss);

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result[i + 1] = rsi(avgGain, avgLoss);
  }

  return result;
}

export function calcAdx(
  high: number[],
  low: number[],
  close: number[],
  period: number
): number[] {
  // Wilder's ADX — matches TradingView
  const n = close.length;
  const result = new Array<number>(n).fill(NaN);
  if (n < period * 2 + 1) return result;

  let sTR = 0, sPlusDM = 0, sMinusDM = 0;
  let adx = 0, adxInit = false;
  let dxSum = 0, dxCount = 0;

  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    const up = high[i] - high[i - 1];
    const dn = low[i - 1] - low[i];
    const plusDM = up > dn && up > 0 ? up : 0;
    const minusDM = dn > up && dn > 0 ? dn : 0;

    if (i <= period) {
      sTR += tr; sPlusDM += plusDM; sMinusDM += minusDM;
      if (i === period && sTR > 0) {
        const pDI = 100 * sPlusDM / sTR;
        const mDI = 100 * sMinusDM / sTR;
        const sum = pDI + mDI;
        if (sum > 0) { dxSum += 100 * Math.abs(pDI - mDI) / sum; dxCount++; }
      }
    } else {
      sTR      = sTR      - sTR      / period + tr;
      sPlusDM  = sPlusDM  - sPlusDM  / period + plusDM;
      sMinusDM = sMinusDM - sMinusDM / period + minusDM;

      if (sTR > 0) {
        const pDI = 100 * sPlusDM / sTR;
        const mDI = 100 * sMinusDM / sTR;
        const diSum = pDI + mDI;
        if (diSum > 0) {
          const dx = 100 * Math.abs(pDI - mDI) / diSum;
          if (!adxInit) {
            dxSum += dx; dxCount++;
            if (dxCount >= period) {
              adx = dxSum / period;
              adxInit = true;
              result[i] = adx;
            }
          } else {
            adx = (adx * (period - 1) + dx) / period;
            result[i] = adx;
          }
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// EMA Rank — price position relative to EMA20 / EMA50 / EMA200
// ---------------------------------------------------------------------------
export function calcEmaRank(price: number, e20: number, e50: number, e200: number): number {
  const pA20  = price > e20;
  const pA50  = price > e50;
  const pA200 = price > e200;

  if (pA20 && pA50 && pA200) {
    if (e20 > e50 && e50 > e200) return 1;
    if (e20 > e200 && e200 > e50) return 2;
    return 3;
  }
  if (pA20 && pA50 && !pA200) return 5;
  if (pA20 && !pA50 && pA200) return 6;
  if (pA20 && !pA50 && !pA200) return 6;
  if (!pA20 && pA50 && pA200) return 7;
  if (!pA20 && pA50 && !pA200) return 7;
  if (!pA20 && !pA50 && pA200) {
    if (e20 < e50) return 4;
    return 7;
  }
  if (e20 > e50) return 8;
  return 9;
}

// ---------------------------------------------------------------------------
// Supertrend — exact match to TradingView Pine Script v5 (ATR period=10, factor=3)
// ---------------------------------------------------------------------------
export interface SupertrendBar {
  value: number;
  bullish: boolean;
}

export function calcSupertrend(
  high: number[],
  low: number[],
  close: number[],
  atrPeriod: number,
  factor: number
): Array<SupertrendBar | null> {
  const n = close.length;
  const result: Array<SupertrendBar | null> = new Array(n).fill(null);
  if (n < atrPeriod + 1) return result;

  const atr: number[] = new Array(n).fill(NaN);
  let trSum = 0, trCount = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    if (trCount < atrPeriod) {
      trSum += tr; trCount++;
      if (trCount === atrPeriod) atr[i] = trSum / atrPeriod;
    } else {
      atr[i] = (atr[i - 1] * (atrPeriod - 1) + tr) / atrPeriod;
    }
  }

  let prevAdjUpper = NaN, prevAdjLower = NaN, prevST = NaN;
  let direction = 1;

  for (let i = 1; i < n; i++) {
    if (isNaN(atr[i])) continue;

    const hl2 = (high[i] + low[i]) / 2;
    const basicUpper = hl2 + factor * atr[i];
    const basicLower = hl2 - factor * atr[i];

    const newAdjLower = isNaN(prevAdjLower)
      ? basicLower
      : basicLower > prevAdjLower || close[i - 1] < prevAdjLower
        ? basicLower : prevAdjLower;
    const newAdjUpper = isNaN(prevAdjUpper)
      ? basicUpper
      : basicUpper < prevAdjUpper || close[i - 1] > prevAdjUpper
        ? basicUpper : prevAdjUpper;

    if (isNaN(prevST)) {
      direction = 1;
    } else if (prevST === prevAdjUpper) {
      direction = close[i] > newAdjUpper ? 1 : -1;
    } else {
      direction = close[i] < newAdjLower ? -1 : 1;
    }

    const st = direction === -1 ? newAdjUpper : newAdjLower;
    result[i] = { value: st, bullish: direction === 1 };
    prevST = st; prevAdjUpper = newAdjUpper; prevAdjLower = newAdjLower;
  }

  return result;
}

export function zscore(values: number[]): number[] {
  const valid = values.filter((v) => !isNaN(v));
  if (valid.length === 0) return values.map(() => 0);
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  const std = Math.sqrt(variance);
  if (std === 0) return values.map(() => 0);
  return values.map((v) => (isNaN(v) ? NaN : (v - mean) / std));
}

export function buildSyntheticData(
  symbols: string[],
  numDays: number,
  seed = 42
): Map<string, OHLCV[]> {
  function seededRng(s: number) {
    let state = s;
    return () => {
      state = (state * 1664525 + 1013904223) & 0xffffffff;
      return (state >>> 0) / 0xffffffff;
    };
  }

  const rng = seededRng(seed);
  const result = new Map<string, OHLCV[]>();
  const today = new Date();

  for (const sym of symbols) {
    const bars: OHLCV[] = [];
    let price = 100 + rng() * 1900;
    let d = new Date(today);
    const dates: Date[] = [];
    let tries = 0;
    while (dates.length < numDays && tries < numDays * 3) {
      if (d.getDay() !== 0 && d.getDay() !== 6) dates.unshift(new Date(d));
      d.setDate(d.getDate() - 1);
      tries++;
    }
    for (const date of dates) {
      const change = (rng() - 0.48) * 0.04;
      price = Math.max(price * (1 + change), 1);
      const high = price * (1 + rng() * 0.01);
      const low = price * (1 - rng() * 0.01);
      const volume = Math.floor(10000 + rng() * 990000);
      bars.push({ date, open: price, high, low, close: price, volume });
    }
    result.set(sym, bars);
  }
  return result;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SymbolFactors {
  rocCurrent: number;
  roc2WAgo: number;
  macdCurrent: number;
  macd2WAgo: number;
  obvCurrent: number;
  obv2WAgo: number;
  rsiCurrent: number;
  rsi2WAgo: number;
  adxCurrent: number;
  adx2WAgo: number;
  supertrendBullish: boolean;
  supertrendValue: number;
  emaRank: number;
  cmfCurrent: number;
  highPct52w: number;
  lowPct52w: number;
  volRatio: number;
  atrPct: number;
  bbPctB: number;
  bbPctB2WAgo: number;
  dateCurrent: Date;
  date2WAgo: Date;
}

export function computeFactors(
  bars: OHLCV[],
  cfg: {
    rocPeriod: number;
    rsiPeriod: number;
    adxPeriod: number;
    macdFast: number;
    macdSlow: number;
    macdSignal: number;
    obvLookback: number;
    accelRocPeriod: number;
    accelDiffPeriod: number;
    twoWeekOffset: number;
    minHistoryDays: number;
    supertrendAtrPeriod: number;
    supertrendFactor: number;
  }
): SymbolFactors | null {
  const priorIdx = bars.length - 1 - cfg.twoWeekOffset;
  if (bars.length < cfg.minHistoryDays || priorIdx < 0 || priorIdx >= bars.length)
    return null;

  const close  = bars.map((b) => b.close);
  const high   = bars.map((b) => b.high);
  const low    = bars.map((b) => b.low);
  const volume = bars.map((b) => b.volume);

  const roc     = calcRoc(close, cfg.rocPeriod);
  const macdHist = calcMacdHist(close, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const obv     = calcObv(close, volume);
  const cmfArr  = calcCmf(high, low, close, volume, 20);

  const obvChange = obv.map((v, i) => {
    if (i < cfg.obvLookback) return NaN;
    const window = volume.slice(i - cfg.obvLookback, i + 1);
    const avgVol = window.reduce((s, x) => s + x, 0) / window.length;
    return avgVol === 0 ? NaN : (v - obv[i - cfg.obvLookback]) / avgVol;
  });

  const rsi = calcRsi(close, cfg.rsiPeriod);
  const adx = calcAdx(high, low, close, cfg.adxPeriod);
  const st  = calcSupertrend(high, low, close, cfg.supertrendAtrPeriod, cfg.supertrendFactor);

  const ema20Series  = ema(close, 20);
  const ema50Series  = ema(close, 50);
  const ema200Series = ema(close, 200);

  const last = bars.length - 1;

  const current = {
    roc:  roc[last],
    macd: macdHist[last],
    obv:  obvChange[last],
    rsi:  rsi[last],
    adx:  adx[last],
  };
  const prior = {
    roc:  roc[priorIdx],
    macd: macdHist[priorIdx],
    obv:  obvChange[priorIdx],
    rsi:  rsi[priorIdx],
    adx:  adx[priorIdx],
  };

  for (const v of Object.values(current)) {
    if (isNaN(v) || !isFinite(v)) return null;
  }
  for (const v of Object.values(prior)) {
    if (isNaN(v) || !isFinite(v)) return null;
  }

  const stBar = st[last];
  const e20   = ema20Series[last];
  const e50   = ema50Series[last];
  const e200  = ema200Series[last];
  const emaRankValue =
    isNaN(e20) || isNaN(e50) || isNaN(e200)
      ? 9
      : calcEmaRank(close[last], e20, e50, e200);

  // CMF (already computed; clamp to [-1, 1] for safety)
  const cmfRaw = cmfArr[last];
  const cmfCurrent = isNaN(cmfRaw) ? 0 : Math.max(-1, Math.min(1, cmfRaw));

  // Volume Ratio — current bar volume vs 20-bar average (excluding the current bar itself)
  const volLookback = Math.min(20, last);
  const volAvg = volLookback > 0
    ? volume.slice(last - volLookback, last).reduce((a, b) => a + b, 0) / volLookback
    : 0;
  const volRatio = volAvg > 0 ? Math.round((volume[last] / volAvg) * 100) / 100 : 1;

  // 52W High % — how far the current close is below the 52-week high (negative = below high)
  const window252 = high.slice(Math.max(0, high.length - 252));
  const high52w   = window252.length > 0 ? Math.max(...window252) : NaN;
  const highPct52w = isNaN(high52w) || high52w <= 0
    ? 0
    : Math.round(((close[last] - high52w) / high52w) * 1000) / 10;

  // 52W Low % — how far the current close is above the 52-week low (positive = above low)
  const low252 = low.slice(Math.max(0, low.length - 252));
  const low52w = low252.length > 0 ? Math.min(...low252) : NaN;
  const lowPct52w = isNaN(low52w) || low52w <= 0
    ? 0
    : Math.round(((close[last] - low52w) / low52w) * 1000) / 10;

  // ATR % — 14-period Wilder ATR normalised by current close (lower = less volatile)
  const atrPeriod = 14;
  let atrSmooth = 0, atrTrSum = 0, atrReady = false;
  for (let i = 1; i <= last; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    if (i <= atrPeriod) {
      atrTrSum += tr;
      if (i === atrPeriod) { atrSmooth = atrTrSum / atrPeriod; atrReady = true; }
    } else if (atrReady) {
      atrSmooth = (atrSmooth * (atrPeriod - 1) + tr) / atrPeriod;
    }
  }
  const atrPct = atrReady && close[last] > 0
    ? Math.round((atrSmooth / close[last]) * 10000) / 100
    : 0;

  // Bollinger Band %B — 20-period, 2σ (0 = lower band, 0.5 = midline, 1 = upper band)
  const bbPeriod = 20;
  const bbSlice = close.slice(Math.max(0, last + 1 - bbPeriod), last + 1);
  const bbN = bbSlice.length;
  const bbMean = bbSlice.reduce((a, b) => a + b, 0) / bbN;
  const bbVariance = bbSlice.reduce((a, c) => a + (c - bbMean) ** 2, 0) / bbN;
  const bbStd = Math.sqrt(bbVariance);
  const bbUpper = bbMean + 2 * bbStd;
  const bbLower = bbMean - 2 * bbStd;
  const bbPctB = bbStd > 0 ? (close[last] - bbLower) / (bbUpper - bbLower) : 0.5;

  // BB %B at 2W-ago snapshot (priorIdx) — used for Sub-Score B momentum-change signal
  const bb2WSlice = close.slice(Math.max(0, priorIdx + 1 - bbPeriod), priorIdx + 1);
  const bb2WN    = bb2WSlice.length;
  const bb2WMean = bb2WSlice.reduce((a, b) => a + b, 0) / bb2WN;
  const bb2WVar  = bb2WSlice.reduce((a, c) => a + (c - bb2WMean) ** 2, 0) / bb2WN;
  const bb2WStd  = Math.sqrt(bb2WVar);
  const bb2WUp   = bb2WMean + 2 * bb2WStd;
  const bb2WLo   = bb2WMean - 2 * bb2WStd;
  const bbPctB2WAgo = bb2WStd > 0 ? (close[priorIdx] - bb2WLo) / (bb2WUp - bb2WLo) : 0.5;

  return {
    rocCurrent:        current.roc,
    roc2WAgo:          prior.roc,
    macdCurrent:       current.macd,
    macd2WAgo:         prior.macd,
    obvCurrent:        current.obv,
    obv2WAgo:          prior.obv,
    rsiCurrent:        current.rsi,
    rsi2WAgo:          prior.rsi,
    adxCurrent:        current.adx,
    adx2WAgo:          prior.adx,
    supertrendBullish: stBar?.bullish ?? true,
    supertrendValue:   stBar?.value ?? 0,
    emaRank:           emaRankValue,
    cmfCurrent,
    highPct52w,
    lowPct52w,
    volRatio,
    atrPct,
    bbPctB,
    bbPctB2WAgo,
    dateCurrent:       bars[last].date,
    date2WAgo:         bars[priorIdx].date,
  };
}
