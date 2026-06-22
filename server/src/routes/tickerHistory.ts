import { Router } from "express";
import { getTickerHistory, listSymbolsWithHistory, tickerHistoryToCsv } from "../tickerHistory";

const router = Router();

router.get("/ticker-history", (_req, res) => {
  const symbols = listSymbolsWithHistory();
  res.json({ symbols });
});

router.get("/ticker-history/:symbol", (req, res) => {
  const records = getTickerHistory(req.params.symbol);
  res.json(records.map(r => ({ date: r.date, ...r.data })));
});

router.get("/ticker-history/:symbol/download", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const records = getTickerHistory(symbol);
  if (records.length === 0) {
    res.status(404).json({ error: `No history found for ${symbol}` });
    return;
  }
  const csv = tickerHistoryToCsv(symbol, records);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${symbol}_history.csv"`);
  res.send(csv);
});

export default router;
