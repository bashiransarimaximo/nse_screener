import { Router } from "express";
import { anthropic } from "@nse/anthropic";

const router = Router();

router.post("/anthropic/analyze", async (req, res) => {
  const { type, stockSymbol, stockData, screenResults } = req.body as {
    type: "summary" | "stock";
    stockSymbol?: string;
    stockData?: Record<string, unknown>;
    screenResults?: Record<string, unknown>[];
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    let prompt: string;

    if (type === "summary" && screenResults) {
      const top10 = screenResults.slice(0, 10).map((r: Record<string, unknown>) =>
        `${r.symbol}: Score=${r.totalScore ?? "?"}, Conviction=${r.conviction ?? "?"}, Tech=${r.technicalGrade ?? "?"}, ST=${r.supertrendBullish ? "Bull" : "Bear"}, RSI=${r.rsiScore != null ? Number(r.rsiScore).toFixed(1) : "?"}, ADX=${r.adxScore != null ? Number(r.adxScore).toFixed(1) : "?"}, RS vs Nifty=${r.rsVsNifty != null ? Number(r.rsVsNifty).toFixed(1) : "?"}`
      ).join("\n");
      const bullCount = screenResults.filter((r: Record<string, unknown>) => r.supertrendBullish).length;
      const highConv = screenResults.filter((r: Record<string, unknown>) => r.conviction === "HIGH").length;

      prompt = `You are a concise equity market analyst covering NSE (Indian stock market) stocks.

Here is a summary of a momentum screen just completed:
- Total stocks screened: ${screenResults.length}
- Supertrend Bullish: ${bullCount} (${Math.round(bullCount / screenResults.length * 100)}%)
- HIGH conviction: ${highConv}

Top 10 ranked stocks:
${top10}

Write a 3–4 sentence plain-English paragraph for a retail investor summarising:
1. Overall market breadth from this data (bullish vs bearish)
2. What the top-ranked names have in common (themes, sectors if inferable from symbols)
3. One line of caution or context if warranted

Be direct and specific. Do not use bullet points. Do not repeat the raw numbers verbatim.`;

    } else if (type === "stock" && stockData) {
      const d = stockData as Record<string, unknown>;
      prompt = `You are a concise equity analyst covering NSE (Indian stock market) stocks.

Explain to a retail investor why ${stockSymbol ?? d.symbol} scored ${d.totalScore ?? "?"}/100 in a momentum screen. 

Here is the stock's data:
- Conviction: ${d.conviction ?? "?"}
- Technical Grade: ${d.technicalGrade ?? "?"}
- VQ Grade: ${d.vqGrade ?? "?"}
- Supertrend: ${d.supertrendBullish ? "Bullish" : "Bearish"}
- RSI Score: ${d.rsiScore != null ? Number(d.rsiScore).toFixed(1) : "?"}
- ADX Score: ${d.adxScore != null ? Number(d.adxScore).toFixed(1) : "?"}
- ROC 4W: ${d.roc4w != null ? Number(d.roc4w).toFixed(1) : "?"}%
- ROC 12W: ${d.roc12w != null ? Number(d.roc12w).toFixed(1) : "?"}%
- RS vs Nifty: ${d.rsVsNifty != null ? Number(d.rsVsNifty).toFixed(1) : "?"}
- Volume Ratio: ${d.volRatio != null ? Number(d.volRatio).toFixed(2) : "?"}x
- 52W High proximity: ${d.high52wScore != null ? Number(d.high52wScore).toFixed(1) : "?"}
- Score change (4W): ${d.scoreChange4w != null ? Number(d.scoreChange4w).toFixed(1) : "?"}
- Sub-score A (Momentum): ${d.subScoreA != null ? Number(d.subScoreA).toFixed(1) : "?"}
- Sub-score B (Trend): ${d.subScoreB != null ? Number(d.subScoreB).toFixed(1) : "?"}
- Sub-score C (Fundamentals): ${d.subScoreC != null ? Number(d.subScoreC).toFixed(1) : "?"}

Write 2–3 sentences explaining:
1. What the stock is doing well (or poorly) in momentum/trend terms
2. Any notable strengths or weaknesses in the data
3. One actionable observation for the investor

Be specific to the numbers. Do not use bullet points.`;

    } else {
      res.write(`data: ${JSON.stringify({ error: "Invalid request" })}\n\n`);
      res.end();
      return;
    }

    const stream = anthropic.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ content: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (err) {
    req.log.error({ err }, "Anthropic analyze error");
    res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
    res.end();
  }
});

export default router;
