import { Router } from "express";
import cron from "node-cron";
import { Resend } from "resend";
import { logger } from "../lib/logger";
import {
  readEmailStore,
  upsertJob,
  deleteJob,
  readJob,
  type ScheduledJob,
} from "../emailConfig";
import { runScreenLogic, buildCfg } from "./screener";

const router = Router();

// ── Cron task registry ─────────────────────────────────────────────────────
const cronTasks = new Map<string, ReturnType<typeof cron.schedule>>();

function gstTimeToCron(timeGST: string, frequency: "daily" | "weekly", weekDay?: number): string {
  const parts = timeGST.split(":");
  let h = parseInt(parts[0] ?? "8", 10);
  const m = parseInt(parts[1] ?? "0", 10);
  h -= 4; // GST is UTC+4
  h = ((h % 24) + 24) % 24;
  const dow = frequency === "weekly" && weekDay != null ? String(weekDay) : "*";
  return `${m} ${h} * * ${dow}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function scheduleJob(job: ScheduledJob): void {
  const existing = cronTasks.get(job.id);
  if (existing) { existing.stop(); cronTasks.delete(job.id); }
  if (!job.enabled || job.emails.length === 0 || job.symbols.length === 0) return;

  const expr = gstTimeToCron(job.scheduleTime, job.frequency ?? "daily", job.weekDay);
  logger.info({ jobId: job.id, name: job.name, expr, scheduleGST: job.scheduleTime, frequency: job.frequency }, "email: scheduling job");

  const task = cron.schedule(expr, () => {
    const current = readJob(job.id);
    if (!current?.enabled) return;
    sendJobEmail(current).catch((err: unknown) => {
      logger.error({ jobId: job.id, err }, "email: scheduled send failed");
    });
  });
  cronTasks.set(job.id, task);
}

function unscheduleJob(id: string): void {
  const task = cronTasks.get(id);
  if (task) { task.stop(); cronTasks.delete(id); }
}

// Initialise cron tasks from persisted store on startup
function initAllCrons(): void {
  const store = readEmailStore();
  for (const job of store.jobs) scheduleJob(job);
  logger.info({ count: store.jobs.length }, "email: loaded scheduled jobs");
}

// ── CSV builder ────────────────────────────────────────────────────────────
type ScreenResult = Awaited<ReturnType<typeof runScreenLogic>>;

function buildCsv(data: ScreenResult): string {
  const headers = [
    "Rank", "Symbol", "Score", "Score 2W", "Score Δ",
    "ROC%", "ROC 2W%", "RSI", "RSI 2W", "ADX", "ADX 2W",
    "MACD", "MACD 2W", "OBV", "OBV 2W", "CMF",
    "52W Hi%", "52W Lo%", "RS/Nifty", "Vol Ratio", "ATR%", "BB%B", "Beta 1Y",
    "ST Bullish", "EMA Rank",
    "PE", "PEG", "ROE%", "Sales Gr%", "Sales CAGR 3Y%",
    "Sales Gr QtrYoY%", "Profit Gr QtrYoY%", "OPM%",
    "Stock CAGR 1Y%", "Stock CAGR 3Y%",
    "Date",
  ];

  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") ? `"${s}"` : s;
  };

  const rows = data.results.map((r, i) => [
    i + 1, r.symbol,
    r.compositeScoreCurrent?.toFixed(4), r.compositeScore2WAgo?.toFixed(4), r.compositeScoreChange?.toFixed(4),
    r.rocCurrent?.toFixed(2), r.roc2WAgo?.toFixed(2),
    r.rsiCurrent?.toFixed(1), r.rsi2WAgo?.toFixed(1),
    r.adxCurrent?.toFixed(1), r.adx2WAgo?.toFixed(1),
    r.macdCurrent?.toFixed(4), r.macd2WAgo?.toFixed(4),
    r.obvCurrent?.toFixed(0), r.obv2WAgo?.toFixed(0),
    r.cmfCurrent?.toFixed(4),
    r.highPct52w?.toFixed(2), r.lowPct52w?.toFixed(2),
    r.rsVsNifty?.toFixed(2), r.volRatio?.toFixed(2),
    r.atrPct?.toFixed(2), r.bbPctB?.toFixed(3), r.beta1Y?.toFixed(2),
    r.supertrendBullish ? "TRUE" : "FALSE", r.emaRank,
    r.pe?.toFixed(1), r.peg?.toFixed(2), r.roe?.toFixed(1),
    r.salesGrowthAnnual?.toFixed(1), r.salesCagr3Y?.toFixed(1),
    r.salesGrowthQtrYoY?.toFixed(1), r.profitGrowthQtrYoY?.toFixed(1), r.opm?.toFixed(1),
    r.stockCagr1Y?.toFixed(1), r.stockCagr3Y?.toFixed(1),
    r.dateCurrent,
  ].map(escape));

  return [headers, ...rows].map((row) => row.join(",")).join("\n");
}

// ── Email HTML builder (summary only — CSV attached) ───────────────────────
function buildEmailHtml(data: ScreenResult, job: ScheduledJob): string {
  const jobName = job.name;
  const dateStr = data.dateCurrent ?? new Date().toISOString().split("T")[0];
  const top10 = data.results.slice(0, 10);

  const rows = top10.map((r, i) => {
    const bg = i % 2 === 0 ? "#0d0d0d" : "#111111";
    const rsiC = (r.rsiCurrent ?? 0) > 60 ? "#4ade80" : (r.rsiCurrent ?? 0) < 40 ? "#f87171" : "#ccc";
    const macdC = (r.macdCurrent ?? 0) > 0 ? "#4ade80" : "#f87171";
    const rocC  = (r.rocCurrent  ?? 0) > 0 ? "#4ade80" : "#f87171";
    const rsC   = (r.rsVsNifty   ?? 0) > 0 ? "#4ade80" : "#f87171";
    const stC   = r.supertrendBullish ? "#4ade80" : "#f87171";
    return `<tr style="background:${bg}">
      <td style="padding:5px 8px;color:#666;text-align:center;font-size:11px">${i + 1}</td>
      <td style="padding:5px 8px;font-weight:bold;color:#00d4aa;font-size:12px">${r.symbol}</td>
      <td style="padding:5px 8px;text-align:right;color:#fff;font-size:12px">${r.compositeScoreCurrent.toFixed(3)}</td>
      <td style="padding:5px 8px;text-align:right;color:${rsiC};font-size:12px">${r.rsiCurrent?.toFixed(1) ?? "—"}</td>
      <td style="padding:5px 8px;text-align:right;color:${macdC};font-size:12px">${r.macdCurrent?.toFixed(2) ?? "—"}</td>
      <td style="padding:5px 8px;text-align:right;color:${rocC};font-size:12px">${r.rocCurrent?.toFixed(2) ?? "—"}%</td>
      <td style="padding:5px 8px;text-align:right;color:${rsC};font-size:12px">${r.rsVsNifty?.toFixed(2) ?? "—"}%</td>
      <td style="padding:5px 8px;text-align:right;color:${stC};font-weight:bold">${r.supertrendBullish ? "▲" : "▼"}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html><html lang="en">
<head><meta charset="utf-8"><title>NSE Momentum — ${dateStr}</title></head>
<body style="margin:0;padding:0;background:#080808;font-family:'Courier New',monospace">
<div style="max-width:700px;margin:0 auto;padding:24px 16px">
  <div style="border-left:3px solid #00d4aa;padding-left:16px;margin-bottom:20px">
    <h1 style="color:#00d4aa;margin:0 0 4px;font-size:15px;letter-spacing:3px">NSE MOMENTUM SCREENER</h1>
    <p style="color:#666;margin:0;font-size:11px">${jobName.toUpperCase()} &nbsp;·&nbsp; ${dateStr} &nbsp;·&nbsp; ${data.results.length} STOCKS SCORED</p>
  </div>
  <p style="color:#888;font-size:11px;margin-bottom:12px">Top 10 by momentum score — full results in the attached CSV.</p>
  ${job.bodyNote ? `<p style="color:#aaa;font-size:12px;margin-bottom:16px;padding:10px 12px;border-left:2px solid #00d4aa40;background:#00d4aa08">${job.bodyNote.replace(/\n/g, "<br>")}</p>` : ""}
  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr style="background:#00d4aa15;border-bottom:1px solid #00d4aa40">
        <th style="padding:7px 8px;text-align:center;color:#00d4aa;font-size:10px">#</th>
        <th style="padding:7px 8px;text-align:left;color:#00d4aa;font-size:10px">SYMBOL</th>
        <th style="padding:7px 8px;text-align:right;color:#00d4aa;font-size:10px">SCORE</th>
        <th style="padding:7px 8px;text-align:right;color:#00d4aa;font-size:10px">RSI</th>
        <th style="padding:7px 8px;text-align:right;color:#00d4aa;font-size:10px">MACD</th>
        <th style="padding:7px 8px;text-align:right;color:#00d4aa;font-size:10px">ROC%</th>
        <th style="padding:7px 8px;text-align:right;color:#00d4aa;font-size:10px">RS/NIFTY</th>
        <th style="padding:7px 8px;text-align:right;color:#00d4aa;font-size:10px">ST</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#333;font-size:10px;margin-top:20px;text-align:center">
    GENERATED ${new Date().toUTCString().toUpperCase()} · NSE MOMENTUM SCREENER
  </p>
</div>
</body></html>`;
}

// ── Core send logic ────────────────────────────────────────────────────────
async function sendJobEmail(job: ScheduledJob): Promise<void> {
  if (job.emails.length === 0) throw new Error("No recipient emails on job");
  if (job.symbols.length === 0) throw new Error("No symbols on job");

  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) throw new Error("RESEND_API_KEY not set");
  const resend = new Resend(apiKey);

  logger.info({ jobId: job.id, symbols: job.symbols.length }, "email: running screener for job");
  const data = await runScreenLogic(job.symbols, buildCfg(null));
  const dateStr = data.dateCurrent ?? new Date().toISOString().split("T")[0];
  const csv  = buildCsv(data);
  const html = buildEmailHtml(data, job);

  const from = process.env["RESEND_FROM_EMAIL"] ?? "onboarding@resend.dev";
  const subject = job.subject?.trim()
    ? job.subject.trim()
    : `${job.name} — ${dateStr} (${data.results.length} stocks)`;

  const { error } = await resend.emails.send({
    from: `NSE Momentum <${from}>`,
    to: job.emails,
    subject,
    html,
    attachments: [{
      filename: `nse-momentum-${job.name.toLowerCase().replace(/\s+/g, "-")}-${dateStr}.csv`,
      content: Buffer.from(csv),
    }],
  });

  if (error) throw new Error(String((error as { message?: string }).message ?? JSON.stringify(error)));
  logger.info({ jobId: job.id, recipients: job.emails.length, stocks: data.results.length }, "email: sent");
}

// ── Input parsers ──────────────────────────────────────────────────────────
function parseJob(body: unknown, idOverride?: string): ScheduledJob | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b["name"] !== "string" || !b["name"].trim()) return null;
  if (!Array.isArray(b["emails"])) return null;
  if (!Array.isArray(b["symbols"])) return null;
  if (typeof b["scheduleTime"] !== "string" || !/^\d{2}:\d{2}$/.test(b["scheduleTime"])) return null;

  return {
    id: idOverride ?? (typeof b["id"] === "string" && b["id"] ? b["id"] : `job-${Date.now().toString(36)}`),
    name: (b["name"] as string).trim(),
    emails: (b["emails"] as unknown[]).filter((e): e is string => typeof e === "string" && e.trim().length > 0),
    symbols: (b["symbols"] as unknown[]).filter((s): s is string => typeof s === "string"),
    basketLabel: typeof b["basketLabel"] === "string" ? b["basketLabel"] : "",
    scheduleTime: b["scheduleTime"] as string,
    frequency: b["frequency"] === "weekly" ? "weekly" : "daily",
    weekDay: b["frequency"] === "weekly" && typeof b["weekDay"] === "number" ? Math.max(0, Math.min(6, b["weekDay"] as number)) : undefined,
    enabled: b["enabled"] === true,
    subject: typeof b["subject"] === "string" && b["subject"].trim() ? b["subject"].trim() : undefined,
    bodyNote: typeof b["bodyNote"] === "string" && b["bodyNote"].trim() ? b["bodyNote"].trim() : undefined,
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────
router.get("/email/jobs", (_req, res) => {
  res.json(readEmailStore().jobs);
});

router.post("/email/jobs", (req, res) => {
  const job = parseJob(req.body);
  if (!job) { res.status(400).json({ error: "Invalid job body" }); return; }
  upsertJob(job);
  scheduleJob(job);
  res.status(201).json(job);
});

router.put("/email/jobs/:id", (req, res) => {
  const job = parseJob(req.body, req.params.id);
  if (!job) { res.status(400).json({ error: "Invalid job body" }); return; }
  upsertJob(job);
  scheduleJob(job);
  res.json(job);
});

router.delete("/email/jobs/:id", (req, res) => {
  unscheduleJob(req.params.id);
  deleteJob(req.params.id);
  res.json({ ok: true });
});

router.post("/email/jobs/:id/send", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  sendJobEmail(job)
    .then(() => res.json({ ok: true }))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job.id, err: msg }, "email: send now failed");
      res.status(500).json({ error: msg });
    });
});

initAllCrons();

export default router;
