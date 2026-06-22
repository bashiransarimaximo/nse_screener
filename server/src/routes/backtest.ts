import { Router } from "express";
import { loadCache } from "../priceCache";

const router = Router();

router.get("/backtest", (req, res) => {
  const symbol   = String(req.query["symbol"] ?? "").trim();
  const fromDate = String(req.query["fromDate"] ?? "").trim() || undefined;
  const daysRaw  = Number(req.query["days"] ?? 90);
  const days     = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.floor(daysRaw), 365) : 90;
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    res.status(400).json({ error: "fromDate must be YYYY-MM-DD" });
    return;
  }
  const bars = loadCache(symbol);
  if (!bars || bars.length === 0) {
    res.status(404).json({ error: `No cached data for ${symbol}` });
    return;
  }

  let startIdx = 0;
  if (fromDate) {
    const fromMs = new Date(fromDate).getTime();
    const idx = bars.findIndex(b => new Date(b.date).getTime() >= fromMs);
    if (idx === -1) {
      res.status(404).json({ error: "fromDate is beyond the cached data range" });
      return;
    }
    startIdx = idx;
  } else {
    startIdx = Math.max(0, bars.length - days);
  }

  const slice = bars.slice(startIdx, startIdx + days);
  const basePrice = slice[0]?.close ?? 1;
  const result = slice.map(b => ({
    date: b.date instanceof Date ? b.date.toISOString().split("T")[0] : String(b.date),
    open:   b.open,
    high:   b.high,
    low:    b.low,
    close:  b.close,
    volume: b.volume,
    returnPct: basePrice > 0 ? Math.round((b.close - basePrice) / basePrice * 10000) / 100 : 0,
  }));

  res.json({ symbol, fromDate: result[0]?.date ?? fromDate, bars: result });
});

export default router;
