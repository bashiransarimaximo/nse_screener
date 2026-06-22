import fs from "fs";
import path from "path";

const HISTORY_DIR = path.join(process.cwd(), "data", "ticker-history");
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function safeName(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function symbolDir(symbol: string): string {
  return path.join(HISTORY_DIR, safeName(symbol));
}

function pruneOldFiles(dir: string): void {
  try {
    const cutoff = Date.now() - ONE_YEAR_MS;
    for (const file of fs.readdirSync(dir)) {
      const dateStr = file.replace(".json", "");
      const ts = new Date(dateStr).getTime();
      if (!isNaN(ts) && ts < cutoff) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  } catch { /* non-fatal */ }
}

export function saveTickerDay(symbol: string, date: string, data: object): void {
  const dir = symbolDir(symbol);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(data), "utf8");
  pruneOldFiles(dir);
}

export function saveAllTickers(results: object[], date: string): void {
  if (!results.length) return;
  for (const r of results) {
    const row = r as { symbol?: string };
    if (row.symbol) saveTickerDay(row.symbol, date, r);
  }
}

export interface TickerRecord {
  date: string;
  data: Record<string, unknown>;
}

export function getTickerHistory(symbol: string): TickerRecord[] {
  const dir = symbolDir(symbol);
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - ONE_YEAR_MS;
  try {
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse()
      .reduce<TickerRecord[]>((acc, file) => {
        const date = file.replace(".json", "");
        const ts = new Date(date).getTime();
        if (!isNaN(ts) && ts < cutoff) return acc;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
          acc.push({ date, data });
        } catch { /* skip corrupt file */ }
        return acc;
      }, []);
  } catch { return []; }
}

export function listSymbolsWithHistory(): string[] {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  try {
    return fs
      .readdirSync(HISTORY_DIR)
      .filter(name => fs.statSync(path.join(HISTORY_DIR, name)).isDirectory())
      .sort();
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
const CSV_COLUMNS = [
  "symbol", "date",
  "conviction", "technicalGrade", "technicalScore", "vqGrade", "vqScore",
  "compositeScoreCurrent", "compositeScore2WAgo", "compositeScoreChange",
  "rocCurrent", "rsiCurrent", "adxCurrent", "macdCurrent",
  "obvCurrent", "cmfCurrent", "volRatio", "atrPct", "bbPctB", "beta1Y",
  "supertrendBullish", "emaRank",
  "pe", "peg", "roe", "roa", "opm", "evToEbitda",
  "salesGrowthAnnual", "salesGrowthQtrYoY", "salesCagr3Y",
  "profitGrowthAnnual", "profitGrowthQtrYoY",
  "stockCagr1Y", "stockCagr3Y",
  "highPct52w", "lowPct52w", "rsVsNifty",
  "sector", "techFlags", "vqFlags",
  "bearishDivergence", "epsAcceleration",
  "dateCurrent",
] as const;

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n"))
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function tickerHistoryToCsv(symbol: string, records: TickerRecord[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = records.map(rec =>
    CSV_COLUMNS.map(col => {
      if (col === "date") return csvCell(rec.date);
      if (col === "symbol") return csvCell(symbol);
      return csvCell(rec.data[col]);
    }).join(",")
  );
  return [header, ...rows].join("\n");
}
