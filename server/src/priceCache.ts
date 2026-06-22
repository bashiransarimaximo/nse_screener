import fs from "fs";
import path from "path";
import { logger } from "./lib/logger";

export interface OHLCV {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SerialBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const CACHE_DIR = path.join(process.cwd(), "data", "cache");

function ensureDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cachePath(ticker: string): string {
  const safe = ticker.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(CACHE_DIR, `${safe}.json`);
}

export function loadCache(ticker: string): OHLCV[] | null {
  const p = cachePath(ticker);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw) as SerialBar[];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((b) => ({ ...b, date: new Date(b.date) }));
  } catch (e) {
    logger.warn({ ticker, err: String(e) }, "priceCache: corrupt cache file, ignoring");
    return null;
  }
}

export function saveCache(ticker: string, bars: OHLCV[]): void {
  ensureDir();
  const arr: SerialBar[] = bars.map((b) => ({
    date: b.date.toISOString(),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  fs.writeFileSync(cachePath(ticker), JSON.stringify(arr));
}

export function deleteCache(ticker: string): void {
  const p = cachePath(ticker);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** Returns the file-system modification time (ms since epoch) of the cached file, or null if absent. */
export function getCacheFileModTime(ticker: string): number | null {
  const p = cachePath(ticker);
  if (!fs.existsSync(p)) return null;
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

export interface CacheStats {
  cachedSymbols: number;
  totalBars: number;
  oldestBar: string | null;
  newestBar: string | null;
  sizeKb: number;
}

export function getCacheStats(): CacheStats {
  if (!fs.existsSync(CACHE_DIR)) {
    return { cachedSymbols: 0, totalBars: 0, oldestBar: null, newestBar: null, sizeKb: 0 };
  }
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  let totalBars = 0;
  let oldestMs = Infinity;
  let newestMs = -Infinity;
  let sizeBytes = 0;
  for (const f of files) {
    const fp = path.join(CACHE_DIR, f);
    try {
      const raw = fs.readFileSync(fp, "utf8");
      sizeBytes += raw.length;
      const arr = JSON.parse(raw) as SerialBar[];
      if (arr.length > 0) {
        totalBars += arr.length;
        const first = new Date(arr[0].date).getTime();
        const last = new Date(arr[arr.length - 1].date).getTime();
        if (first < oldestMs) oldestMs = first;
        if (last > newestMs) newestMs = last;
      }
    } catch { /* skip */ }
  }
  return {
    cachedSymbols: files.length,
    totalBars,
    oldestBar: oldestMs === Infinity ? null : new Date(oldestMs).toISOString().slice(0, 10),
    newestBar: newestMs === -Infinity ? null : new Date(newestMs).toISOString().slice(0, 10),
    sizeKb: Math.round(sizeBytes / 1024),
  };
}
