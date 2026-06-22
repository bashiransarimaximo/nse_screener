import { Router } from "express";
import { loadCache, type OHLCV } from "../priceCache";
import { getTickerHistory } from "../tickerHistory";

const router = Router();

type Horizons = { d10: number | null; d20: number | null; d30: number | null; d60: number | null };

interface SignalEvent {
  date: string;
  entryClose: number;
  techScore: number | null;
  highPct52w: number | null;
  adxCurrent: number | null;
  returns: Horizons;
}

interface HorizonStats {
  avgReturn: number | null;
  medianReturn: number | null;
  winRate: number | null;
  count: number;
}

function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function horizonStats(returns: (number | null)[]): HorizonStats {
  const vals = returns.filter((v): v is number => v !== null);
  if (!vals.length) return { avgReturn: null, medianReturn: null, winRate: null, count: 0 };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const med = median(vals);
  const wins = vals.filter(v => v > 0).length;
  return {
    avgReturn: Math.round(avg * 100) / 100,
    medianReturn: med !== null ? Math.round(med * 100) / 100 : null,
    winRate: Math.round((wins / vals.length) * 1000) / 10,
    count: vals.length,
  };
}

function returnPct(entry: number, exit: number): number {
  return Math.round((exit - entry) / entry * 10000) / 100;
}

function closePriceNDaysAfter(bars: OHLCV[], startIdx: number, n: number): number | null {
  const target = startIdx + n;
  if (target >= bars.length) return null;
  return bars[target].close;
}

function dateStr(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/** GET /api/signal-analysis/:symbol
 *  Analyses historical ticker records to find conviction=HIGH entry signals
 *  and measures forward returns at +10/+20/+30/+60 trading days.
 */
router.get("/signal-analysis/:symbol", (req, res) => {
  const raw = req.params["symbol"]?.trim() ?? "";
  if (!raw) { res.status(400).json({ error: "symbol required" }); return; }

  const records = getTickerHistory(raw);
  if (!records.length) {
    res.status(404).json({ error: "No ticker history found — run a scan first" });
    return;
  }

  // Ticker history is newest-first; reverse for chronological order
  const chron = [...records].reverse();

  // Try to load price cache (NS suffix for non-index symbols)
  const cacheKey = raw.startsWith("^") ? raw : raw.includes(".") ? raw : `${raw}.NS`;
  const bars = loadCache(cacheKey);
  if (!bars || !bars.length) {
    res.status(404).json({ error: "No price cache found — run a full screen first" });
    return;
  }

  // Build date→index map for O(1) lookup
  const barByDate = new Map<string, number>();
  bars.forEach((b, i) => barByDate.set(dateStr(b.date), i));

  const signals: SignalEvent[] = [];
  let prevConviction: string | null = null;

  for (const rec of chron) {
    const conviction = String(rec.data["conviction"] ?? "");
    const isEntry = conviction === "HIGH" && prevConviction !== "HIGH";
    prevConviction = conviction || prevConviction;

    if (!isEntry) continue;

    const barIdx = barByDate.get(rec.date);
    if (barIdx == null) continue;

    const entryClose = bars[barIdx].close;
    if (!entryClose) continue;

    const r10 = closePriceNDaysAfter(bars, barIdx, 10);
    const r20 = closePriceNDaysAfter(bars, barIdx, 20);
    const r30 = closePriceNDaysAfter(bars, barIdx, 30);
    const r60 = closePriceNDaysAfter(bars, barIdx, 60);

    signals.push({
      date: rec.date,
      entryClose: Math.round(entryClose * 100) / 100,
      techScore: typeof rec.data["technicalScore"] === "number" ? (rec.data["technicalScore"] as number) : null,
      highPct52w: typeof rec.data["highPct52w"] === "number" ? (rec.data["highPct52w"] as number) : null,
      adxCurrent: typeof rec.data["adxCurrent"] === "number" ? (rec.data["adxCurrent"] as number) : null,
      returns: {
        d10: r10 !== null ? returnPct(entryClose, r10) : null,
        d20: r20 !== null ? returnPct(entryClose, r20) : null,
        d30: r30 !== null ? returnPct(entryClose, r30) : null,
        d60: r60 !== null ? returnPct(entryClose, r60) : null,
      },
    });
  }

  res.json({
    symbol: raw,
    totalSignals: signals.length,
    signals,
    stats: {
      d10: horizonStats(signals.map(s => s.returns.d10)),
      d20: horizonStats(signals.map(s => s.returns.d20)),
      d30: horizonStats(signals.map(s => s.returns.d30)),
      d60: horizonStats(signals.map(s => s.returns.d60)),
    },
  });
});

export default router;
