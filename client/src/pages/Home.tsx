import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useGetPresets, useGetRunHistory, useSaveRunSnapshot } from "@nse/api-client-react";
import type { ScreenerConfig, StockScore } from "@nse/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Play, RefreshCw, X, Menu, Search, SlidersHorizontal, Download, Trash2, FolderOpen, Plus, Pencil, ArrowRightFromLine, Columns3, Mail, Send, Clock, Sparkles, ChevronDown, ChevronUp, Star, BarChart2, Save, BookOpen, Copy } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Basket = { id: string; name: string; symbols: string[] };
type ScheduledJob = { id: string; name: string; emails: string[]; symbols: string[]; basketLabel: string; scheduleTime: string; frequency: "daily" | "weekly"; weekDay?: number; enabled: boolean; subject?: string; bodyNote?: string };
type JobForm = { id?: string; name: string; emailsStr: string; basketKey: string; scheduleTime: string; frequency: "daily" | "weekly"; weekDay: number; enabled: boolean; subject: string; bodyNote: string };
type RunSnapshot = { date: string; count: number; results: StockScore[] };
type FilterPreset = { name: string; minRsi: number; minAdx: number; scoreChangeFilter: "all"|"improving"|"declining"; convictionFilter: string; techGradeFilter: string; vqGradeFilter: string };
type BacktestBar = { date: string; open: number; high: number; low: number; close: number; volume: number; returnPct: number };
type RunDiff = { newHighMomentum: string[]; dropped: string[]; bigMovers: { symbol: string; delta: number }[] };

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_FULL   = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const SCORE_KEYS = ["conviction", "technicalGrade", "technicalScore", "vqGrade", "vqScore", "compositeScoreCurrent", "compositeScore2WAgo", "compositeScoreChange"] as const;
const TECH_KEYS  = [
  "rocCurrent", "roc2WAgo", "rocDiff",
  "obvCurrent", "obv2WAgo", "obvDiff",
  "rsiCurrent", "rsi2WAgo", "rsiDiff",
  "adxCurrent", "adx2WAgo", "adxDiff",
  "macdCurrent", "macd2WAgo", "supertrendBullish", "emaRank",
  "cmfCurrent", "highPct52w", "lowPct52w", "rsVsNifty", "volRatio",
  "atrPct", "bbPctB", "beta1Y",
] as const;
const FUND_KEYS  = [
  "pe", "peg", "roe", "evToEbitda", "salesGrowthAnnual", "salesCagr3Y", "salesGrowthQtrYoY",
  "profitGrowthAnnual", "profitGrowthQtrYoY", "opm", "stockCagr1Y", "stockCagr3Y",
] as const;

type ColKey = typeof SCORE_KEYS[number] | typeof TECH_KEYS[number] | typeof FUND_KEYS[number];

const COL_LABELS: Record<ColKey, string> = {
  conviction: "Conviction",
  technicalGrade: "Tech Grade",          technicalScore: "Tech Score",
  vqGrade: "VQ Grade",                  vqScore: "VQ Score",
  compositeScoreCurrent: "Score",        compositeScore2WAgo: "Score 2W",
  compositeScoreChange: "Score Δ",
  rocDiff: "ROC Δ",                      obvDiff: "OBV Δ",
  rsiDiff: "RSI Δ",                      adxDiff: "ADX Δ",
  rocCurrent: "ROC %",                  roc2WAgo: "ROC % 2W",
  obvCurrent: "OBV",                    obv2WAgo: "OBV 2W",
  rsiCurrent: "RSI",                    rsi2WAgo: "RSI 2W",
  adxCurrent: "ADX",                    adx2WAgo: "ADX 2W",
  macdCurrent: "MACD",                  macd2WAgo: "MACD 2W",
  supertrendBullish: "ST (10,3)",        emaRank: "EMA Rank",
  cmfCurrent: "CMF (20)",
  highPct52w: "52W High %",              lowPct52w: "52W Low %",
  rsVsNifty: "RS vs Nifty",             volRatio: "Vol Ratio",
  atrPct: "ATR %",                       bbPctB: "BB %B",
  beta1Y: "Beta 1Y",
  pe: "PE",                             peg: "PEG",
  roe: "ROE%",                          evToEbitda: "EV/EBITDA",
  salesGrowthAnnual: "Sales Gr%",       salesCagr3Y: "Sales 3Y CAGR",
  salesGrowthQtrYoY: "Sales (YoY)",     profitGrowthAnnual: "Profit Gr%",
  profitGrowthQtrYoY: "Profit (YoY)",   opm: "OPM%",
  stockCagr1Y: "Stock CAGR 1Y",         stockCagr3Y: "Stock CAGR 3Y",
};

const NSE_TICKER_RE = /^[A-Z0-9&.\-]{1,30}$/;

function tradingDaysAgo(dateStr: string): number {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  const now = new Date();
  let count = 0;
  const cur = new Date(d);
  cur.setDate(cur.getDate() + 1);
  while (cur <= now) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

export default function Home() {
  const { data: presetsData, isLoading: presetsLoading } = useGetPresets();
  const { data: serverRunHistory } = useGetRunHistory({ days: 90 });
  const saveRunSnapshotMutation = useSaveRunSnapshot();

  const [isScreening, setIsScreening] = useState(false);
  const [screenProgress, setScreenProgress] = useState<{ done: number; total: number; phase?: "prices" | "fundamentals" } | null>(null);
  const [symbols, setSymbols] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("nse_symbols") || "[]"); } catch { return []; }
  });
  const [newSymbol, setNewSymbol] = useState("");
  const [config, setConfig] = useState<ScreenerConfig>({
    lookbackDays: 90,
    minHistoryDays: 60,
    rocPeriod: 20,
    rsiPeriod: 14,
    adxPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    obvLookback: 20,
    accelRocPeriod: 10,
    accelDiffPeriod: 5,
    twoWeekOffset: 10,
    weightRoc: 0.35,
    weightMacd: 0.25,
    weightObv: 0.20,
    weightRsi: 0.20,
    useSyntheticData: false,
  });

  const [results, setResults] = useState<StockScore[]>(() => {
    try { return JSON.parse(localStorage.getItem("nse_last_results") || "[]"); } catch { return []; }
  });
  const [lastRunMeta, setLastRunMeta] = useState<{ date: string; count: number; duration: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem("nse_last_run_meta") || "null"); } catch { return null; }
  });

  // Baskets — persisted on server
  const [baskets, setBaskets] = useState<Basket[]>([]);
  const [basketsLoaded, setBasketsLoaded] = useState(false);
  const [basketEditorOpen, setBasketEditorOpen] = useState(false);
  const [editingBasket, setEditingBasket] = useState<Basket | null>(null);
  const [basketAddSymbol, setBasketAddSymbol] = useState("");
  const [newBasketName, setNewBasketName] = useState("");

  const [sortConfig, setSortConfig] = useState<{ key: keyof StockScore; direction: "asc" | "desc" }>(() => {
    try {
      const saved = localStorage.getItem("nse_sort_config");
      if (saved) return JSON.parse(saved) as { key: keyof StockScore; direction: "asc" | "desc" };
    } catch { /* ignore */ }
    return { key: "technicalScore", direction: "desc" };
  });
  useEffect(() => {
    localStorage.setItem("nse_sort_config", JSON.stringify(sortConfig));
  }, [sortConfig]);
  useEffect(() => {
    localStorage.setItem("nse_symbols", JSON.stringify(symbols));
  }, [symbols]);
  const [marketRegime, setMarketRegime] = useState<string | null>(null);

  // Pin/Star — persisted to localStorage
  const [starredSymbols, setStarredSymbols] = useState<Set<string>>(() => {
    try { return new Set<string>(JSON.parse(localStorage.getItem("nse_starred") || "[]")); } catch { return new Set(); }
  });
  const toggleStar = useCallback((sym: string) => {
    setStarredSymbols(prev => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym); else next.add(sym);
      return next;
    });
  }, []);

  // Score-change highlight — compare current run vs previous
  const prevResultsMap = useRef<Map<string, StockScore>>(new Map());

  // Historical run comparison
  const [runHistory, setRunHistory] = useState<RunSnapshot[]>(() => {
    try { return JSON.parse(localStorage.getItem("nse_run_history") || "[]"); } catch { return []; }
  });
  const [compareWithIdx, setCompareWithIdx] = useState<number | null>(null);

  // Sector heatmap
  const [sectorHeatmapOpen, setSectorHeatmapOpen] = useState(false);

  // Filter presets
  const [filterPresets, setFilterPresets] = useState<FilterPreset[]>(() => {
    try { return JSON.parse(localStorage.getItem("nse_filter_presets") || "[]"); } catch { return []; }
  });
  const [presetNameInput, setPresetNameInput] = useState("");
  const [presetSaveOpen, setPresetSaveOpen] = useState(false);

  // Stock detail drawer
  const [drawerStock, setDrawerStock] = useState<StockScore | null>(null);
  const [drawerBars, setDrawerBars] = useState<BacktestBar[]>([]);
  const [niftyBars, setNiftyBars] = useState<BacktestBar[]>([]);
  const [drawerBarsLoading, setDrawerBarsLoading] = useState(false);
  const [drawerTickerHistory, setDrawerTickerHistory] = useState<{ date: string; score: number; conviction: string | null }[]>([]);

  type SignalHorizon = { avgReturn: number | null; medianReturn: number | null; winRate: number | null; count: number };
  type SignalEvent = { date: string; entryClose: number; techScore: number | null; highPct52w: number | null; adxCurrent: number | null; returns: { d10: number | null; d20: number | null; d30: number | null; d60: number | null } };
  type SignalAnalysis = { symbol: string; totalSignals: number; signals: SignalEvent[]; stats: { d10: SignalHorizon; d20: SignalHorizon; d30: SignalHorizon; d60: SignalHorizon } };
  const [drawerSignalAnalysis, setDrawerSignalAnalysis] = useState<SignalAnalysis | null>(null);
  const [drawerSignalLoading, setDrawerSignalLoading] = useState(false);
  // Run diff — what changed since previous scan
  const [runDiff, setRunDiff] = useState<RunDiff | null>(null);
  const [runDiffOpen, setRunDiffOpen] = useState(true);

  // Keyboard navigation
  const [focusedRowIdx, setFocusedRowIdx] = useState<number | null>(null);
  // Per-symbol watchlist notes (persisted to localStorage)
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("nse_notes") || "{}"); } catch { return {}; }
  });
  const [notePopover, setNotePopover] = useState<string | null>(null);
  // Flag-specific filter for scan templates
  const [flagFilter, setFlagFilter] = useState<string | null>(null);
  // Secondary sort key (Shift+click column header to set)
  const [secondarySortConfig, setSecondarySortConfig] = useState<{ key: keyof StockScore; direction: "asc" | "desc" } | null>(null);
  // Shift-key state for secondary sort detection
  const shiftPressed = useRef(false);
  // Ref mirror of filteredResults — lets keyboard nav effect read latest value without TDZ
  const filteredResultsRef = useRef<StockScore[]>([]);

  // Persistence effects — placed AFTER all state declarations to avoid "used before declaration"
  useEffect(() => {
    localStorage.setItem("nse_starred", JSON.stringify([...starredSymbols]));
  }, [starredSymbols]);
  useEffect(() => {
    localStorage.setItem("nse_filter_presets", JSON.stringify(filterPresets));
  }, [filterPresets]);
  useEffect(() => {
    localStorage.setItem("nse_run_history", JSON.stringify(runHistory.slice(0, 10)));
  }, [runHistory]);
  // Merge server-persisted run history on load (server wins for same date; local fills gaps)
  useEffect(() => {
    if (!serverRunHistory || serverRunHistory.length === 0) return;
    setRunHistory(prev => {
      const serverSnaps: RunSnapshot[] = serverRunHistory.map(row => ({
        date: row.runDate,
        count: row.symbolCount,
        results: row.results as StockScore[],
      }));
      const serverDates = new Set(serverSnaps.map(s => s.date));
      const localOnly = prev.filter(s => !serverDates.has(s.date));
      return [...serverSnaps, ...localOnly].sort((a, b) => b.date.localeCompare(a.date));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRunHistory]);
  // Fetch 90-day price history + Nifty overlay + file-based score history when drawer stock changes
  useEffect(() => {
    if (!drawerStock) { setDrawerBars([]); setNiftyBars([]); setDrawerTickerHistory([]); setDrawerSignalAnalysis(null); return; }
    setDrawerBarsLoading(true);
    setDrawerSignalLoading(true);
    Promise.all([
      fetch(`/api/backtest?symbol=${encodeURIComponent(drawerStock.symbol)}&days=90`).then(r => r.ok ? r.json() : {}),
      fetch(`/api/backtest?symbol=%5ENSEI&days=90`).then(r => r.ok ? r.json() : {}),
      fetch(`/api/ticker-history/${encodeURIComponent(drawerStock.symbol)}`).then(r => r.ok ? r.json() : []),
      fetch(`/api/signal-analysis/${encodeURIComponent(drawerStock.symbol)}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([d, n, th, sa]) => {
        setDrawerBars((d as { bars?: BacktestBar[] }).bars ?? []);
        setNiftyBars((n as { bars?: BacktestBar[] }).bars ?? []);
        const history = (th as Array<{ date: string; compositeScoreCurrent?: number; conviction?: string }>)
          .filter(x => x.compositeScoreCurrent != null)
          .map(x => ({ date: x.date, score: x.compositeScoreCurrent!, conviction: x.conviction ?? null }))
          .sort((a, b) => a.date.localeCompare(b.date));
        setDrawerTickerHistory(history);
        setDrawerSignalAnalysis(sa as SignalAnalysis | null);
      })
      .catch(() => { setDrawerBars([]); setNiftyBars([]); setDrawerTickerHistory([]); setDrawerSignalAnalysis(null); })
      .finally(() => { setDrawerBarsLoading(false); setDrawerSignalLoading(false); });
  }, [drawerStock?.symbol]);
  // Persist watchlist notes
  useEffect(() => { localStorage.setItem("nse_notes", JSON.stringify(notes)); }, [notes]);
  // Track Shift key for secondary sort
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => { if (e.key === "Shift") shiftPressed.current = true; };
    const onUp   = (e: KeyboardEvent) => { if (e.key === "Shift") shiftPressed.current = false; };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup",   onUp);
    return () => { window.removeEventListener("keydown", onDown); window.removeEventListener("keyup", onUp); };
  }, []);
  // Keyboard navigation: J/K move row, S star, D open drawer, Esc close
  // Uses filteredResultsRef (not filteredResults) to avoid TDZ — ref is updated right after filteredResults is computed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const rows = filteredResultsRef.current;
      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        setFocusedRowIdx(prev => (prev == null ? 0 : Math.min(rows.length - 1, prev + 1)));
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setFocusedRowIdx(prev => (prev == null ? 0 : Math.max(0, prev - 1)));
      } else if ((e.key === "s" || e.key === "S") && focusedRowIdx != null) {
        const sym = rows[focusedRowIdx]?.symbol;
        if (sym) toggleStar(sym);
      } else if ((e.key === "d" || e.key === "D") && focusedRowIdx != null) {
        const r = rows[focusedRowIdx];
        if (r) setDrawerStock(r);
      } else if (e.key === "Escape") {
        setDrawerStock(null);
        setNotePopover(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedRowIdx, toggleStar]);

  // Filtering
  const [minRsi, setMinRsi] = useState<number>(0);
  const [minAdx, setMinAdx] = useState<number>(0);
  const [scoreChangeFilter, setScoreChangeFilter] = useState<"all" | "improving" | "declining">("all");
  const [convictionFilter, setConvictionFilter] = useState<string>("all");
  const [techGradeFilter, setTechGradeFilter]   = useState<string>("all");
  const [vqGradeFilter, setVqGradeFilter]       = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Sync filter state to URL so views can be bookmarked / shared
  useEffect(() => {
    const params = new URLSearchParams();
    if (convictionFilter !== "all")          params.set("cv", convictionFilter);
    if (techGradeFilter  !== "all")          params.set("tg", techGradeFilter);
    if (vqGradeFilter    !== "all")          params.set("vq", vqGradeFilter);
    if (searchQuery)                         params.set("q",  searchQuery);
    if (sortConfig.key !== "compositeScoreCurrent") params.set("sk", String(sortConfig.key));
    if (sortConfig.direction !== "desc")     params.set("sd", sortConfig.direction);
    const str = params.toString();
    window.history.replaceState(null, "", str ? `${window.location.pathname}?${str}` : window.location.pathname);
  }, [convictionFilter, techGradeFilter, vqGradeFilter, searchQuery, sortConfig]);
  // Restore filter state from URL on first load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("cv")) setConvictionFilter(params.get("cv")!);
    if (params.has("tg")) setTechGradeFilter(params.get("tg")!);
    if (params.has("vq")) setVqGradeFilter(params.get("vq")!);
    if (params.has("q"))  setSearchQuery(params.get("q")!);
    if (params.has("sk") && params.has("sd")) {
      setSortConfig({ key: params.get("sk") as keyof StockScore, direction: params.get("sd") as "asc" | "desc" });
    } else if (params.has("sk")) {
      setSortConfig(prev => ({ ...prev, key: params.get("sk") as keyof StockScore }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasActiveFilters = minRsi > 0 || minAdx > 0 || scoreChangeFilter !== "all" ||
    convictionFilter !== "all" || techGradeFilter !== "all" || vqGradeFilter !== "all" || searchQuery !== "";

  const resetFilters = useCallback(() => {
    setMinRsi(0); setMinAdx(0); setScoreChangeFilter("all");
    setConvictionFilter("all"); setTechGradeFilter("all"); setVqGradeFilter("all");
    setSearchQuery(""); setFlagFilter(null);
  }, []);

  // AI analysis state
  const [aiSummaryText, setAiSummaryText] = useState<string>("");
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryOpen, setAiSummaryOpen] = useState(false);
  const [aiStockSymbol, setAiStockSymbol] = useState<string | null>(null);
  const [aiStockText, setAiStockText] = useState<string>("");
  const [aiStockLoading, setAiStockLoading] = useState(false);
  const [aiStockOpen, setAiStockOpen] = useState(false);

  const streamAiAnalysis = useCallback(async (
    body: Record<string, unknown>,
    onChunk: (t: string) => void,
    onDone: () => void,
    onError: (e: string) => void
  ) => {
    const resp = await fetch("/api/anthropic/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) { onError("Request failed"); return; }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          if (parsed.content) onChunk(parsed.content);
          if (parsed.done) onDone();
          if (parsed.error) onError(parsed.error);
        } catch { /* skip malformed */ }
      }
    }
  }, []);

  const handleAiSummary = useCallback(async () => {
    if (results.length === 0) return;
    setAiSummaryText("");
    setAiSummaryLoading(true);
    setAiSummaryOpen(true);
    try {
      await streamAiAnalysis(
        { type: "summary", screenResults: results },
        (t) => setAiSummaryText(prev => prev + t),
        () => setAiSummaryLoading(false),
        (e) => { setAiSummaryText(`Error: ${e}`); setAiSummaryLoading(false); }
      );
    } catch (e) {
      setAiSummaryText(`Error: ${String(e)}`);
      setAiSummaryLoading(false);
    }
  }, [results, streamAiAnalysis]);

  const handleAiStock = useCallback(async (stock: StockScore) => {
    setAiStockSymbol(stock.symbol);
    setAiStockText("");
    setAiStockLoading(true);
    setAiStockOpen(true);
    try {
      await streamAiAnalysis(
        { type: "stock", stockSymbol: stock.symbol, stockData: stock as unknown as Record<string, unknown> },
        (t) => setAiStockText(prev => prev + t),
        () => setAiStockLoading(false),
        (e) => { setAiStockText(`Error: ${e}`); setAiStockLoading(false); }
      );
    } catch (e) {
      setAiStockText(`Error: ${String(e)}`);
      setAiStockLoading(false);
    }
  }, [streamAiAnalysis]);
  const [hiddenCols, setHiddenCols] = useState<Set<ColKey>>(new Set(["compositeScoreCurrent", "compositeScore2WAgo", "compositeScoreChange"] as ColKey[]));
  const prefsLoadedRef = useRef(false);
  const configSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [emailOpen, setEmailOpen]   = useState(false);
  const [emailView, setEmailView]   = useState<"list" | "editor">("list");
  const [emailJobs, setEmailJobs]   = useState<ScheduledJob[]>([]);
  const [editingJob, setEditingJob] = useState<JobForm | null>(null);
  const [emailSendingId, setEmailSendingId] = useState<string | null>(null);
  const [emailJobSaving, setEmailJobSaving] = useState(false);

  const refreshJobs = () =>
    fetch("/api/email/jobs").then(r => r.json()).then((j: ScheduledJob[]) => setEmailJobs(j)).catch(() => {});

  useEffect(() => { refreshJobs(); }, []);

  // Load preferences (config + hiddenCols) from server
  useEffect(() => {
    fetch("/api/preferences")
      .then(r => r.json())
      .then((prefs: { config?: Partial<ScreenerConfig>; hiddenCols?: string[] }) => {
        if (prefs.config && typeof prefs.config === "object") {
          setConfig(prev => ({ ...prev, ...prefs.config as Partial<ScreenerConfig> }));
        }
        if (Array.isArray(prefs.hiddenCols)) {
          setHiddenCols(new Set(prefs.hiddenCols as ColKey[]));
        }
      })
      .catch(() => {})
      .finally(() => { prefsLoadedRef.current = true; });
  }, []);

  // Debounce-save config to server whenever it changes (after first load)
  useEffect(() => {
    if (!prefsLoadedRef.current) return;
    if (configSaveTimerRef.current) clearTimeout(configSaveTimerRef.current);
    configSaveTimerRef.current = setTimeout(() => {
      fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      }).catch(() => {});
    }, 800);
  }, [config]);

  // Load baskets from server; migrate from localStorage on first visit
  useEffect(() => {
    fetch("/api/baskets")
      .then(r => r.json())
      .then((serverBaskets: Basket[]) => {
        if (serverBaskets.length === 0) {
          try {
            const local: Basket[] = JSON.parse(localStorage.getItem("nse_baskets") || "[]");
            if (local.length > 0) {
              Promise.all(
                local.map(b => fetch("/api/baskets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }))
              ).then(() => {
                setBaskets(local);
                setBasketsLoaded(true);
                localStorage.removeItem("nse_baskets");
                toast.success(`Migrated ${local.length} basket(s) to server`);
              }).catch(() => { setBaskets(local); setBasketsLoaded(true); });
              return;
            }
          } catch { /* no local baskets */ }
        }
        setBaskets(serverBaskets);
        setBasketsLoaded(true);
      })
      .catch(() => {
        try { setBaskets(JSON.parse(localStorage.getItem("nse_baskets") || "[]")); } catch { /* ignore */ }
        setBasketsLoaded(true);
      });
  }, []);

  const resolveBasket = (key: string): { symbols: string[]; label: string } => {
    if (key === "__current__") return { symbols, label: `Current (${symbols.length} symbols)` };
    if (key.startsWith("preset:")) {
      const name = key.slice(7);
      const p = presetsData?.presets.find(p => p.name === name);
      return { symbols: p?.symbols ?? [], label: name };
    }
    if (key.startsWith("basket:")) {
      const id = key.slice(7);
      const b = baskets.find(b => b.id === id);
      return { symbols: b?.symbols ?? [], label: b?.name ?? "Custom Basket" };
    }
    return { symbols: [], label: "" };
  };

  const openNewJob = () => {
    setEditingJob({ name: "", emailsStr: "", basketKey: "__current__", scheduleTime: "08:00", frequency: "daily", weekDay: 1, enabled: true, subject: "", bodyNote: "" });
    setEmailView("editor");
  };
  const openEditJob = (job: ScheduledJob) => {
    let basketKey = "__current__";
    if (presetsData?.presets.find(p => p.name === job.basketLabel)) basketKey = `preset:${job.basketLabel}`;
    else if (baskets.find(b => b.name === job.basketLabel)) basketKey = `basket:${baskets.find(b => b.name === job.basketLabel)!.id}`;
    setEditingJob({ id: job.id, name: job.name, emailsStr: job.emails.join(", "), basketKey, scheduleTime: job.scheduleTime, frequency: job.frequency ?? "daily", weekDay: job.weekDay ?? 1, enabled: job.enabled, subject: job.subject ?? "", bodyNote: job.bodyNote ?? "" });
    setEmailView("editor");
  };

  const saveJob = async () => {
    if (!editingJob) return;
    setEmailJobSaving(true);
    try {
      const { symbols: resolvedSymbols, label: basketLabel } = resolveBasket(editingJob.basketKey);
      const emails = editingJob.emailsStr.split(",").map(e => e.trim()).filter(Boolean);
      const body = { id: editingJob.id, name: editingJob.name, emails, symbols: resolvedSymbols, basketLabel, scheduleTime: editingJob.scheduleTime, frequency: editingJob.frequency, weekDay: editingJob.frequency === "weekly" ? editingJob.weekDay : undefined, enabled: editingJob.enabled, subject: editingJob.subject || undefined, bodyNote: editingJob.bodyNote || undefined };
      const method = editingJob.id ? "PUT" : "POST";
      const url = editingJob.id ? `/api/email/jobs/${editingJob.id}` : "/api/email/jobs";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Save failed");
      toast.success(editingJob.id ? "Job updated" : "Job created");
      await refreshJobs();
      setEmailView("list");
      setEditingJob(null);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Save failed"); }
    finally { setEmailJobSaving(false); }
  };

  const deleteEmailJob = async (id: string) => {
    if (!confirm("Delete this email job?")) return;
    await fetch(`/api/email/jobs/${id}`, { method: "DELETE" });
    await refreshJobs();
    toast.success("Job deleted");
  };

  const runJobNow = async (id: string) => {
    setEmailSendingId(id);
    try {
      const res = await fetch(`/api/email/jobs/${id}/send`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Send failed");
      toast.success("Report sent!");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Send failed"); }
    finally { setEmailSendingId(null); }
  };

  const toggleCol = (key: ColKey) => {
    setHiddenCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      if (prefsLoadedRef.current) {
        fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hiddenCols: [...next] }),
        }).catch(() => {});
      }
      return next;
    });
  };
  const vis = useCallback((key: ColKey) => !hiddenCols.has(key), [hiddenCols]);

  const handleRunScreen = async (currentSymbols: string[], currentConfig: ScreenerConfig) => {
    if (currentSymbols.length === 0) {
      toast.error("Add symbols to run the screener");
      return;
    }
    setIsScreening(true);
    setScreenProgress(null);
    try {
      // POST /screen/start returns a jobId immediately (no long connection).
      // We then poll /screen/jobs/:jobId every 500ms until done.
      const startResp = await fetch("/api/screen/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: currentSymbols, config: currentConfig }),
      });
      if (!startResp.ok) throw new Error(`HTTP ${startResp.status}`);
      const { jobId } = await startResp.json() as { jobId: string };

      while (true) {
        await new Promise(r => setTimeout(r, 500));
        const pollResp = await fetch(`/api/screen/jobs/${jobId}`);
        if (!pollResp.ok) throw new Error(`Poll HTTP ${pollResp.status}`);
        const job = await pollResp.json() as {
          status: "pending" | "done" | "error";
          progress: { done: number; total: number; phase?: "prices" | "fundamentals" };
          result?: { results: StockScore[]; dateCurrent: string; scoredCount: number; durationMs: number; marketRegime?: string };
          error?: string;
        };
        setScreenProgress(job.progress);
        if (job.status === "done") {
          if (job.result) {
            const newResults = job.result.results;
            const newMeta = { date: job.result.dateCurrent, count: job.result.scoredCount, duration: job.result.durationMs };
            // Capture current results for score-change highlight before overwriting
            prevResultsMap.current = new Map(results.map(r => [r.symbol, r]));
            setResults(newResults);
            setLastRunMeta(newMeta);
            if (job.result.marketRegime) setMarketRegime(job.result.marketRegime);
            // Save run to history and persist to server
            setRunHistory(prev => {
              const snapshot: RunSnapshot = { date: newMeta.date, count: newMeta.count, results: newResults };
              const filtered = prev.filter(s => s.date !== newMeta.date);
              return [snapshot, ...filtered].sort((a, b) => b.date.localeCompare(a.date));
            });
            saveRunSnapshotMutation.mutate({ data: { runDate: newMeta.date, results: newResults } });
            // Reset compare-with index when new results arrive (it may be stale)
            setCompareWithIdx(null);
            // Compute run diff vs the most recent previous run
            setRunHistory(prev => {
              // prev here is pre-update so prev[0] is the last completed run
              const prevRun = prev[0];
              if (prevRun) {
                const prevMap = new Map(prevRun.results.map(r => [r.symbol, r]));
                const newHighMomentum = newResults.filter(r =>
                  (r.conviction === "HIGH" || r.conviction === "MOMENTUM") &&
                  prevMap.get(r.symbol)?.conviction !== "HIGH" &&
                  prevMap.get(r.symbol)?.conviction !== "MOMENTUM"
                ).map(r => r.symbol);
                const dropped = prevRun.results.filter(r =>
                  (r.conviction === "HIGH" || r.conviction === "MOMENTUM") &&
                  (() => { const cur = newResults.find(n => n.symbol === r.symbol); return !cur || (cur.conviction !== "HIGH" && cur.conviction !== "MOMENTUM"); })()
                ).map(r => r.symbol);
                const bigMovers = newResults
                  .filter(r => Math.abs(r.compositeScoreChange) >= 10)
                  .map(r => ({ symbol: r.symbol, delta: r.compositeScoreChange }))
                  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
                if (newHighMomentum.length > 0 || dropped.length > 0 || bigMovers.length > 0) {
                  setRunDiff({ newHighMomentum, dropped, bigMovers });
                  setRunDiffOpen(true);
                } else {
                  setRunDiff(null);
                }
              }
              return prev; // actual update happens below
            });
            try {
              localStorage.setItem("nse_last_results", JSON.stringify(newResults));
              localStorage.setItem("nse_last_run_meta", JSON.stringify(newMeta));
            } catch { /* storage full — ignore */ }
            toast.success(`Screened ${job.result.scoredCount} symbols successfully`);
          }
          break;
        }
        if (job.status === "error") throw new Error(job.error ?? "Unknown error");
      }
    } catch (err) {
      toast.error("Failed to run screen", { description: String(err) });
    } finally {
      setIsScreening(false);
      setScreenProgress(null);
    }
  };

  const handleAddSymbol = (e: React.FormEvent) => {
    e.preventDefault();
    const sym = newSymbol.trim().toUpperCase();
    if (!sym) return;
    if (!NSE_TICKER_RE.test(sym)) {
      toast.error(`"${sym}" doesn't look like a valid NSE ticker (A-Z, 0-9, &, -, . only)`);
      return;
    }
    if (symbols.includes(sym)) {
      toast.warning(`${sym} is already in the list`);
      setNewSymbol("");
      return;
    }
    setSymbols([...symbols, sym]);
    setNewSymbol("");
  };

  const handleRemoveSymbol = (sym: string) => {
    setSymbols(symbols.filter(s => s !== sym));
  };

  const loadPreset = (presetSymbols: string[]) => {
    setSymbols(presetSymbols);
  };

  const createBasket = async () => {
    const name = newBasketName.trim();
    if (!name) { toast.error("Enter a basket name"); return; }
    if (baskets.some(b => b.name === name)) { toast.error("A basket with that name already exists"); return; }
    const newB: Basket = { id: `basket-${Date.now().toString(36)}`, name, symbols: [] };
    try {
      const res = await fetch("/api/baskets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newB) });
      const saved = await res.json() as Basket;
      setBaskets(prev => [...prev, saved]);
      setNewBasketName("");
      setEditingBasket(saved);
      setBasketEditorOpen(true);
    } catch { toast.error("Failed to create basket"); }
  };

  const openBasketEditor = (basket: Basket) => {
    setEditingBasket({ ...basket, symbols: [...basket.symbols] });
    setBasketEditorOpen(true);
  };

  const saveEditingBasket = (updated: Basket) => {
    setBaskets(prev => prev.map(b => b.id === updated.id ? updated : b));
    setEditingBasket(updated);
    fetch(`/api/baskets/${updated.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    }).catch(() => toast.error("Failed to save basket"));
  };

  const addSymbolToBasket = (sym: string) => {
    if (!editingBasket) return;
    const s = sym.trim().toUpperCase();
    if (!s || editingBasket.symbols.includes(s)) return;
    const updated = { ...editingBasket, symbols: [...editingBasket.symbols, s] };
    saveEditingBasket(updated);
    setBasketAddSymbol("");
  };

  const removeSymbolFromBasket = (sym: string) => {
    if (!editingBasket) return;
    const updated = { ...editingBasket, symbols: editingBasket.symbols.filter(s => s !== sym) };
    saveEditingBasket(updated);
  };

  const renameEditingBasket = (name: string) => {
    if (!editingBasket) return;
    setEditingBasket({ ...editingBasket, name });
  };

  const commitRename = () => {
    if (!editingBasket) return;
    const name = editingBasket.name.trim();
    if (!name) return;
    const conflict = baskets.find(b => b.name === name && b.id !== editingBasket.id);
    if (conflict) { toast.error("Name already used"); return; }
    saveEditingBasket({ ...editingBasket, name });
  };

  const deleteBasket = (id: string) => {
    const b = baskets.find(x => x.id === id);
    setBaskets(prev => prev.filter(x => x.id !== id));
    fetch(`/api/baskets/${id}`, { method: "DELETE" })
      .catch(() => { setBaskets(prev => b ? [...prev, b] : prev); toast.error("Failed to delete basket"); });
    if (b) toast.success(`"${b.name}" deleted`);
  };

  const loadBasketToScreener = (basket: Basket) => {
    if (basket.symbols.length === 0) { toast.error("Basket is empty"); return; }
    setSymbols([...basket.symbols]);
    toast.success(`Loaded "${basket.name}" — ${basket.symbols.length} symbols`);
  };

  const updateConfig = (key: keyof ScreenerConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSort = (key: keyof StockScore) => {
    if (shiftPressed.current) {
      setSecondarySortConfig(prev =>
        prev?.key === key
          ? { key, direction: prev.direction === "desc" ? "asc" : "desc" }
          : { key, direction: "desc" }
      );
    } else {
      setSortConfig(prev => ({
        key,
        direction: prev.key === key && prev.direction === "desc" ? "asc" : "desc"
      }));
    }
  };

  // Filter and sort results — memoised so it only recomputes when inputs change
  const filteredResults = useMemo(() => results.filter(r => {
    if (r.rsiCurrent < minRsi) return false;
    if (r.adxCurrent < minAdx) return false;
    if (scoreChangeFilter === "improving" && r.compositeScoreChange <= 0) return false;
    if (scoreChangeFilter === "declining" && r.compositeScoreChange >= 0) return false;
    if (convictionFilter !== "all" && r.conviction !== convictionFilter) return false;
    if (techGradeFilter !== "all") {
      if (techGradeFilter === "AB") { if (r.technicalGrade !== "A" && r.technicalGrade !== "B") return false; }
      else if (r.technicalGrade !== techGradeFilter) return false;
    }
    if (vqGradeFilter !== "all") {
      if (vqGradeFilter === "AB") { if (r.vqGrade !== "A" && r.vqGrade !== "B") return false; }
      else if (r.vqGrade !== vqGradeFilter) return false;
    }
    if (searchQuery && !r.symbol.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (flagFilter && !(r.techFlags?.split(",").includes(flagFilter))) return false;
    return true;
  }).sort((a, b) => {
    // Starred symbols float to top regardless of sort key
    const aStarred = starredSymbols.has(a.symbol) ? 0 : 1;
    const bStarred = starredSymbols.has(b.symbol) ? 0 : 1;
    if (aStarred !== bStarred) return aStarred - bStarred;
    const aRaw = a[sortConfig.key];
    const bRaw = b[sortConfig.key];
    // Push nulls to the end regardless of sort direction
    if (aRaw == null && bRaw == null) return 0;
    if (aRaw == null) return 1;
    if (bRaw == null) return -1;
    if (aRaw < bRaw) return sortConfig.direction === "asc" ? -1 : 1;
    if (aRaw > bRaw) return sortConfig.direction === "asc" ? 1 : -1;
    if (secondarySortConfig) {
      const a2 = a[secondarySortConfig.key], b2 = b[secondarySortConfig.key];
      if (a2 == null && b2 == null) return 0;
      if (a2 == null) return 1;
      if (b2 == null) return -1;
      if (a2 < b2) return secondarySortConfig.direction === "asc" ? -1 : 1;
      if (a2 > b2) return secondarySortConfig.direction === "asc" ? 1 : -1;
    }
    return 0;
  }), [results, minRsi, minAdx, scoreChangeFilter, convictionFilter, techGradeFilter, vqGradeFilter, searchQuery, flagFilter, sortConfig, secondarySortConfig, starredSymbols]);
  // Keep ref in sync so keyboard nav always sees the latest list (avoids TDZ)
  filteredResultsRef.current = filteredResults;

  const convictionCounts = useMemo(() => {
    const c = { HIGH: 0, MOMENTUM: 0, VALUE_WATCH: 0, AVOID: 0, other: 0 };
    for (const r of filteredResults) {
      if      (r.conviction === "HIGH")        c.HIGH++;
      else if (r.conviction === "MOMENTUM")    c.MOMENTUM++;
      else if (r.conviction === "VALUE_WATCH") c.VALUE_WATCH++;
      else if (r.conviction === "AVOID")       c.AVOID++;
      else                                     c.other++;
    }
    return c;
  }, [filteredResults]);

  const getQuartileClass = (index: number, total: number) => {
    if (total === 0) return "";
    const percentile = index / total;
    if (percentile <= 0.25) return "text-green-500 font-medium";
    return "";
  };

  // Compare-with map — when user picks a historical run to compare against
  const compareMap = useMemo<Map<string, StockScore>>(() => {
    if (compareWithIdx == null || !runHistory[compareWithIdx]) return new Map();
    return new Map(runHistory[compareWithIdx].results.map(r => [r.symbol, r]));
  }, [compareWithIdx, runHistory]);

  // Entry/exit diff vs historical run (symbols that entered/exited the filtered list)
  const entryExitDiff = useMemo(() => {
    if (compareWithIdx == null || !runHistory[compareWithIdx]) return null;
    const histSyms = new Set(runHistory[compareWithIdx].results.map(r => r.symbol));
    const currSyms = new Set(filteredResults.map(r => r.symbol));
    return {
      entries: filteredResults.filter(r => !histSyms.has(r.symbol)).map(r => r.symbol),
      exits: runHistory[compareWithIdx].results.filter(r => !currSyms.has(r.symbol)).map(r => r.symbol),
    };
  }, [compareWithIdx, runHistory, filteredResults]);

  // Momentum streak: consecutive runs each symbol has been in HIGH or MOMENTUM conviction
  const streakMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of results) {
      let streak = 0;
      for (let i = runHistory.length - 1; i >= 0; i--) {
        const snap = runHistory[i].results.find(s => s.symbol === r.symbol);
        if (snap && (snap.conviction === "HIGH" || snap.conviction === "MOMENTUM")) streak++;
        else break;
      }
      if (streak >= 2) map.set(r.symbol, streak);
    }
    return map;
  }, [results, runHistory]);

  // Weekly snapshots at ~5, 10, 15 trading days ago — used for conviction & tech grade trails
  const weeklySnapshotMap = useMemo(() => {
    type Snap = { conviction: string | null; techGrade: string | null };
    const map = new Map<string, [Snap, Snap, Snap]>(); // [w1, w2, w3]
    if (runHistory.length === 0) return map;
    const today = new Date();
    function tradingDaysBetween(from: Date, to: Date) {
      let n = 0; const cur = new Date(from);
      while (cur <= to) { const d = cur.getDay(); if (d !== 0 && d !== 6) n++; cur.setDate(cur.getDate() + 1); }
      return n;
    }
    function runClosestTo(target: number) {
      let best: (typeof runHistory)[0] | null = null, bestDiff = Infinity;
      for (const run of runHistory) {
        const diff = Math.abs(tradingDaysBetween(new Date(run.date), today) - target);
        if (diff < bestDiff) { bestDiff = diff; best = run; }
      }
      // Only use this run if it falls within ±3 trading days of the target week.
      // If no run qualifies, return null so the chip shows as "no data".
      return bestDiff <= 3 ? best : null;
    }
    const [r1, r2, r3] = [runClosestTo(5), runClosestTo(10), runClosestTo(15)];
    const allSymbols = new Set(runHistory.flatMap(r => r.results.map(s => s.symbol)));
    const snap = (run: (typeof runHistory)[0] | null, sym: string): Snap => {
      const s = run?.results.find(r => r.symbol === sym);
      return { conviction: s?.conviction ?? null, techGrade: s?.technicalGrade ?? null };
    };
    for (const sym of allSymbols) {
      map.set(sym, [snap(r1, sym), snap(r2, sym), snap(r3, sym)]);
    }
    return map;
  }, [runHistory]);
  // Convenience alias for conviction trail (backwards-compat with existing JSX)
  const convictionWeeklyMap = useMemo(() =>
    new Map([...weeklySnapshotMap.entries()].map(([sym, [w1, w2, w3]]) =>
      [sym, [w1.conviction, w2.conviction, w3.conviction] as [string | null, string | null, string | null]]
    )), [weeklySnapshotMap]);

  // Fading Leaders: HIGH conviction for 3+ consecutive historical runs but now declining
  const fadingLeaders = useMemo(() => {
    const s = new Set<string>();
    for (const r of results) {
      if ((r.compositeScoreChange ?? 0) >= -5) continue;
      let highStreak = 0;
      for (let i = runHistory.length - 1; i >= 0; i--) {
        const snap = runHistory[i].results.find(h => h.symbol === r.symbol);
        if (snap?.conviction === "HIGH") highStreak++;
        else break;
      }
      if (highStreak >= 3) s.add(r.symbol);
    }
    return s;
  }, [results, runHistory]);

  // Per-symbol rank within sector (by tech score descending)
  const sectorRankMap = useMemo(() => {
    const bySector = new Map<string, { sym: string; score: number }[]>();
    results.forEach(r => {
      const sec = (r as StockScore & { sector?: string | null }).sector;
      if (!sec || sec === "—") return;
      const arr = bySector.get(sec) ?? [];
      arr.push({ sym: r.symbol, score: r.technicalScore ?? 0 });
      bySector.set(sec, arr);
    });
    const map = new Map<string, { rank: number; total: number }>();
    bySector.forEach(arr => {
      const sorted = [...arr].sort((a, b) => b.score - a.score);
      sorted.forEach(({ sym }, idx) => map.set(sym, { rank: idx + 1, total: sorted.length }));
    });
    return map;
  }, [results]);

  // Sector heatmap stats — grouped by sector from full results
  const sectorStats = useMemo(() => {
    const map = new Map<string, { count: number; techSum: number; vqSum: number; vqCount: number }>();
    results.forEach(r => {
      const sector = (r as StockScore & { sector?: string | null }).sector ?? "—";
      if (!sector || sector === "—") return;
      const s = map.get(sector) ?? { count: 0, techSum: 0, vqSum: 0, vqCount: 0 };
      s.count++;
      s.techSum += r.technicalScore ?? 0;
      if (r.vqScore != null) { s.vqSum += r.vqScore; s.vqCount++; }
      map.set(sector, s);
    });
    return [...map.entries()]
      .map(([sector, s]) => ({
        sector,
        count: s.count,
        avgTech: s.count > 0 ? Math.round(s.techSum / s.count * 10) / 10 : 0,
        avgVq: s.vqCount > 0 ? Math.round(s.vqSum / s.vqCount * 10) / 10 : null,
      }))
      .sort((a, b) => b.avgTech - a.avgTech);
  }, [results]);

  // Previous run sector averages — for sector rotation delta in heatmap
  const prevSectorAvg = useMemo(() => {
    const prev = runHistory.at(-1);
    if (!prev) return new Map<string, number>();
    const map = new Map<string, { c: number; s: number }>();
    prev.results.forEach(r => {
      const sec = (r as StockScore & { sector?: string | null }).sector ?? "—";
      if (!sec || sec === "—") return;
      const e = map.get(sec) ?? { c: 0, s: 0 };
      e.c++; e.s += (r.technicalScore ?? 0);
      map.set(sec, e);
    });
    const out = new Map<string, number>();
    map.forEach((v, k) => out.set(k, v.c > 0 ? Math.round(v.s / v.c * 10) / 10 : 0));
    return out;
  }, [runHistory]);


  const copyTVWatchlist = useCallback(() => {
    const list = filteredResults.map(r => {
      const sym = r.symbol.endsWith(".NS") ? r.symbol.slice(0, -3) : r.symbol;
      return `NSE:${sym}`;
    }).join(",");
    navigator.clipboard.writeText(list).then(
      () => toast.success(`Copied ${filteredResults.length} symbols to TradingView watchlist`),
      () => toast.error("Clipboard access denied")
    );
  }, [filteredResults]);

  const downloadExcel = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = "NSE Momentum Screener";
    wb.created = new Date();

    const ws = wb.addWorksheet("Momentum Screen", {
      views: [{ state: "frozen", ySplit: 1, xSplit: 1 }],
    });

    ws.columns = [
      { header: "Symbol",              key: "symbol",               width: 14 },
      { header: "Conviction",          key: "conviction",           width: 14 },
      { header: "Tech Grade",          key: "technicalGrade",       width: 11 },
      { header: "Tech Score",          key: "technicalScore",       width: 11 },
      { header: "Tech Flags",          key: "techFlags",            width: 18 },
      { header: "VQ Grade",            key: "vqGrade",              width: 10 },
      { header: "VQ Score",            key: "vqScore",              width: 10 },
      { header: "VQ Flags",            key: "vqFlags",              width: 16 },
      { header: "Score",               key: "compositeScoreCurrent",width: 10 },
      { header: "Score 2W",            key: "compositeScore2WAgo",  width: 10 },
      { header: "Score Δ",             key: "compositeScoreChange", width: 10 },
      { header: "ROC %",               key: "rocCurrent",           width: 10 },
      { header: "ROC % 2W",            key: "roc2WAgo",             width: 10 },
      { header: "ROC Δ",               key: "rocDiff",              width: 10 },
      { header: "OBV",                 key: "obvCurrent",           width: 12 },
      { header: "OBV 2W",              key: "obv2WAgo",             width: 12 },
      { header: "OBV Δ",               key: "obvDiff",              width: 12 },
      { header: "RSI",                 key: "rsiCurrent",           width: 8  },
      { header: "RSI 2W",              key: "rsi2WAgo",             width: 8  },
      { header: "RSI Δ",               key: "rsiDiff",              width: 8  },
      { header: "ADX",                 key: "adxCurrent",           width: 8  },
      { header: "ADX 2W",              key: "adx2WAgo",             width: 8  },
      { header: "ADX Δ",               key: "adxDiff",              width: 8  },
      { header: "MACD",                key: "macdCurrent",          width: 10 },
      { header: "MACD 2W",             key: "macd2WAgo",            width: 10 },
      { header: "Supertrend",          key: "supertrendBullish",    width: 12 },
      { header: "EMA Rank",            key: "emaRank",              width: 10 },
      { header: "CMF (20)",            key: "cmfCurrent",           width: 10 },
      { header: "52W High %",          key: "highPct52w",           width: 11 },
      { header: "52W Low %",           key: "lowPct52w",            width: 11 },
      { header: "RS vs Nifty",         key: "rsVsNifty",            width: 12 },
      { header: "Vol Ratio",           key: "volRatio",             width: 10 },
      { header: "ATR %",               key: "atrPct",               width: 9  },
      { header: "BB %B",               key: "bbPctB",               width: 9  },
      { header: "Beta 1Y",             key: "beta1Y",               width: 9  },
      { header: "PE",                  key: "pe",                   width: 9  },
      { header: "PEG",                 key: "peg",                  width: 9  },
      { header: "ROE %",               key: "roe",                  width: 9  },
      { header: "EV/EBITDA",           key: "evToEbitda",           width: 11 },
      { header: "Sales Growth Ann %",  key: "salesGrowthAnnual",    width: 17 },
      { header: "Sales CAGR 3Y %",     key: "salesCagr3Y",          width: 14 },
      { header: "Sales Growth QtrYoY %",key:"salesGrowthQtrYoY",   width: 20 },
      { header: "Profit Growth Ann %", key: "profitGrowthAnnual",   width: 18 },
      { header: "Profit Growth QtrYoY %",key:"profitGrowthQtrYoY", width: 21 },
      { header: "OPM %",               key: "opm",                  width: 9  },
      { header: "ROA %",               key: "roa",                  width: 9  },
      { header: "Sector",              key: "sector",               width: 20 },
      { header: "Stock CAGR 1Y %",     key: "stockCagr1Y",          width: 15 },
      { header: "Stock CAGR 3Y %",     key: "stockCagr3Y",          width: 15 },
      { header: "Date Current",        key: "dateCurrent",          width: 13 },
      { header: "Date 2W Ago",         key: "date2WAgo",            width: 13 },
      { header: "Notes",               key: "notes",                width: 30 },
    ];

    // Style header row
    const hdrRow = ws.getRow(1);
    hdrRow.eachCell(cell => {
      cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
      cell.font   = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
      cell.border = {
        bottom: { style: "medium", color: { argb: "FF334155" } },
      };
    });
    hdrRow.height = 20;

    // Helper — solid fill + font colour
    const fill = (argbBg: string, argbFg = "FFFFFFFF") =>
      ({ fill: { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: argbBg } },
         font: { color: { argb: argbFg }, size: 10 } });

    // Score → green-to-red gradient (10-pt buckets)
    const scoreFill = (v: number | null | undefined) => {
      if (v == null) return {};
      if (v >= 75) return fill("FF166534", "FF86EFAC");  // dark green
      if (v >= 65) return fill("FF14532D", "FF6EE7B7");
      if (v >= 55) return fill("FF365314", "FFD9F99D");  // lime
      if (v >= 45) return fill("FF713F12", "FFFDE68A");  // amber
      if (v >= 35) return fill("FF7C2D12", "FFFCA5A1");  // orange-red
      return fill("FF450A0A", "FFFCA5A1");                // deep red
    };

    // Delta → green / red
    const deltaFill = (v: number | null | undefined | boolean) => {
      if (typeof v === "boolean") return {};

      if (v == null) return {};
      return v > 0 ? fill("FF052E16", "FF86EFAC") : v < 0 ? fill("FF450A0A", "FFFCA5A1") : {};
    };

    filteredResults.forEach(r => {
      const row = ws.addRow({
        symbol:               r.symbol,
        conviction:           r.conviction ?? "",
        technicalGrade:       r.technicalGrade ?? "",
        technicalScore:       r.technicalScore ?? null,
        techFlags:            r.techFlags ?? "",
        vqGrade:              r.vqGrade ?? "",
        vqScore:              r.vqScore ?? null,
        vqFlags:              r.vqFlags ?? "",
        compositeScoreCurrent:r.compositeScoreCurrent,
        compositeScore2WAgo:  r.compositeScore2WAgo,
        compositeScoreChange: r.compositeScoreChange,
        rocCurrent:           r.rocCurrent,
        roc2WAgo:             r.roc2WAgo,
        rocDiff:              r.rocDiff ?? null,
        obvCurrent:           r.obvCurrent,
        obv2WAgo:             r.obv2WAgo,
        obvDiff:              r.obvDiff ?? null,
        rsiCurrent:           r.rsiCurrent,
        rsi2WAgo:             r.rsi2WAgo,
        rsiDiff:              r.rsiDiff ?? null,
        adxCurrent:           r.adxCurrent,
        adx2WAgo:             r.adx2WAgo,
        adxDiff:              r.adxDiff ?? null,
        macdCurrent:          r.macdCurrent,
        macd2WAgo:            r.macd2WAgo,
        supertrendBullish:    r.supertrendBullish ? "BULL" : "BEAR",
        emaRank:              r.emaRank ?? null,
        cmfCurrent:           r.cmfCurrent ?? null,
        highPct52w:           r.highPct52w ?? null,
        lowPct52w:            r.lowPct52w ?? null,
        rsVsNifty:            r.rsVsNifty ?? null,
        volRatio:             r.volRatio ?? null,
        atrPct:               r.atrPct ?? null,
        bbPctB:               r.bbPctB ?? null,
        beta1Y:               r.beta1Y ?? null,
        pe:                   r.pe ?? null,
        peg:                  r.peg ?? null,
        roe:                  r.roe ?? null,
        evToEbitda:           r.evToEbitda ?? null,
        salesGrowthAnnual:    r.salesGrowthAnnual ?? null,
        salesCagr3Y:          r.salesCagr3Y ?? null,
        salesGrowthQtrYoY:    r.salesGrowthQtrYoY ?? null,
        profitGrowthAnnual:   r.profitGrowthAnnual ?? null,
        profitGrowthQtrYoY:   r.profitGrowthQtrYoY ?? null,
        opm:                  r.opm ?? null,
        roa:                  r.roa ?? null,
        sector:               r.sector ?? "",
        stockCagr1Y:          r.stockCagr1Y ?? null,
        stockCagr3Y:          r.stockCagr3Y ?? null,
        dateCurrent:          r.dateCurrent,
        date2WAgo:            r.date2WAgo,
        notes:                notes[r.symbol] ?? "",
      });

      row.font = { size: 10 };
      row.alignment = { vertical: "middle" };

      // Conviction
      const cv = row.getCell("conviction");
      if      (r.conviction === "HIGH")        Object.assign(cv, fill("FF052E16", "FF4ADE80"));
      else if (r.conviction === "MOMENTUM")    Object.assign(cv, fill("FF042F2E", "FF2DD4BF"));
      else if (r.conviction === "VALUE_WATCH") Object.assign(cv, fill("FF172554", "FF60A5FA"));
      else if (r.conviction === "AVOID")       Object.assign(cv, fill("FF450A0A", "FFF87171"));
      cv.alignment = { horizontal: "center", vertical: "middle" };

      // Tech Grade
      const tg = row.getCell("technicalGrade");
      if      (r.technicalGrade === "A") Object.assign(tg, fill("FF22C55E"));
      else if (r.technicalGrade === "B") Object.assign(tg, fill("FF34D399"));
      else if (r.technicalGrade === "C") Object.assign(tg, fill("FFEAB308", "FF000000"));
      else if (r.technicalGrade === "D") Object.assign(tg, fill("FFF97316"));
      else if (r.technicalGrade === "F") Object.assign(tg, fill("FFDC2626"));
      tg.alignment = { horizontal: "center", vertical: "middle" };

      // Tech Score gradient
      const ts = row.getCell("technicalScore");
      Object.assign(ts, scoreFill(r.technicalScore));
      ts.numFmt = "0.0";
      ts.alignment = { horizontal: "center", vertical: "middle" };

      // Tech Flags — amber tint when any warning flag present
      const tf = row.getCell("techFlags");
      if (r.techFlags && r.techFlags.length > 0) {
        const hasDanger = r.techFlags.includes("ST_BEARISH") || r.techFlags.includes("BEARISH_DIV") || r.techFlags.includes("BELOW_EMA200");
        const hasPositive = r.techFlags.includes("NEAR_BREAKOUT") && !hasDanger;
        if (hasDanger)    Object.assign(tf, fill("FF450A0A", "FFFCA5A1"));
        else if (hasPositive) Object.assign(tf, fill("FF052E16", "FF86EFAC"));
        else              Object.assign(tf, fill("FF451A03", "FFFDE68A"));
      }

      // VQ Grade
      const vg = row.getCell("vqGrade");
      if      (r.vqGrade === "A") Object.assign(vg, fill("FF22C55E"));
      else if (r.vqGrade === "B") Object.assign(vg, fill("FF34D399"));
      else if (r.vqGrade === "C") Object.assign(vg, fill("FFEAB308", "FF000000"));
      else if (r.vqGrade === "D") Object.assign(vg, fill("FFF97316"));
      else if (r.vqGrade === "F") Object.assign(vg, fill("FFDC2626"));
      vg.alignment = { horizontal: "center", vertical: "middle" };

      // VQ Score gradient
      const vs = row.getCell("vqScore");
      Object.assign(vs, scoreFill(r.vqScore));
      vs.numFmt = "0.0";
      vs.alignment = { horizontal: "center", vertical: "middle" };

      // Supertrend
      const st = row.getCell("supertrendBullish");
      if (r.supertrendBullish) Object.assign(st, fill("FF14532D", "FF86EFAC"));
      else                     Object.assign(st, fill("FF450A0A", "FFFCA5A1"));
      st.alignment = { horizontal: "center", vertical: "middle" };

      // Score deltas (green positive, red negative)
      Object.assign(row.getCell("compositeScoreChange"), deltaFill(r.compositeScoreChange));
      Object.assign(row.getCell("rocDiff"),              deltaFill(r.rocDiff));
      Object.assign(row.getCell("rsiDiff"),              deltaFill(r.rsiDiff));
      Object.assign(row.getCell("adxDiff"),              deltaFill(r.adxDiff));
      Object.assign(row.getCell("obvDiff"),              deltaFill(r.obvDiff));

      // RSI overbought/oversold highlight
      const rsiCell = row.getCell("rsiCurrent");
      if ((r.rsiCurrent ?? 0) > 80)      Object.assign(rsiCell, fill("FF7C2D12", "FFFDE68A"));
      else if ((r.rsiCurrent ?? 0) < 30) Object.assign(rsiCell, fill("FF172554", "FF93C5FD"));

      // CMF colour (positive=bullish, negative=bearish)
      const cmf = row.getCell("cmfCurrent");
      if ((r.cmfCurrent ?? 0) > 0.1)       Object.assign(cmf, fill("FF14532D", "FF86EFAC"));
      else if ((r.cmfCurrent ?? 0) < -0.1) Object.assign(cmf, fill("FF450A0A", "FFFCA5A1"));

      // RS vs Nifty (positive = outperforming)
      Object.assign(row.getCell("rsVsNifty"), deltaFill(r.rsVsNifty));

      // Profit/Sales growth — positive green, negative red
      (["salesGrowthAnnual","salesCagr3Y","salesGrowthQtrYoY",
        "profitGrowthAnnual","profitGrowthQtrYoY","stockCagr1Y","stockCagr3Y"] as const)
        .forEach(k => Object.assign(row.getCell(k), deltaFill((r as unknown as Record<string, unknown>)[k] as number | null)));

      // Number formats
      [
        ["rocCurrent","0.00\"%\""],["roc2WAgo","0.00\"%\""],["rocDiff","0.00\"%\""],
        ["rsiCurrent","0.0"],["rsi2WAgo","0.0"],["rsiDiff","0.0"],
        ["adxCurrent","0.0"],["adx2WAgo","0.0"],["adxDiff","0.0"],
        ["cmfCurrent","0.000"],["highPct52w","0.00\"%\""],["lowPct52w","0.00\"%\""],
        ["rsVsNifty","0.00"],["volRatio","0.00"],["atrPct","0.00\"%\""],
        ["bbPctB","0.000"],["beta1Y","0.00"],
        ["pe","0.0"],["peg","0.00"],["roe","0.0\"%\""],["evToEbitda","0.0"],
        ["salesGrowthAnnual","0.0\"%\""],["salesCagr3Y","0.0\"%\""],["salesGrowthQtrYoY","0.0\"%\""],
        ["profitGrowthAnnual","0.0\"%\""],["profitGrowthQtrYoY","0.0\"%\""],
        ["opm","0.0\"%\""],["roa","0.0\"%\""],
        ["stockCagr1Y","0.0\"%\""],["stockCagr3Y","0.0\"%\""],
      ].forEach(([k, fmt]) => { row.getCell(k).numFmt = fmt; });
    });

    // Auto-filter on header
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nse_momentum_${lastRunMeta?.date ?? "results"}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [basketDownloading, setBasketDownloading] = useState<string | null>(null);

  const downloadBasketCsv = async (basket: Basket) => {
    setBasketDownloading(basket.id);
    try {
      const allRecords = (
        await Promise.all(
          basket.symbols.map(sym =>
            fetch(`/api/ticker-history/${encodeURIComponent(sym)}`)
              .then(r => r.ok ? r.json() : [])
              .then((rows: Array<Record<string, unknown>>) =>
                rows.map(row => ({ symbol: sym, ...row }))
              )
          )
        )
      ).flat();
      if (allRecords.length === 0) {
        toast.error("No ticker history for this basket — run a scan first.");
        return;
      }
      const keys = Object.keys(allRecords[0]);
      const ordered = ["symbol", "date", ...keys.filter(k => k !== "symbol" && k !== "date")];
      const q = (v: unknown) => {
        if (v == null) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [ordered.join(","), ...allRecords.map(row => ordered.map(k => q((row as Record<string, unknown>)[k])).join(","))].join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${basket.name}_ticker_history.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Downloaded ${allRecords.length} records for ${basket.symbols.length} symbols`);
    } catch {
      toast.error("Failed to download basket history");
    } finally {
      setBasketDownloading(null);
    }
  };

  const downloadCsv = () => {
    const q = (v: string | null | undefined) => {
      if (v == null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const n = (v: number | null | undefined) => (v == null ? "" : String(v));

    const headers = [
      "Symbol","Conviction","Tech Grade","Tech Score","Tech Flags",
      "VQ Grade","VQ Score","VQ Flags",
      "Score","Score 2W","Score Δ",
      "ROC %","ROC % 2W","ROC Δ",
      "OBV","OBV 2W","OBV Δ",
      "RSI","RSI 2W","RSI Δ",
      "ADX","ADX 2W","ADX Δ",
      "MACD","MACD 2W",
      "Supertrend","EMA Rank","CMF (20)",
      "52W High %","52W Low %","RS vs Nifty",
      "Vol Ratio","ATR %","BB %B","Beta 1Y",
      "PE","PEG","ROE %","EV/EBITDA",
      "Sales Growth Ann %","Sales CAGR 3Y %","Sales Growth QtrYoY %",
      "Profit Growth Ann %","Profit Growth QtrYoY %",
      "OPM %","ROA %","Sector",
      "Stock CAGR 1Y %","Stock CAGR 3Y %",
      "Date Current","Date 2W Ago","Notes",
    ];

    const rows = filteredResults.map(r => [
      q(r.symbol),
      q(r.conviction),
      q(r.technicalGrade),
      n(r.technicalScore),
      q(r.techFlags),
      q(r.vqGrade),
      n(r.vqScore),
      q(r.vqFlags),
      n(r.compositeScoreCurrent),
      n(r.compositeScore2WAgo),
      n(r.compositeScoreChange),
      n(r.rocCurrent),
      n(r.roc2WAgo),
      n(r.rocDiff),
      n(r.obvCurrent),
      n(r.obv2WAgo),
      n(r.obvDiff),
      n(r.rsiCurrent),
      n(r.rsi2WAgo),
      n(r.rsiDiff),
      n(r.adxCurrent),
      n(r.adx2WAgo),
      n(r.adxDiff),
      n(r.macdCurrent),
      n(r.macd2WAgo),
      r.supertrendBullish ? "BULL" : "BEAR",
      n(r.emaRank),
      n(r.cmfCurrent),
      n(r.highPct52w),
      n(r.lowPct52w),
      n(r.rsVsNifty),
      n(r.volRatio),
      n(r.atrPct),
      n(r.bbPctB),
      n(r.beta1Y),
      n(r.pe),
      n(r.peg),
      n(r.roe),
      n(r.evToEbitda),
      n(r.salesGrowthAnnual),
      n(r.salesCagr3Y),
      n(r.salesGrowthQtrYoY),
      n(r.profitGrowthAnnual),
      n(r.profitGrowthQtrYoY),
      n(r.opm),
      n(r.roa),
      q(r.sector),
      n(r.stockCagr1Y),
      n(r.stockCagr3Y),
      q(r.dateCurrent),
      q(r.date2WAgo),
      q(notes[r.symbol]),
    ].join(","));

    const csv = [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nse_momentum_${lastRunMeta?.date ?? "results"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderConfigInput = (label: string, key: keyof ScreenerConfig, step: number = 1) => (
    <div className="flex items-center justify-between">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input 
        type="number" 
        className="w-20 h-7 text-xs bg-muted/50 border-muted"
        value={config[key] as number}
        onChange={(e) => updateConfig(key, parseFloat(e.target.value))}
        step={step}
      />
    </div>
  );

  const scoreSpan = useMemo(() => (SCORE_KEYS as readonly ColKey[]).filter(vis).length, [vis]);
  const techSpan  = useMemo(() => (TECH_KEYS  as readonly ColKey[]).filter(vis).length, [vis]);
  const fundSpan  = useMemo(() => (FUND_KEYS  as readonly ColKey[]).filter(vis).length, [vis]);

  // Market breadth — always from full results, not filtered
  // (filtering to HIGH conviction would otherwise give a misleadingly perfect breadth reading)
  const breadth = useMemo(() => {
    if (results.length === 0) return null;
    const n = results.length;
    const bullish = results.filter(r => r.supertrendBullish).length;
    const rsValid = results.filter(r => r.rsVsNifty != null);
    const outperforming = rsValid.filter(r => r.rsVsNifty! > 0).length;
    const cmfValid = results.filter(r => r.cmfCurrent != null);
    const avgCmf = cmfValid.length > 0
      ? cmfValid.reduce((a, r) => a + (r.cmfCurrent ?? 0), 0) / cmfValid.length
      : null;
    const highVol = results.filter(r => r.volRatio != null && r.volRatio > 1.5).length;
    const rsiAbove55 = results.filter(r => r.rsiCurrent != null && r.rsiCurrent > 55).length;
    return { n, bullish, bullishPct: Math.round(bullish / n * 100),
             outperforming, outperformingPct: rsValid.length > 0 ? Math.round(outperforming / rsValid.length * 100) : null,
             avgCmf, highVol,
             rsiAbove55, rsiAbove55Pct: Math.round(rsiAbove55 / n * 100) };
  }, [results]);

  // Stale data — warn if last price bar is more than 4 calendar days old
  const isDataStale = useMemo(() => {
    if (!lastRunMeta?.date) return false;
    const daysOld = (Date.now() - new Date(lastRunMeta.date).getTime()) / 86_400_000;
    return daysOld > 4;
  }, [lastRunMeta]);

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-mono dark">
      {/* Left Panel */}
      <div className="w-80 flex-shrink-0 border-r border-border bg-card flex flex-col hidden md:flex">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-bold tracking-tight text-primary flex items-center gap-2">
            <RefreshCw className="w-5 h-5" /> NSE MOMENTUM
          </h1>
        </div>
        
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Symbols</h3>
                <Badge variant="secondary" className="text-xs">{symbols.length}</Badge>
              </div>

              <div className="flex flex-wrap gap-1">
                {presetsLoading ? (
                  <div className="text-xs text-muted-foreground">Loading presets...</div>
                ) : (
                  presetsData?.presets.map(p => (
                    <Button
                      key={p.name}
                      variant="outline"
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={() => loadPreset(p.symbols)}
                    >
                      {p.name}
                    </Button>
                  ))
                )}
              </div>

              <form onSubmit={handleAddSymbol} className="flex gap-2">
                <Input
                  value={newSymbol}
                  onChange={e => setNewSymbol(e.target.value)}
                  placeholder="Add symbol..."
                  className="h-8 text-xs bg-muted/50"
                />
                <Button type="submit" size="sm" className="h-8 px-3">Add</Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => { setSymbols([]); toast.success("Cleared all symbols"); }}
                  title="Clear all symbols"
                  disabled={symbols.length === 0}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </form>

              <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto pt-2">
                {symbols.map(sym => (
                  <Badge key={sym} variant="secondary" className="text-[10px] pr-1 flex items-center gap-1">
                    {sym}
                    <X className="w-3 h-3 cursor-pointer hover:text-destructive" onClick={() => handleRemoveSymbol(sym)} />
                  </Badge>
                ))}
              </div>
            </div>

            <Separator />

            {/* Baskets */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <FolderOpen className="w-3.5 h-3.5" /> Baskets
                </h3>
                <Badge variant="secondary" className="text-xs">{baskets.length}</Badge>
              </div>

              {/* Create new basket */}
              <form
                onSubmit={e => { e.preventDefault(); createBasket(); }}
                className="flex gap-2"
              >
                <Input
                  value={newBasketName}
                  onChange={e => setNewBasketName(e.target.value)}
                  placeholder="New basket name..."
                  className="h-8 text-xs bg-muted/50"
                />
                <Button type="submit" size="sm" variant="outline" className="h-8 px-2 shrink-0" title="Create basket">
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </form>

              {/* Basket list */}
              <div className="space-y-1">
                {baskets.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground italic">No baskets yet — create one above</p>
                ) : baskets.map(b => (
                  <div key={b.id} className="flex items-center justify-between rounded bg-muted/30 px-2 py-1.5 group hover:bg-muted/50 transition-colors">
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-xs font-medium truncate">{b.name}</span>
                      <span className="text-[10px] text-muted-foreground">{b.symbols.length} symbols</span>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost" size="sm"
                        className="h-6 w-6 p-0 text-primary hover:text-primary"
                        onClick={() => loadBasketToScreener(b)}
                        title="Load into screener"
                      >
                        <ArrowRightFromLine className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => openBasketEditor(b)}
                        title="Edit basket"
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                        onClick={() => deleteBasket(b.id)}
                        title="Delete basket"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <div className="space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Parameters</h3>
              
              <div className="flex items-center justify-between">
                <Label className="text-xs">Use Synthetic Data</Label>
                <Switch 
                  checked={config.useSyntheticData}
                  onCheckedChange={(c) => updateConfig("useSyntheticData", c)}
                />
              </div>

              <Tabs defaultValue="periods" className="w-full">
                <TabsList className="w-full grid grid-cols-2 h-8">
                  <TabsTrigger value="periods" className="text-xs">Periods</TabsTrigger>
                  <TabsTrigger value="weights" className="text-xs">Weights</TabsTrigger>
                </TabsList>
                <TabsContent value="periods" className="space-y-2 mt-3">
                  {renderConfigInput("Lookback Days", "lookbackDays")}
                  {renderConfigInput("ROC Period", "rocPeriod")}
                  {renderConfigInput("RSI Period", "rsiPeriod")}
                  {renderConfigInput("ADX Period", "adxPeriod")}
                  {renderConfigInput("MACD Fast", "macdFast")}
                  {renderConfigInput("MACD Slow", "macdSlow")}
                  {renderConfigInput("MACD Signal", "macdSignal")}
                  {renderConfigInput("OBV Lookback", "obvLookback")}
                </TabsContent>
                <TabsContent value="weights" className="space-y-2 mt-3">
                  {renderConfigInput("Weight ROC", "weightRoc", 0.05)}
                  {renderConfigInput("Weight MACD", "weightMacd", 0.05)}
                  {renderConfigInput("Weight OBV", "weightObv", 0.05)}
                  {renderConfigInput("Weight RSI", "weightRsi", 0.05)}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </ScrollArea>
        
        <div className="p-4 border-t border-border bg-muted/20">
          <Button 
            className="w-full font-bold uppercase tracking-wider" 
            onClick={() => handleRunScreen(symbols, config)}
            disabled={isScreening}
          >
            {isScreening ? "SCREENING..." : "Run Screen"} <Play className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header / Info Bar */}
        <header className="h-16 border-b border-border flex items-center justify-between px-4 lg:px-6 bg-card">
          <div className="flex items-center gap-4">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden">
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-80 p-0 font-mono bg-card border-r border-border flex flex-col">
                <SheetHeader className="p-4 border-b border-border shrink-0">
                  <SheetTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                    <RefreshCw className="w-4 h-4" /> NSE MOMENTUM
                  </SheetTitle>
                </SheetHeader>
                <ScrollArea className="flex-1">
                  <div className="p-4 space-y-6">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Symbols</h3>
                        <Badge variant="secondary" className="text-xs">{symbols.length}</Badge>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {presetsLoading ? (
                          <div className="text-xs text-muted-foreground">Loading presets...</div>
                        ) : (
                          presetsData?.presets.map(p => (
                            <Button key={p.name} variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => loadPreset(p.symbols)}>{p.name}</Button>
                          ))
                        )}
                      </div>
                      <form onSubmit={handleAddSymbol} className="flex gap-2">
                        <Input value={newSymbol} onChange={e => setNewSymbol(e.target.value)} placeholder="Add symbol..." className="h-8 text-xs bg-muted/50" />
                        <Button type="submit" size="sm" className="h-8 px-3">Add</Button>
                        <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive" onClick={() => { setSymbols([]); toast.success("Cleared all symbols"); }} title="Clear all symbols" disabled={symbols.length === 0}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </form>
                      <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto pt-2">
                        {symbols.map(sym => (
                          <Badge key={sym} variant="secondary" className="text-[10px] pr-1 flex items-center gap-1">
                            {sym}<X className="w-3 h-3 cursor-pointer hover:text-destructive" onClick={() => handleRemoveSymbol(sym)} />
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <Separator />
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                          <FolderOpen className="w-3.5 h-3.5" /> Baskets
                        </h3>
                        <Badge variant="secondary" className="text-xs">{baskets.length}</Badge>
                      </div>
                      <form onSubmit={e => { e.preventDefault(); createBasket(); }} className="flex gap-2">
                        <Input value={newBasketName} onChange={e => setNewBasketName(e.target.value)} placeholder="New basket name..." className="h-8 text-xs bg-muted/50" />
                        <Button type="submit" size="sm" variant="outline" className="h-8 px-2 shrink-0" title="Create basket"><Plus className="w-3.5 h-3.5" /></Button>
                      </form>
                      <div className="space-y-1">
                        {baskets.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground italic">No baskets yet — create one above</p>
                        ) : baskets.map(b => (
                          <div key={b.id} className="flex items-center justify-between rounded bg-muted/30 px-2 py-1.5 group hover:bg-muted/50 transition-colors">
                            <div className="flex flex-col min-w-0 flex-1">
                              <span className="text-xs font-medium truncate">{b.name}</span>
                              <span className="text-[10px] text-muted-foreground">{b.symbols.length} symbols</span>
                            </div>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-primary hover:text-primary" onClick={() => loadBasketToScreener(b)} title="Load into screener"><ArrowRightFromLine className="w-3 h-3" /></Button>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground" onClick={() => openBasketEditor(b)} title="Edit basket"><Pencil className="w-3 h-3" /></Button>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive hover:text-destructive" onClick={() => deleteBasket(b.id)} title="Delete basket"><Trash2 className="w-3 h-3" /></Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <Separator />
                    <div className="space-y-4">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Parameters</h3>
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">Use Synthetic Data</Label>
                        <Switch checked={config.useSyntheticData} onCheckedChange={(c) => updateConfig("useSyntheticData", c)} />
                      </div>
                      <Tabs defaultValue="periods" className="w-full">
                        <TabsList className="w-full grid grid-cols-2 h-8">
                          <TabsTrigger value="periods" className="text-xs">Periods</TabsTrigger>
                          <TabsTrigger value="weights" className="text-xs">Weights</TabsTrigger>
                        </TabsList>
                        <TabsContent value="periods" className="space-y-2 mt-3">
                          {renderConfigInput("Lookback Days", "lookbackDays")}
                          {renderConfigInput("ROC Period", "rocPeriod")}
                          {renderConfigInput("RSI Period", "rsiPeriod")}
                          {renderConfigInput("ADX Period", "adxPeriod")}
                          {renderConfigInput("MACD Fast", "macdFast")}
                          {renderConfigInput("MACD Slow", "macdSlow")}
                          {renderConfigInput("MACD Signal", "macdSignal")}
                          {renderConfigInput("OBV Lookback", "obvLookback")}
                        </TabsContent>
                        <TabsContent value="weights" className="space-y-2 mt-3">
                          {renderConfigInput("Weight ROC", "weightRoc", 0.05)}
                          {renderConfigInput("Weight MACD", "weightMacd", 0.05)}
                          {renderConfigInput("Weight OBV", "weightObv", 0.05)}
                          {renderConfigInput("Weight RSI", "weightRsi", 0.05)}
                        </TabsContent>
                      </Tabs>
                    </div>
                  </div>
                </ScrollArea>
                <div className="p-4 border-t border-border bg-muted/20 shrink-0">
                  <Button className="w-full font-bold uppercase tracking-wider" onClick={() => handleRunScreen(symbols, config)} disabled={isScreening}>
                    {isScreening ? "SCREENING..." : "Run Screen"} <Play className="w-4 h-4 ml-2" />
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
            
            <div className="flex flex-col">
              <span className="text-sm font-bold text-foreground flex items-center gap-2">
                Screener Results
                {isDataStale && (
                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 tracking-wide">
                    STALE DATA
                  </span>
                )}
              </span>
              {lastRunMeta ? (
                <span className="text-[10px] text-muted-foreground">
                  {filteredResults.length < results.length ? (
                    <><span className="text-yellow-400 font-semibold">Showing {filteredResults.length}/{results.length}</span>{" • "}</>
                  ) : (
                    <>{results.length} symbols • </>
                  )}
                  {lastRunMeta.duration}ms • Data as of: {new Date(lastRunMeta.date).toLocaleDateString()}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground">Not run yet</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 lg:gap-4">
            <div className="relative w-48 hidden sm:block">
              <Search className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input 
                placeholder="Search..." 
                className="h-8 pl-8 text-xs bg-muted/50 border-muted"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1"
                  data-testid="button-download-csv"
                >
                  <Download className="w-3.5 h-3.5" />
                  Ticker
                  <ChevronDown className="w-3 h-3 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52 font-mono">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Current results</DropdownMenuLabel>
                <DropdownMenuItem
                  className="text-xs gap-2"
                  disabled={filteredResults.length === 0}
                  onSelect={downloadCsv}
                >
                  <Download className="w-3 h-3" />
                  Visible rows ({filteredResults.length})
                </DropdownMenuItem>
                {baskets.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">By basket (file history)</DropdownMenuLabel>
                    {baskets.map(b => (
                      <DropdownMenuItem
                        key={b.id}
                        className="text-xs gap-2"
                        disabled={basketDownloading === b.id}
                        onSelect={() => downloadBasketCsv(b)}
                      >
                        <Download className="w-3 h-3" />
                        {b.name}
                        <span className="ml-auto text-muted-foreground/50">{b.symbols.length}</span>
                        {basketDownloading === b.id && <RefreshCw className="w-3 h-3 animate-spin" />}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={downloadExcel}
              disabled={filteredResults.length === 0}
              data-testid="button-download-xlsx"
              title={`Export ${filteredResults.length} visible rows as Excel`}
            >
              <Download className="w-3.5 h-3.5" />
              Excel
            </Button>
            <Button
              variant={emailJobs.some(j => j.enabled) ? "default" : "outline"}
              size="sm"
              className={`h-8 text-xs gap-1.5 ${emailJobs.some(j => j.enabled) ? "bg-primary/20 text-primary border-primary/40 hover:bg-primary/30" : ""}`}
              onClick={() => { setEmailView("list"); setEmailOpen(true); }}
            >
              <Mail className="w-3.5 h-3.5" />
              Email
              {emailJobs.some(j => j.enabled) && <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={copyTVWatchlist}
              disabled={filteredResults.length === 0}
              title="Copy as TradingView watchlist (NSE:SYMBOL,...)"
            >
              <Copy className="w-3.5 h-3.5" />
              TV List
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
                  <Columns3 className="w-3.5 h-3.5" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 font-mono">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Score</DropdownMenuLabel>
                {SCORE_KEYS.map(k => (
                  <DropdownMenuCheckboxItem key={k} checked={vis(k)} onCheckedChange={() => toggleCol(k)} className="text-xs">{COL_LABELS[k]}</DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Technicals</DropdownMenuLabel>
                {TECH_KEYS.map(k => (
                  <DropdownMenuCheckboxItem key={k} checked={vis(k)} onCheckedChange={() => toggleCol(k)} className="text-xs">{COL_LABELS[k]}</DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Fundamentals</DropdownMenuLabel>
                {FUND_KEYS.map(k => (
                  <DropdownMenuCheckboxItem key={k} checked={vis(k)} onCheckedChange={() => toggleCol(k)} className="text-xs">{COL_LABELS[k]}</DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Scan Templates */}
        <div className="border-b border-border/50 px-3 py-2 flex flex-wrap items-center gap-2 bg-muted/20 text-xs">
          <span className="text-muted-foreground/60 text-[10px] uppercase tracking-wider mr-1">Quick scan:</span>
          {[
            { label: "🚀 Momentum Leaders", fn: () => { resetFilters(); setConvictionFilter("HIGH"); setTechGradeFilter("AB"); setMinAdx(25); } },
            { label: "🔄 Recovery Watch",   fn: () => { resetFilters(); setFlagFilter("BULL_DIV"); setScoreChangeFilter("improving"); } },
            { label: "💎 Value Momentum",   fn: () => { resetFilters(); setConvictionFilter("VALUE_WATCH"); setScoreChangeFilter("improving"); } },
            { label: "🎯 Breakout Setup",   fn: () => { resetFilters(); setFlagFilter("NEAR_BREAKOUT"); setMinAdx(25); } },
          ].map(({ label, fn }) => (
            <button
              key={label}
              onClick={fn}
              className="px-2 py-0.5 rounded border border-border/60 text-[10px] text-muted-foreground hover:text-foreground hover:border-border bg-background/50 hover:bg-muted/30 transition-colors"
            >{label}</button>
          ))}
          {flagFilter && (
            <span className="ml-1 flex items-center gap-1 text-[10px] text-primary bg-primary/10 px-2 py-0.5 rounded border border-primary/30">
              flag: {flagFilter}
              <button onClick={() => setFlagFilter(null)} className="hover:text-foreground ml-1">×</button>
            </span>
          )}
        </div>

        {/* Filters Bar */}
        <div className="border-b border-border p-3 flex flex-wrap items-center gap-4 bg-background text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">RSI Score:</span>
            <Input 
              type="number" 
              className="w-16 h-7 text-xs" 
              value={minRsi} 
              onChange={e => setMinRsi(Number(e.target.value))} 
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">ADX Score:</span>
            <Input 
              type="number" 
              className="w-16 h-7 text-xs" 
              value={minAdx} 
              onChange={e => setMinAdx(Number(e.target.value))} 
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Change:</span>
            <Select value={scoreChangeFilter} onValueChange={v => setScoreChangeFilter(v as typeof scoreChangeFilter)}>
              <SelectTrigger className="h-7 text-xs bg-card border-muted w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All</SelectItem>
                <SelectItem value="improving" className="text-xs">Improving</SelectItem>
                <SelectItem value="declining" className="text-xs">Declining</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Conviction:</span>
            <Select value={convictionFilter} onValueChange={setConvictionFilter}>
              <SelectTrigger className="h-7 text-xs bg-card border-muted w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All</SelectItem>
                <SelectItem value="HIGH" className="text-xs">🟢 HIGH</SelectItem>
                <SelectItem value="MOMENTUM" className="text-xs">🩵 MOMENTUM</SelectItem>
                <SelectItem value="VALUE_WATCH" className="text-xs">🔵 VALUE_WATCH</SelectItem>
                <SelectItem value="AVOID" className="text-xs">🔴 AVOID</SelectItem>
                <SelectItem value="NEUTRAL" className="text-xs">⚫ NEUTRAL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Tech:</span>
            <Select value={techGradeFilter} onValueChange={setTechGradeFilter}>
              <SelectTrigger className="h-7 text-xs bg-card border-muted w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All</SelectItem>
                <SelectItem value="AB" className="text-xs">A or B</SelectItem>
                <SelectItem value="A" className="text-xs">A</SelectItem>
                <SelectItem value="B" className="text-xs">B</SelectItem>
                <SelectItem value="C" className="text-xs">C</SelectItem>
                <SelectItem value="D" className="text-xs">D</SelectItem>
                <SelectItem value="F" className="text-xs">F</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">VQ:</span>
            <Select value={vqGradeFilter} onValueChange={setVqGradeFilter}>
              <SelectTrigger className="h-7 text-xs bg-card border-muted w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All</SelectItem>
                <SelectItem value="AB" className="text-xs">A or B</SelectItem>
                <SelectItem value="A" className="text-xs">A</SelectItem>
                <SelectItem value="B" className="text-xs">B</SelectItem>
                <SelectItem value="C" className="text-xs">C</SelectItem>
                <SelectItem value="D" className="text-xs">D</SelectItem>
                <SelectItem value="F" className="text-xs">F</SelectItem>
                <SelectItem value="N/A" className="text-xs">N/A</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-foreground px-2" onClick={resetFilters}>
              <X className="w-3 h-3 mr-1" />Reset
            </Button>
          )}
          {/* Filter presets */}
          <div className="flex items-center gap-1 ml-auto">
            {filterPresets.length > 0 && (
              <select
                className="h-7 text-[10px] bg-card border border-border rounded px-1 text-muted-foreground"
                value=""
                onChange={e => {
                  const p = filterPresets.find(p => p.name === e.target.value);
                  if (p) {
                    setMinRsi(p.minRsi); setMinAdx(p.minAdx);
                    setScoreChangeFilter(p.scoreChangeFilter); setConvictionFilter(p.convictionFilter);
                    setTechGradeFilter(p.techGradeFilter); setVqGradeFilter(p.vqGradeFilter);
                  }
                }}
              >
                <option value="" disabled>Load preset…</option>
                {filterPresets.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            )}
            {presetSaveOpen ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  placeholder="Preset name…"
                  value={presetNameInput}
                  onChange={e => setPresetNameInput(e.target.value)}
                  className="h-7 text-[10px] bg-muted/50 border border-border rounded px-2 w-28"
                  onKeyDown={e => {
                    if (e.key === "Enter" && presetNameInput.trim()) {
                      const preset: FilterPreset = { name: presetNameInput.trim(), minRsi, minAdx, scoreChangeFilter, convictionFilter, techGradeFilter, vqGradeFilter };
                      setFilterPresets(prev => [...prev.filter(p => p.name !== preset.name), preset]);
                      setPresetNameInput(""); setPresetSaveOpen(false);
                      toast.success("Preset saved");
                    }
                    if (e.key === "Escape") { setPresetSaveOpen(false); setPresetNameInput(""); }
                  }}
                />
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={() => { setPresetSaveOpen(false); setPresetNameInput(""); }}>✕</Button>
              </div>
            ) : (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-muted-foreground" title="Save current filter as preset" onClick={() => setPresetSaveOpen(true)}>
                <Save className="w-3 h-3" />
              </Button>
            )}
          </div>
          {/* Historical run comparison */}
          {runHistory.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <select
                className="h-7 text-[10px] bg-card border border-border rounded px-1 text-muted-foreground"
                value={compareWithIdx ?? ""}
                onChange={e => setCompareWithIdx(e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Compare with…</option>
                {runHistory.map((snap, i) => (
                  <option key={i} value={i}>{snap.date.slice(0, 10)} ({snap.count} stocks)</option>
                ))}
              </select>
              {entryExitDiff && (entryExitDiff.entries.length > 0 || entryExitDiff.exits.length > 0) && (
                <span className="flex items-center gap-2 text-[9px] font-mono">
                  {entryExitDiff.entries.length > 0 && (
                    <span className="text-green-400" title={`New: ${entryExitDiff.entries.join(", ")}`}>+{entryExitDiff.entries.length} in</span>
                  )}
                  {entryExitDiff.exits.length > 0 && (
                    <span className="text-red-400" title={`Dropped: ${entryExitDiff.exits.join(", ")}`}>−{entryExitDiff.exits.length} out</span>
                  )}
                </span>
              )}
              {secondarySortConfig && (
                <span className="flex items-center gap-1 text-[9px] text-muted-foreground/70 font-mono border border-border/40 rounded px-1.5 py-0.5">
                  ²{String(secondarySortConfig.key)} {secondarySortConfig.direction === "asc" ? "↑" : "↓"}
                  <button className="text-red-400/60 hover:text-red-400 ml-0.5" onClick={() => setSecondarySortConfig(null)}>✕</button>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Market Breadth Strip */}
        {breadth && !isScreening && (
          <div className="border-b border-border/50 px-4 py-2 flex flex-wrap items-center gap-x-6 gap-y-1 bg-card/30 text-[10px] font-mono">
            <span className="text-muted-foreground uppercase tracking-widest text-[9px]">Breadth</span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground">ST Bullish</span>
              <span className={`font-bold ${breadth.bullishPct >= 60 ? "text-green-400" : breadth.bullishPct >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                {breadth.bullish}/{breadth.n} ({breadth.bullishPct}%)
              </span>
            </span>
            {breadth.outperformingPct != null && (
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">RS&gt;Nifty</span>
                <span className={`font-bold ${breadth.outperformingPct >= 60 ? "text-green-400" : breadth.outperformingPct >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                  {breadth.outperforming}/{breadth.n} ({breadth.outperformingPct}%)
                </span>
              </span>
            )}
            {breadth.avgCmf != null && (
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Avg CMF</span>
                <span className={`font-bold ${breadth.avgCmf > 0.05 ? "text-green-400" : breadth.avgCmf < -0.05 ? "text-red-400" : "text-yellow-400"}`}>
                  {breadth.avgCmf.toFixed(3)}
                </span>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground">High Vol (×1.5+)</span>
              <span className={`font-bold ${breadth.highVol / breadth.n >= 0.3 ? "text-green-400" : "text-muted-foreground"}`}>
                {breadth.highVol}/{breadth.n}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground">RSI&gt;55</span>
              <span className={`font-bold ${breadth.rsiAbove55Pct >= 60 ? "text-green-400" : breadth.rsiAbove55Pct >= 40 ? "text-yellow-400" : "text-red-400"}`}>
                {breadth.rsiAbove55}/{breadth.n} ({breadth.rsiAbove55Pct}%)
              </span>
            </span>
            {marketRegime && (
              <span className={`ml-auto px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest border ${
                marketRegime === "BULL" ? "text-green-400 border-green-800/50 bg-green-900/20" :
                marketRegime === "BEAR" ? "text-red-400 border-red-800/50 bg-red-900/20" :
                "text-yellow-400 border-yellow-800/50 bg-yellow-900/20"
              }`}>
                {marketRegime} Market
              </span>
            )}
          </div>
        )}

        {/* Sector Heatmap */}
        {sectorStats.length > 0 && !isScreening && (
          <div className="border-b border-border/50 bg-card/20">
            <button
              className="w-full px-4 py-2 flex items-center gap-2 text-xs hover:bg-muted/20 transition-colors text-left"
              onClick={() => setSectorHeatmapOpen(p => !p)}
            >
              <BarChart2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="text-cyan-300 font-semibold">Sector Heatmap</span>
              <span className="text-muted-foreground">{sectorStats.length} sectors</span>
              <span className="ml-auto text-muted-foreground/50">
                {sectorHeatmapOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </span>
            </button>
            {sectorHeatmapOpen && (
              <div className="px-4 pb-3 border-t border-border/30 pt-2 overflow-x-auto">
                <table className="text-[10px] font-mono w-full min-w-[420px]">
                  <thead>
                    <tr className="text-muted-foreground uppercase tracking-wider border-b border-border/30">
                      <th className="py-1 text-left pr-4">Sector</th>
                      <th className="py-1 text-right pr-4">Stocks</th>
                      <th className="py-1 text-right pr-4">Avg Tech</th>
                      <th className="py-1 text-right pr-3">Trend</th>
                      <th className="py-1 text-right pr-4">Grade</th>
                      <th className="py-1 text-right">Avg VQ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sectorStats.map(s => {
                      const prev = prevSectorAvg.get(s.sector);
                      const delta = prev != null ? Math.round((s.avgTech - prev) * 10) / 10 : null;
                      return (
                        <tr key={s.sector} className="border-b border-border/10 hover:bg-muted/10">
                          <td className="py-1 pr-4 text-foreground/80 max-w-[160px] truncate">{s.sector}</td>
                          <td className="py-1 pr-4 text-right text-muted-foreground">{s.count}</td>
                          <td className={`py-1 pr-4 text-right font-bold ${s.avgTech >= 75 ? "text-green-400" : s.avgTech >= 60 ? "text-emerald-400" : s.avgTech >= 45 ? "text-yellow-400" : "text-red-400"}`}>{s.avgTech.toFixed(1)}</td>
                          <td className="py-1 pr-3 text-right">
                            {delta != null ? (
                              <span className={`text-[9px] font-mono ${delta > 0 ? "text-green-400" : delta < 0 ? "text-red-400" : "text-muted-foreground/40"}`}>
                                {delta > 0 ? "▲" : delta < 0 ? "▼" : "—"}{delta !== 0 ? Math.abs(delta).toFixed(1) : ""}
                              </span>
                            ) : <span className="text-muted-foreground/30 text-[9px]">—</span>}
                          </td>
                          <td className="py-1 pr-4 text-right">
                            <span className={`px-1 rounded ${s.avgTech >= 75 ? "bg-green-900/40 text-green-400" : s.avgTech >= 60 ? "bg-emerald-900/40 text-emerald-400" : s.avgTech >= 45 ? "bg-yellow-900/40 text-yellow-400" : "bg-red-900/40 text-red-400"}`}>
                              {s.avgTech >= 75 ? "A" : s.avgTech >= 60 ? "B" : s.avgTech >= 45 ? "C" : s.avgTech >= 30 ? "D" : "F"}
                            </span>
                          </td>
                          <td className={`py-1 text-right ${s.avgVq != null ? s.avgVq >= 75 ? "text-green-400" : s.avgVq >= 60 ? "text-emerald-400" : s.avgVq >= 45 ? "text-yellow-400" : "text-red-400" : "text-muted-foreground/40"}`}>
                            {s.avgVq != null ? s.avgVq.toFixed(1) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* AI Summary Panel */}
        {results.length > 0 && !isScreening && (
          <div className="border-b border-border/50 bg-card/20">
            <button
              className="w-full px-4 py-2 flex items-center gap-2 text-xs hover:bg-muted/20 transition-colors text-left"
              onClick={() => aiSummaryOpen ? setAiSummaryOpen(false) : handleAiSummary()}
            >
              <Sparkles className="w-3.5 h-3.5 text-violet-400 shrink-0" />
              <span className="text-violet-300 font-semibold">Claude Analysis</span>
              {aiSummaryLoading && <span className="text-muted-foreground animate-pulse">generating…</span>}
              {!aiSummaryLoading && aiSummaryText && <span className="text-muted-foreground truncate max-w-[600px]">{aiSummaryText.slice(0, 100)}…</span>}
              {!aiSummaryLoading && !aiSummaryText && <span className="text-muted-foreground">Click to analyse screen results with Claude</span>}
              <span className="ml-auto text-muted-foreground/50">
                {aiSummaryOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </span>
            </button>
            {aiSummaryOpen && (
              <div className="px-4 pb-3 text-xs text-foreground/90 leading-relaxed border-t border-border/30 pt-2 max-w-5xl">
                {aiSummaryLoading && !aiSummaryText ? (
                  <span className="text-muted-foreground animate-pulse">Asking Claude…</span>
                ) : (
                  <p className="whitespace-pre-wrap">{aiSummaryText}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Stock AI Drawer */}
        {aiStockOpen && (
          <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setAiStockOpen(false)}>
            <div className="bg-card border-l border-border w-full max-w-sm h-full shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
                <Sparkles className="w-4 h-4 text-violet-400" />
                <span className="font-bold text-sm">{aiStockSymbol}</span>
                <span className="text-xs text-muted-foreground">— Claude's take</span>
                <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setAiStockOpen(false)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-auto px-4 py-3 text-sm leading-relaxed text-foreground/90">
                {aiStockLoading && !aiStockText ? (
                  <span className="text-muted-foreground animate-pulse text-xs">Asking Claude…</span>
                ) : (
                  <p className="whitespace-pre-wrap">{aiStockText}</p>
                )}
                {aiStockLoading && aiStockText && (
                  <span className="inline-block w-1 h-4 bg-violet-400 animate-pulse ml-0.5 align-middle" />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Stock Detail Drawer */}
        {drawerStock && (
          <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setDrawerStock(null)}>
            <div className="bg-card border-l border-border w-full max-w-md h-full shadow-2xl flex flex-col font-mono" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
                <BookOpen className="w-4 h-4 text-cyan-400" />
                <span className="font-bold text-sm">{drawerStock.symbol}</span>
                {drawerStock.conviction && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                    drawerStock.conviction === "HIGH"        ? "bg-green-950 text-green-400" :
                    drawerStock.conviction === "MOMENTUM"    ? "bg-teal-950 text-teal-400" :
                    drawerStock.conviction === "VALUE_WATCH" ? "bg-blue-950 text-blue-400" :
                    drawerStock.conviction === "AVOID"       ? "bg-red-950 text-red-400" :
                    "bg-muted text-muted-foreground"
                  }`}>{drawerStock.conviction}</span>
                )}
                <button
                  title={starredSymbols.has(drawerStock.symbol) ? "Unpin" : "Pin"}
                  className={`ml-1 ${starredSymbols.has(drawerStock.symbol) ? "text-amber-400" : "text-muted-foreground hover:text-amber-400"}`}
                  onClick={() => toggleStar(drawerStock.symbol)}
                >
                  <Star className={`w-3.5 h-3.5 ${starredSymbols.has(drawerStock.symbol) ? "fill-amber-400" : ""}`} />
                </button>
                <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={() => setDrawerStock(null)}>
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Scrollable body */}
              <div className="flex-1 overflow-auto px-4 py-3 space-y-4 text-xs">
                {/* 90-Day Price Sparkline */}
                <div>
                  {drawerBarsLoading ? (
                    <div className="h-20 bg-muted/30 animate-pulse rounded-md" />
                  ) : drawerBars.length > 1 ? (() => {
                    const prices = drawerBars.map(b => b.close);
                    const min = Math.min(...prices), max = Math.max(...prices);
                    const W = 340, H = 80, pad = 6;
                    const px = (i: number) => pad + (i / (prices.length - 1)) * (W - 2 * pad);
                    const py = (v: number) => pad + (1 - (v - min) / ((max - min) || 1)) * (H - 2 * pad);
                    const pts = prices.map((v, i) => `${px(i)},${py(v)}`).join(" ");
                    const last = drawerBars[drawerBars.length - 1];
                    const up = last.returnPct >= 0;
                    const color = up ? "#4ade80" : "#f87171";
                    return (
                      <div className="rounded-md bg-muted/30 p-2">
                        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                          <span>90D Price ({drawerBars[0]?.date} → {last.date})</span>
                          <span className={up ? "text-green-400 font-bold" : "text-red-400 font-bold"}>{up ? "+" : ""}{last.returnPct.toFixed(2)}%</span>
                        </div>
                        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="w-full">
                          <defs>
                            <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={color} stopOpacity="0.15" />
                              <stop offset="100%" stopColor={color} stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <polygon fill="url(#spark-fill)" points={`${pad},${H} ${pts} ${W-pad},${H}`} />
                          <polyline fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" points={pts} />
                          {niftyBars.length > 1 && (() => {
                            const np = niftyBars.map(b => b.close);
                            const nMin = Math.min(...np), nMax = Math.max(...np);
                            const npts = np.map((v, i) => `${pad + (i / (np.length - 1)) * (W - 2 * pad)},${pad + (1 - (v - nMin) / ((nMax - nMin) || 1)) * (H - 2 * pad)}`).join(" ");
                            return <polyline fill="none" stroke="#94a3b8" strokeWidth={1} strokeDasharray="3,3" strokeLinejoin="round" opacity={0.6} points={npts} />;
                          })()}
                          <circle cx={px(prices.length - 1)} cy={py(prices[prices.length - 1])} r={3} fill={color} />
                        </svg>
                        {niftyBars.length > 1 && (
                          <div className="flex items-center gap-2 mt-0.5 text-[9px] text-muted-foreground/60">
                            <span className="inline-block w-6 border-t border-dashed border-slate-400/60" />
                            <span>Nifty 50</span>
                            <span className={niftyBars[niftyBars.length-1].returnPct >= 0 ? "text-slate-400" : "text-slate-400"}>({niftyBars[niftyBars.length-1].returnPct >= 0 ? "+" : ""}{niftyBars[niftyBars.length-1].returnPct.toFixed(2)}%)</span>
                          </div>
                        )}
                      </div>
                    );
                  })() : (
                    <div className="h-8 text-[10px] text-muted-foreground/50 flex items-center">No price data in cache</div>
                  )}
                </div>

                {/* Score Summary */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: "Tech Score", val: `${(drawerStock.technicalScore ?? 0).toFixed(1)}`, sub: drawerStock.technicalGrade, color: drawerStock.technicalGrade === "A" ? "text-green-400" : drawerStock.technicalGrade === "B" ? "text-emerald-400" : drawerStock.technicalGrade === "C" ? "text-yellow-400" : "text-red-400" },
                    { label: "VQ Score",   val: drawerStock.vqScore != null ? drawerStock.vqScore.toFixed(1) : "—", sub: drawerStock.vqGrade ?? "—", color: drawerStock.vqGrade === "A" ? "text-green-400" : drawerStock.vqGrade === "B" ? "text-emerald-400" : drawerStock.vqGrade === "C" ? "text-yellow-400" : "text-muted-foreground" },
                    { label: "Composite",  val: drawerStock.compositeScoreCurrent.toFixed(2), sub: drawerStock.compositeScoreChange > 0 ? `▲${drawerStock.compositeScoreChange.toFixed(2)}` : `▼${Math.abs(drawerStock.compositeScoreChange).toFixed(2)}`, color: drawerStock.compositeScoreChange >= 0 ? "text-green-400" : "text-red-400" },
                  ].map(({ label, val, sub, color }) => (
                    <div key={label} className="bg-muted/30 rounded p-2">
                      <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
                      <div className="text-base font-bold text-foreground">{val}</div>
                      <div className={`text-[9px] font-semibold ${color}`}>{sub}</div>
                    </div>
                  ))}
                </div>

                {/* Flags */}
                {((drawerStock.techFlags ?? "") + (drawerStock.vqFlags ?? "")).length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {[...(drawerStock.techFlags?.split(",") ?? []), ...(drawerStock.vqFlags?.split(",") ?? [])].filter(Boolean).map(f => (
                      <span key={f} className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${
                        f === "ST_BEARISH"    ? "bg-red-900/40 text-red-400" :
                        f === "BEARISH_DIV"  ? "bg-orange-900/40 text-orange-400" :
                        f === "BULL_DIV"     ? "bg-cyan-900/40 text-cyan-400" :
                        f === "VOL_DIV"      ? "bg-blue-900/40 text-blue-400" :
                        f === "OVERBOUGHT"   ? "bg-red-900/40 text-red-400" :
                        f === "BELOW_EMA200" ? "bg-orange-900/40 text-orange-400" :
                        f === "NEAR_BREAKOUT"? "bg-green-900/40 text-green-400" :
                        f === "VOL_BREAKOUT" ? "bg-emerald-900/40 text-emerald-400" :
                        f === "EPS_ACCEL"    ? "bg-cyan-900/40 text-cyan-400" :
                        f === "LOSS_MAKING"  ? "bg-red-900/40 text-red-400" :
                        f === "GROWTH_PRICED"? "bg-purple-900/40 text-purple-400" :
                        "bg-muted/40 text-muted-foreground"
                      }`}>{f}</span>
                    ))}
                  </div>
                )}

                {/* Momentum */}
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 border-b border-border/30 pb-1">Momentum</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {[
                      { k: "ROC", cur: drawerStock.rocCurrent, ago: drawerStock.roc2WAgo, unit: "%" },
                      { k: "RSI", cur: drawerStock.rsiCurrent, ago: drawerStock.rsi2WAgo, unit: "" },
                      { k: "ADX", cur: drawerStock.adxCurrent, ago: drawerStock.adx2WAgo, unit: "" },
                      { k: "OBV", cur: drawerStock.obvCurrent, ago: drawerStock.obv2WAgo, unit: "" },
                      { k: "MACD", cur: drawerStock.macdCurrent, ago: drawerStock.macd2WAgo, unit: "" },
                      { k: "CMF", cur: drawerStock.cmfCurrent, ago: null, unit: "" },
                    ].map(({ k, cur, ago, unit }) => {
                      const c = cur ?? 0;
                      const up = ago != null ? c >= ago : c > 0;
                      return (
                        <div key={k} className="flex justify-between text-[10px]">
                          <span className="text-muted-foreground">{k}</span>
                          <span className={`font-mono ${cur == null ? "text-muted-foreground/40" : up ? "text-green-400" : "text-red-400"}`}>
                            {cur != null ? c.toFixed(c === Math.round(c) ? 0 : 2) : "—"}{unit}
                            {ago != null && cur != null && <span className="text-muted-foreground/50 ml-1">({c - ago >= 0 ? "+" : ""}{(c - ago).toFixed(2)}{unit})</span>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Structure */}
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 border-b border-border/30 pb-1">Structure</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {[
                      { k: "Supertrend", val: drawerStock.supertrendBullish ? "▲ Buy" : "▼ Sell", color: drawerStock.supertrendBullish ? "text-green-400" : "text-red-400" },
                      { k: "EMA Rank", val: String(drawerStock.emaRank ?? "—"), color: (drawerStock.emaRank ?? 9) <= 3 ? "text-green-400" : (drawerStock.emaRank ?? 9) <= 6 ? "text-yellow-400" : "text-red-400" },
                      { k: "BB %B", val: drawerStock.bbPctB != null ? drawerStock.bbPctB.toFixed(3) : "—", color: "text-foreground/80" },
                      { k: "Vol Ratio", val: drawerStock.volRatio != null ? `${drawerStock.volRatio.toFixed(2)}×` : "—", color: (drawerStock.volRatio ?? 0) > 1.5 ? "text-green-400" : "text-foreground/80" },
                      { k: "52W High", val: drawerStock.highPct52w != null ? `${drawerStock.highPct52w.toFixed(1)}%` : "—", color: (drawerStock.highPct52w ?? -100) >= -5 ? "text-green-400" : "text-foreground/80" },
                      { k: "RS vs Nifty", val: drawerStock.rsVsNifty != null ? `${drawerStock.rsVsNifty > 0 ? "+" : ""}${drawerStock.rsVsNifty.toFixed(2)}%` : "—", color: (drawerStock.rsVsNifty ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                      { k: "ATR %", val: drawerStock.atrPct != null ? `${drawerStock.atrPct.toFixed(2)}%` : "—", color: "text-foreground/80" },
                      { k: "Beta 1Y", val: drawerStock.beta1Y != null ? drawerStock.beta1Y.toFixed(2) : "—", color: "text-foreground/80" },
                      { k: "ATR Target ▲", val: drawerStock.atrPct != null ? `+${(drawerStock.atrPct * 1.5).toFixed(2)}%` : "—", color: "text-green-400" },
                      { k: "ATR Stop ▼",   val: drawerStock.atrPct != null ? `−${(drawerStock.atrPct * 1.0).toFixed(2)}%` : "—", color: "text-red-400" },
                    ].map(({ k, val, color }) => (
                      <div key={k} className="flex justify-between text-[10px]">
                        <span className="text-muted-foreground">{k}</span>
                        <span className={`font-mono ${color}`}>{val}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 52-Week Range Bar */}
                {drawerStock.highPct52w != null && drawerStock.lowPct52w != null && (() => {
                  const lo = drawerStock.lowPct52w!;
                  const hi = drawerStock.highPct52w!; // negative when below 52W high
                  const range = lo + Math.abs(hi);
                  const pct = range > 0 ? Math.round((lo / range) * 100) : 50;
                  return (
                    <div>
                      <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-1.5 border-b border-border/30 pb-1">52-Week Range</div>
                      <div className="flex items-center gap-2 text-[9px]">
                        <span className="text-muted-foreground w-6 text-right">{lo.toFixed(0)}%</span>
                        <div className="flex-1 relative h-2 bg-muted/40 rounded-full overflow-hidden">
                          <div className="absolute left-0 top-0 h-full bg-gradient-to-r from-red-600/60 via-yellow-500/60 to-green-500/60 w-full rounded-full" />
                          <div
                            className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-white border border-border shadow"
                            style={{ left: `calc(${Math.min(100, Math.max(0, pct))}% - 4px)` }}
                          />
                        </div>
                        <span className={`w-8 ${hi >= -5 ? "text-green-400" : "text-muted-foreground"}`}>{hi.toFixed(0)}%</span>
                      </div>
                      <div className="flex justify-between text-[8px] text-muted-foreground/50 mt-0.5 px-8">
                        <span>52W Low</span><span>Position {pct}%</span><span>52W High</span>
                      </div>
                    </div>
                  );
                })()}

                {/* Conviction History */}
                {(() => {
                  const last5 = runHistory.slice(-5).reverse();
                  const hist = last5.map(run => ({
                    date: run.date.slice(5, 10),
                    conviction: run.results.find(s => s.symbol === drawerStock.symbol)?.conviction ?? null,
                  })).filter(h => h.conviction != null);
                  if (hist.length === 0) return null;
                  return (
                    <div>
                      <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 border-b border-border/30 pb-1">Conviction History</div>
                      <div className="flex items-start gap-2 flex-wrap">
                        {hist.map(({ date, conviction }) => (
                          <div key={date} className="flex flex-col items-center gap-0.5">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                              conviction === "HIGH"        ? "bg-green-950 text-green-400" :
                              conviction === "MOMENTUM"    ? "bg-teal-950 text-teal-400" :
                              conviction === "VALUE_WATCH" ? "bg-blue-950 text-blue-400" :
                              conviction === "AVOID"       ? "bg-red-950 text-red-400" :
                              "bg-muted/40 text-muted-foreground"
                            }`}>{conviction}</span>
                            <span className="text-[7px] text-muted-foreground/50">{date}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Score History Chart — uses file-based ticker history (up to 1yr) with runHistory fallback */}
                {(() => {
                  // Prefer API-fetched file history (more data); fall back to in-memory run history
                  const pts: { date: string; score: number; conviction: string | null }[] =
                    drawerTickerHistory.length >= 2
                      ? drawerTickerHistory
                      : runHistory
                          .map(run => {
                            const s = run.results.find(rr => rr.symbol === drawerStock.symbol);
                            return s ? { date: run.date, score: s.compositeScoreCurrent, conviction: s.conviction ?? null } : null;
                          })
                          .filter((p): p is { date: string; score: number; conviction: string | null } => p != null)
                          .reverse();
                  if (pts.length < 2) return null;
                  const W = 320, H = 64, pad = 4;
                  const scores = pts.map(p => p.score);
                  const min = Math.min(...scores), max = Math.max(...scores);
                  const px2 = (i: number) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
                  const py2 = (v: number) => pad + (1 - (v - min) / ((max - min) || 1)) * (H - 2 * pad);
                  const polyPts = pts.map((p, i) => `${px2(i)},${py2(p.score)}`).join(" ");
                  const last = pts[pts.length - 1];
                  const trend = last.score - pts[0].score;
                  const color = trend >= 0 ? "#4ade80" : "#f87171";
                  const convColor = (cv: string | null) =>
                    cv === "HIGH" ? "#4ade80" : cv === "MOMENTUM" ? "#2dd4bf" : cv === "VALUE_WATCH" ? "#60a5fa" : cv === "AVOID" ? "#f87171" : "#94a3b8";
                  const source = drawerTickerHistory.length >= 2 ? "file cache" : "run history";
                  return (
                    <div>
                      <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 border-b border-border/30 pb-1 flex justify-between">
                        <span>Score History ({pts.length} pts)</span>
                        <span className="text-muted-foreground/40 normal-case">{source}</span>
                      </div>
                      <div className="rounded bg-muted/30 p-2">
                        <div className="flex justify-between text-[9px] text-muted-foreground mb-1">
                          <span>{pts[0].date.slice(5)}</span>
                          <span className={trend >= 0 ? "text-green-400 font-bold" : "text-red-400 font-bold"}>{trend >= 0 ? "+" : ""}{trend.toFixed(2)} overall</span>
                          <span>{last.date.slice(5)}</span>
                        </div>
                        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible">
                          <defs>
                            <linearGradient id="score-fill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={color} stopOpacity="0.12" />
                              <stop offset="100%" stopColor={color} stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <polygon fill="url(#score-fill)" points={`${pad},${H} ${polyPts} ${W-pad},${H}`} />
                          <polyline fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" points={polyPts} />
                          {pts.map((p, i) => (
                            <circle key={i} cx={px2(i)} cy={py2(p.score)} r={pts.length > 30 ? 1.5 : 2.5}
                              fill={convColor(p.conviction)} opacity={0.85}>
                              <title>{p.date}: {p.score.toFixed(2)}{p.conviction ? ` (${p.conviction})` : ""}</title>
                            </circle>
                          ))}
                          <circle cx={px2(pts.length - 1)} cy={py2(last.score)} r={3.5} fill={color} />
                        </svg>
                        <div className="flex justify-between text-[8px] text-muted-foreground/50 mt-0.5">
                          <span>lo {min.toFixed(1)}</span>
                          <span className="text-[9px] font-bold text-foreground/80">{last.score.toFixed(2)} now</span>
                          <span>hi {max.toFixed(1)}</span>
                        </div>
                        {/* Conviction dot legend */}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[8px] text-muted-foreground/60">
                          {[["HIGH","#4ade80"],["MOMENTUM","#2dd4bf"],["VALUE_WATCH","#60a5fa"],["AVOID","#f87171"]].map(([label, col]) => (
                            <span key={label} className="flex items-center gap-0.5">
                              <span className="inline-block w-2 h-2 rounded-full" style={{background:col}} />
                              {label}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Signal Backtest — entry signal analysis from ticker history */}
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 border-b border-border/30 pb-1 flex items-center justify-between">
                    <span>Entry Signal Backtest</span>
                    {drawerSignalLoading && <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground/40" />}
                  </div>
                  {!drawerSignalLoading && drawerSignalAnalysis && drawerSignalAnalysis.totalSignals > 0 ? (() => {
                    const sa = drawerSignalAnalysis;
                    const horizons: { label: string; key: keyof typeof sa.stats }[] = [
                      { label: "10d", key: "d10" }, { label: "20d", key: "d20" },
                      { label: "30d", key: "d30" }, { label: "60d", key: "d60" },
                    ];
                    const retColor = (v: number | null) => v == null ? "text-muted-foreground/40" : v >= 0 ? "text-green-400" : "text-red-400";
                    const winColor = (v: number | null) => v == null ? "text-muted-foreground/40" : v >= 60 ? "text-green-400" : v >= 45 ? "text-yellow-400" : "text-red-400";
                    const recentSignals = [...sa.signals].slice(-5).reverse();
                    return (
                      <div className="space-y-3">
                        <div className="text-[9px] text-muted-foreground/70 leading-relaxed">
                          Conviction flipped to <span className="text-green-400 font-semibold">HIGH</span> on <span className="font-mono text-foreground/80">{sa.totalSignals}</span> occasion{sa.totalSignals !== 1 ? "s" : ""} in the last year. Forward returns from those entry dates:
                        </div>
                        {/* Stats grid */}
                        <div className="grid grid-cols-4 gap-1">
                          {horizons.map(({ label, key }) => {
                            const h = sa.stats[key];
                            return (
                              <div key={key} className="bg-muted/20 rounded p-1.5 text-center space-y-0.5">
                                <div className="text-[8px] text-muted-foreground/60 uppercase tracking-wide">{label}</div>
                                <div className={`text-xs font-bold font-mono ${retColor(h.avgReturn)}`}>
                                  {h.avgReturn != null ? `${h.avgReturn >= 0 ? "+" : ""}${h.avgReturn.toFixed(1)}%` : "—"}
                                </div>
                                <div className={`text-[8px] font-mono ${winColor(h.winRate)}`}>
                                  {h.winRate != null ? `${h.winRate}% win` : "—"}
                                </div>
                                <div className="text-[7px] text-muted-foreground/40">{h.count}×</div>
                              </div>
                            );
                          })}
                        </div>
                        {/* Recent signal events */}
                        {recentSignals.length > 0 && (
                          <div>
                            <div className="text-[8px] text-muted-foreground/50 mb-1">Recent entry signals</div>
                            <div className="space-y-0.5">
                              {recentSignals.map(sig => (
                                <div key={sig.date} className="flex items-center gap-2 text-[9px] font-mono">
                                  <span className="text-muted-foreground/60 w-16 shrink-0">{sig.date.slice(5)}</span>
                                  <span className="text-foreground/70">₹{sig.entryClose.toFixed(0)}</span>
                                  <span className={`ml-auto ${retColor(sig.returns.d30)}`}>
                                    {sig.returns.d30 != null ? `30d ${sig.returns.d30 >= 0 ? "+" : ""}${sig.returns.d30.toFixed(1)}%` : "30d pending"}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="text-[7px] text-muted-foreground/30 italic">
                          Based on historical file data only. Past signals ≠ future results.
                        </div>
                      </div>
                    );
                  })() : !drawerSignalLoading && (
                    <div className="text-[9px] text-muted-foreground/40 italic">
                      {drawerSignalAnalysis === null ? "No price cache — run a full scan first." : "No HIGH conviction entry signals found in file history yet."}
                    </div>
                  )}
                </div>

                {/* Fundamentals */}
                <div>
                  <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 border-b border-border/30 pb-1">Fundamentals</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    {[
                      { k: "PE", val: drawerStock.pe != null ? drawerStock.pe.toFixed(1) : "—", color: "text-foreground/80" },
                      { k: "PEG", val: drawerStock.peg != null ? drawerStock.peg.toFixed(2) : "—", color: (drawerStock.peg ?? 99) < 1 ? "text-green-400" : (drawerStock.peg ?? 99) < 2 ? "text-yellow-400" : "text-red-400" },
                      { k: "ROE%", val: drawerStock.roe != null ? `${drawerStock.roe.toFixed(1)}%` : "—", color: (drawerStock.roe ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                      { k: "EV/EBITDA", val: drawerStock.evToEbitda != null ? drawerStock.evToEbitda.toFixed(1) : "—", color: "text-foreground/80" },
                      { k: "OPM%", val: drawerStock.opm != null ? `${drawerStock.opm.toFixed(1)}%` : "—", color: (drawerStock.opm ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                      { k: "Sales YoY", val: drawerStock.salesGrowthQtrYoY != null ? `${drawerStock.salesGrowthQtrYoY.toFixed(1)}%` : "—", color: (drawerStock.salesGrowthQtrYoY ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                      { k: "Profit YoY", val: drawerStock.profitGrowthQtrYoY != null ? `${drawerStock.profitGrowthQtrYoY.toFixed(1)}%` : "—", color: (drawerStock.profitGrowthQtrYoY ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                      { k: "Sales 3Y", val: drawerStock.salesCagr3Y != null ? `${drawerStock.salesCagr3Y.toFixed(1)}%` : "—", color: (drawerStock.salesCagr3Y ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                      { k: "Stock 1Y", val: drawerStock.stockCagr1Y != null ? `${drawerStock.stockCagr1Y.toFixed(1)}%` : "—", color: (drawerStock.stockCagr1Y ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                      { k: "Stock 3Y", val: drawerStock.stockCagr3Y != null ? `${drawerStock.stockCagr3Y.toFixed(1)}%` : "—", color: (drawerStock.stockCagr3Y ?? 0) > 0 ? "text-green-400" : "text-red-400" },
                    ].map(({ k, val, color }) => (
                      <div key={k} className="flex justify-between text-[10px]">
                        <span className="text-muted-foreground">{k}</span>
                        <span className={`font-mono ${color}`}>{val}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Run Diff — what changed since last scan */}
        {runDiff && (
          <div className="border-b border-border/50 bg-card/20">
            <button
              className="w-full px-4 py-2 flex items-center gap-2 text-xs hover:bg-muted/20 transition-colors text-left"
              onClick={() => setRunDiffOpen(p => !p)}
            >
              <RefreshCw className="w-3.5 h-3.5 text-purple-400 shrink-0" />
              <span className="text-purple-300 font-semibold">What changed</span>
              {runDiff.newHighMomentum.length > 0 && <span className="text-green-400 text-[10px]">+{runDiff.newHighMomentum.length} HIGH/MOMENTUM</span>}
              {runDiff.dropped.length > 0 && <span className="text-red-400 text-[10px]">−{runDiff.dropped.length} dropped</span>}
              {runDiff.bigMovers.length > 0 && <span className="text-amber-400 text-[10px]">{runDiff.bigMovers.length} big movers</span>}
              <button className="ml-auto text-muted-foreground/40 hover:text-muted-foreground" onClick={e => { e.stopPropagation(); setRunDiff(null); }}>
                <X className="w-3 h-3" />
              </button>
              <span className="text-muted-foreground/50">{runDiffOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}</span>
            </button>
            {runDiffOpen && (
              <div className="px-4 pb-3 pt-1 border-t border-border/30 grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px] font-mono">
                {runDiff.newHighMomentum.length > 0 && (
                  <div>
                    <div className="text-[9px] uppercase tracking-wider text-green-400/60 mb-1.5">🟢 New HIGH / MOMENTUM</div>
                    <div className="flex flex-wrap gap-1">
                      {runDiff.newHighMomentum.map(s => (
                        <button key={s} onClick={() => { const r = results.find(x => x.symbol === s); if (r) setDrawerStock(r); }}
                          className="px-1.5 py-0.5 bg-green-900/30 text-green-400 rounded hover:bg-green-900/50 transition-colors">{s}</button>
                      ))}
                    </div>
                  </div>
                )}
                {runDiff.dropped.length > 0 && (
                  <div>
                    <div className="text-[9px] uppercase tracking-wider text-red-400/60 mb-1.5">🔴 Dropped from HIGH / MOMENTUM</div>
                    <div className="flex flex-wrap gap-1">
                      {runDiff.dropped.map(s => (
                        <button key={s} onClick={() => { const r = results.find(x => x.symbol === s); if (r) setDrawerStock(r); }}
                          className="px-1.5 py-0.5 bg-red-900/30 text-red-400 rounded hover:bg-red-900/50 transition-colors">{s}</button>
                      ))}
                    </div>
                  </div>
                )}
                {runDiff.bigMovers.length > 0 && (
                  <div>
                    <div className="text-[9px] uppercase tracking-wider text-amber-400/60 mb-1.5">⚡ Big Movers (Δ≥10)</div>
                    <div className="flex flex-wrap gap-1">
                      {runDiff.bigMovers.slice(0, 12).map(m => (
                        <button key={m.symbol} onClick={() => { const r = results.find(x => x.symbol === m.symbol); if (r) setDrawerStock(r); }}
                          className={`px-1.5 py-0.5 rounded hover:brightness-110 transition-colors ${m.delta > 0 ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>
                          {m.symbol} {m.delta > 0 ? "▲" : "▼"}{Math.abs(m.delta).toFixed(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Table */}
        <div className="flex-1 overflow-auto bg-background p-2">
          {isScreening ? (
            <div className="flex flex-col gap-2 p-4">
              {screenProgress && (
                <div className="mb-2">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>
                      {screenProgress.phase === "fundamentals"
                        ? `Fetching fundamentals ${screenProgress.done - Math.floor(screenProgress.total / 2)}/${Math.floor(screenProgress.total / 2)}…`
                        : `Fetching prices ${screenProgress.done}/${Math.floor(screenProgress.total / 2)}…`
                      }
                    </span>
                    <span>{Math.round((screenProgress.done / screenProgress.total) * 100)}%</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 rounded-full"
                      style={{ width: `${(screenProgress.done / screenProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
              )}
              {[1,2,3,4,5,6,7,8].map(i => (
                <div key={i} className="h-10 w-full bg-muted/30 animate-pulse rounded" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm flex-col gap-2">
              <SlidersHorizontal className="w-8 h-8 opacity-20" />
              <p>Run the screener to see results</p>
            </div>
          ) : (
            <div className="min-w-max border border-border rounded-lg">
              {/* Conviction band distribution bar */}
              {filteredResults.length > 0 && (
                <div className="flex items-stretch text-[10px] font-mono rounded-t-lg overflow-hidden border-b border-border/40">
                  {([ 
                    { label: "HIGH",        count: convictionCounts.HIGH,        bg: "bg-green-900/70",  text: "text-green-300",  active: "ring-1 ring-inset ring-green-400/50"  },
                    { label: "MOMENTUM",    count: convictionCounts.MOMENTUM,    bg: "bg-teal-900/70",   text: "text-teal-300",   active: "ring-1 ring-inset ring-teal-400/50"   },
                    { label: "VALUE_WATCH", count: convictionCounts.VALUE_WATCH, bg: "bg-blue-900/70",   text: "text-blue-300",   active: "ring-1 ring-inset ring-blue-400/50"   },
                    { label: "AVOID",       count: convictionCounts.AVOID,       bg: "bg-red-900/70",    text: "text-red-300",    active: "ring-1 ring-inset ring-red-400/50"    },
                    ...(convictionCounts.other > 0
                      ? [{ label: "OTHER", count: convictionCounts.other, bg: "bg-muted/50", text: "text-muted-foreground", active: "" }]
                      : []),
                  ] as { label: string; count: number; bg: string; text: string; active: string }[])
                    .filter(b => b.count > 0)
                    .map(b => (
                      <button
                        key={b.label}
                        onClick={() => setConvictionFilter(convictionFilter === b.label ? "all" : b.label)}
                        className={`flex-1 py-1 px-2 ${b.bg} ${b.text} ${convictionFilter === b.label ? b.active : "hover:brightness-125"} transition-all cursor-pointer text-center`}
                        title={`${convictionFilter === b.label ? "Clear filter" : "Filter"}: ${b.label} (${b.count})`}
                      >
                        <span className="font-bold">{b.count}</span>
                        <span className="opacity-60 ml-1 hidden sm:inline">{b.label}</span>
                      </button>
                    ))
                  }
                  <span className="ml-auto px-3 flex items-center text-muted-foreground/40 text-[9px] shrink-0">{filteredResults.length} total</span>
                </div>
              )}
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className="bg-card text-muted-foreground uppercase tracking-wider sticky top-0 z-10 shadow-sm">
                  <tr className="border-b border-border/30 text-[9px]">
                    <th className="p-1 sticky left-0 z-20 bg-card shadow-[2px_0_4px_rgba(0,0,0,0.4)]" />
                    {scoreSpan > 0 && <th className="p-1 text-center border-l border-border/40 text-blue-400/70 tracking-widest" colSpan={scoreSpan}>Score</th>}
                    {techSpan > 0 && <th className="p-1 text-center border-l border-border/40 tracking-widest" colSpan={techSpan}>Technicals</th>}
                    {fundSpan > 0 && <th className="p-1 text-center border-l border-border/40 text-emerald-500/70 tracking-widest cursor-help" colSpan={fundSpan} title="Yahoo Finance data — cached up to 24 h per symbol. Re-run to refresh.">Fundamentals ≤24h</th>}
                  </tr>
                  <tr>
                    <th className="p-3 cursor-pointer hover:text-primary transition-colors sticky left-0 z-20 bg-card shadow-[2px_0_4px_rgba(0,0,0,0.4)]" onClick={() => handleSort("symbol")}>Symbol {sortConfig.key === "symbol" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>
                    {vis("conviction") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-center" onClick={() => handleSort("conviction")}>Conviction {sortConfig.key === "conviction" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("technicalGrade") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-center" onClick={() => handleSort("technicalGrade")}>Tech Grade {sortConfig.key === "technicalGrade" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("technicalScore") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("technicalScore")}>Tech Score {sortConfig.key === "technicalScore" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("vqGrade") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-center" onClick={() => handleSort("vqGrade")}>VQ Grade {sortConfig.key === "vqGrade" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("vqScore") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("vqScore")}>VQ Score {sortConfig.key === "vqScore" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("compositeScoreCurrent") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("compositeScoreCurrent")}>Score {sortConfig.key === "compositeScoreCurrent" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("compositeScore2WAgo") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("compositeScore2WAgo")}>Score 2W {sortConfig.key === "compositeScore2WAgo" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("compositeScoreChange") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("compositeScoreChange")}>Score Δ {sortConfig.key === "compositeScoreChange" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("rocCurrent") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("rocCurrent")}>ROC % {sortConfig.key === "rocCurrent" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("roc2WAgo") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("roc2WAgo")}>ROC % 2W {sortConfig.key === "roc2WAgo" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("rocDiff") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("rocDiff")}>ROC Δ {sortConfig.key === "rocDiff" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("obvCurrent") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("obvCurrent")}>OBV {sortConfig.key === "obvCurrent" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("obv2WAgo") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("obv2WAgo")}>OBV 2W {sortConfig.key === "obv2WAgo" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("obvDiff") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("obvDiff")}>OBV Δ {sortConfig.key === "obvDiff" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("rsiCurrent") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("rsiCurrent")}>RSI {sortConfig.key === "rsiCurrent" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("rsi2WAgo") && <th className="p-3 text-right text-muted-foreground/60">RSI 2W</th>}
                    {vis("rsiDiff") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("rsiDiff")}>RSI Δ {sortConfig.key === "rsiDiff" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("adxCurrent") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("adxCurrent")}>ADX {sortConfig.key === "adxCurrent" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("adx2WAgo") && <th className="p-3 text-right text-muted-foreground/60">ADX 2W</th>}
                    {vis("adxDiff") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("adxDiff")}>ADX Δ {sortConfig.key === "adxDiff" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("macdCurrent") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("macdCurrent")}>MACD {sortConfig.key === "macdCurrent" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("macd2WAgo") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("macd2WAgo")}>MACD 2W {sortConfig.key === "macd2WAgo" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("supertrendBullish") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-center" onClick={() => handleSort("supertrendBullish")}>ST (10,3) {sortConfig.key === "supertrendBullish" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("emaRank") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-center" onClick={() => handleSort("emaRank")}>EMA Rank {sortConfig.key === "emaRank" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("cmfCurrent") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("cmfCurrent")}>CMF (20) {sortConfig.key === "cmfCurrent" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("highPct52w") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("highPct52w")}>52W High % {sortConfig.key === "highPct52w" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("lowPct52w") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("lowPct52w")}>52W Low % {sortConfig.key === "lowPct52w" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("rsVsNifty") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("rsVsNifty")}>RS vs Nifty {sortConfig.key === "rsVsNifty" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("volRatio") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("volRatio")}>Vol Ratio {sortConfig.key === "volRatio" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("atrPct") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("atrPct")}>ATR % {sortConfig.key === "atrPct" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("bbPctB") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("bbPctB")}>BB %B {sortConfig.key === "bbPctB" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("beta1Y") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("beta1Y")}>Beta 1Y {sortConfig.key === "beta1Y" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("pe") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("pe")}>PE {sortConfig.key === "pe" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("peg") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("peg")}>PEG {sortConfig.key === "peg" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("roe") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("roe")}>ROE% {sortConfig.key === "roe" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("evToEbitda") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("evToEbitda")}>EV/EBITDA {sortConfig.key === "evToEbitda" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("salesGrowthAnnual") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("salesGrowthAnnual")}>Sales Gr% {sortConfig.key === "salesGrowthAnnual" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("salesCagr3Y") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("salesCagr3Y")}>Sales 3Y CAGR {sortConfig.key === "salesCagr3Y" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("salesGrowthQtrYoY") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("salesGrowthQtrYoY")}>Sales (YoY) {sortConfig.key === "salesGrowthQtrYoY" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("profitGrowthAnnual") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("profitGrowthAnnual")}>Profit Gr% {sortConfig.key === "profitGrowthAnnual" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("profitGrowthQtrYoY") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("profitGrowthQtrYoY")}>Profit (YoY) {sortConfig.key === "profitGrowthQtrYoY" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("opm") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("opm")}>OPM% {sortConfig.key === "opm" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("stockCagr1Y") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("stockCagr1Y")}>Stock CAGR 1Y {sortConfig.key === "stockCagr1Y" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                    {vis("stockCagr3Y") && <th className="p-3 cursor-pointer hover:text-primary transition-colors text-right" onClick={() => handleSort("stockCagr3Y")}>Stock CAGR 3Y {sortConfig.key === "stockCagr3Y" && (sortConfig.direction === "asc" ? "↑" : "↓")}</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredResults.map((r, i) => {
                    const isTopQ = i < filteredResults.length * 0.25;
                    const isBotQ = i > filteredResults.length * 0.75;
                    
                    const scoreUp  = r.compositeScoreCurrent >= r.compositeScore2WAgo;
                    const rocUp    = r.rocCurrent   >= r.roc2WAgo;
                    const obvUp    = r.obvCurrent   >= r.obv2WAgo;
                    const rsiUp    = r.rsiCurrent   >= r.rsi2WAgo;
                    const adxUp    = r.adxCurrent   >= r.adx2WAgo;
                    const macdUp   = r.macdCurrent  >= r.macd2WAgo;

                    const sectorRank = sectorRankMap.get(r.symbol);
                    const isStale = tradingDaysAgo(r.dateCurrent) > 2;
                    return (
                      <tr
                        key={r.symbol}
                        onClick={() => setFocusedRowIdx(i)}
                        className={`hover:bg-muted/30 transition-colors group ${starredSymbols.has(r.symbol) ? "bg-amber-950/10" : ""} ${focusedRowIdx === i ? "ring-1 ring-inset ring-primary/40" : ""}`}
                      >
                        <td className="p-3 font-bold text-foreground sticky left-0 z-10 bg-background group-hover:bg-muted/30 transition-colors shadow-[2px_0_4px_rgba(0,0,0,0.4)] relative">
                          <div className="flex items-center gap-1.5">
                            <button
                              title={starredSymbols.has(r.symbol) ? "Unpin" : "Pin symbol"}
                              className={`transition-opacity ${starredSymbols.has(r.symbol) ? "text-amber-400 opacity-100" : "opacity-0 group-hover:opacity-60 text-amber-500 hover:opacity-100"}`}
                              onClick={() => toggleStar(r.symbol)}
                            >
                              <Star className={`w-3 h-3 ${starredSymbols.has(r.symbol) ? "fill-amber-400" : ""}`} />
                            </button>
                            <button
                              title="View stock details"
                              className="hover:text-primary transition-colors text-left"
                              onClick={() => setDrawerStock(r)}
                            >
                              {r.symbol}
                              {isStale && <span title={`Data is stale (${tradingDaysAgo(r.dateCurrent)} trading days old)`} className="ml-0.5 text-[8px]">⚠️</span>}
                            </button>
                            <button
                              title="Ask Claude to explain this stock's score"
                              className="opacity-0 group-hover:opacity-100 transition-opacity text-violet-400 hover:text-violet-300"
                              onClick={() => handleAiStock(r)}
                            >
                              <Sparkles className="w-3 h-3" />
                            </button>
                            <a
                              title="Download ticker history as CSV"
                              href={`/api/ticker-history/${r.symbol}/download`}
                              download
                              className="opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity text-sky-400 hover:text-sky-300"
                              onClick={e => e.stopPropagation()}
                            >
                              <Download className="w-3 h-3" />
                            </a>
                            <button
                              title={notes[r.symbol] ? "Edit note" : "Add note"}
                              className={`transition-opacity text-[10px] leading-none ${notes[r.symbol] ? "opacity-100" : "opacity-0 group-hover:opacity-60 hover:opacity-100"}`}
                              onClick={e => { e.stopPropagation(); setNotePopover(notePopover === r.symbol ? null : r.symbol); }}
                            >
                              📝
                            </button>
                            {sectorRank && sectorRank.total > 1 && (
                              <span className="text-[8px] text-muted-foreground/40 font-mono">#{sectorRank.rank}/{sectorRank.total}</span>
                            )}
                            {streakMap.has(r.symbol) && (
                              <span title={`${streakMap.get(r.symbol)} consecutive HIGH/MOMENTUM runs`} className="text-[8px] text-orange-400 font-bold">🔥×{streakMap.get(r.symbol)}</span>
                            )}
                            {fadingLeaders.has(r.symbol) && (
                              <span title="Fading Leader: was HIGH for 3+ runs but score now declining" className="text-[8px] text-red-400">⬇️</span>
                            )}
                            {r.highPct52w != null && r.highPct52w >= -5 && (
                              <span
                                title={`Within ${Math.abs(r.highPct52w).toFixed(1)}% of 52-week high — near breakout zone`}
                                className="inline-flex items-center px-1 py-px rounded text-[8px] font-bold bg-green-900/60 text-green-300 ring-1 ring-green-700/60 leading-none"
                              >52H</span>
                            )}
                            {r.lowPct52w != null && r.lowPct52w <= 10 && (
                              <span
                                title={`Only ${r.lowPct52w.toFixed(1)}% above 52-week low — near support level`}
                                className="inline-flex items-center px-1 py-px rounded text-[8px] font-bold bg-sky-900/60 text-sky-300 ring-1 ring-sky-700/60 leading-none"
                              >52L</span>
                            )}
                            {starredSymbols.has(r.symbol) && (() => {
                              const prev = prevResultsMap.current.get(r.symbol);
                              const drop = prev != null ? (prev.technicalScore ?? 0) - (r.technicalScore ?? 0) : 0;
                              return drop > 8 ? (
                                <span title={`Score dropped ${drop.toFixed(1)} pts since last run`} className="text-[8px] text-red-400 font-bold bg-red-900/20 px-0.5 rounded">−{drop.toFixed(0)}</span>
                              ) : null;
                            })()}
                          </div>
                          {notePopover === r.symbol && (
                            <div className="absolute left-0 top-full z-50 bg-card border border-border rounded-lg shadow-xl p-2 min-w-[220px]" onClick={e => e.stopPropagation()}>
                              <textarea
                                autoFocus
                                className="w-full text-[10px] bg-muted/30 border border-border/50 rounded p-1.5 resize-none h-16 text-foreground placeholder:text-muted-foreground/40 font-sans"
                                placeholder="Add a note…"
                                value={notes[r.symbol] ?? ""}
                                onChange={e => setNotes(prev => ({ ...prev, [r.symbol]: e.target.value }))}
                              />
                              <div className="flex justify-between mt-1">
                                {notes[r.symbol] ? (
                                  <button className="text-[9px] text-red-400 hover:text-red-300" onClick={() => setNotes(prev => { const n = { ...prev }; delete n[r.symbol]; return n; })}>Clear</button>
                                ) : <span />}
                                <button className="text-[9px] text-primary hover:text-primary/80" onClick={() => setNotePopover(null)}>Done</button>
                              </div>
                            </div>
                          )}
                        </td>
                        {vis("conviction") && <td className="p-3 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            {r.conviction ? <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                              r.conviction === "HIGH"        ? "bg-green-950 text-green-400 ring-1 ring-green-700" :
                              r.conviction === "MOMENTUM"    ? "bg-teal-950 text-teal-400 ring-1 ring-teal-700" :
                              r.conviction === "VALUE_WATCH" ? "bg-blue-950 text-blue-400 ring-1 ring-blue-700" :
                              r.conviction === "AVOID"       ? "bg-red-950 text-red-400 ring-1 ring-red-800" :
                              "bg-muted/40 text-muted-foreground ring-1 ring-border"
                            }`}>{r.conviction}</span> : <span className="text-muted-foreground/40">—</span>}
                            {(() => {
                              const weekly = convictionWeeklyMap.get(r.symbol);
                              if (!weekly) return null;
                              const [w1, w2, w3] = weekly;
                              // Only show trail if at least one historical data point exists
                              if (!w1 && !w2 && !w3) return null;
                              const convColor = (c: string | null) =>
                                c === "HIGH"        ? "bg-green-900/70 text-green-400 ring-green-700" :
                                c === "MOMENTUM"    ? "bg-teal-900/70 text-teal-400 ring-teal-700" :
                                c === "VALUE_WATCH" ? "bg-blue-900/70 text-blue-400 ring-blue-700" :
                                c === "AVOID"       ? "bg-red-900/70 text-red-400 ring-red-800" :
                                "bg-muted/30 text-muted-foreground/40 ring-border/30";
                              const abbrev = (c: string | null) =>
                                c === "HIGH" ? "H" : c === "MOMENTUM" ? "M" : c === "VALUE_WATCH" ? "V" : c === "AVOID" ? "A" : "·";
                              const fullName = (c: string | null, label: string) =>
                                `${label}: ${c ?? "no data"}`;
                              const steps: [string | null, string][] = [
                                [w3, "W3 (~3w ago)"], [w2, "W2 (~2w ago)"], [w1, "W1 (~1w ago)"], [r.conviction ?? null, "Now"],
                              ];
                              const tip = steps.map(([c, l]) => fullName(c, l)).join(" → ");
                              return (
                                <div title={tip} className="flex items-center gap-0.5 mt-0.5">
                                  {steps.map(([c, label], idx) => (
                                    <span key={label} className="flex items-center gap-0.5">
                                      <span className={`inline-flex items-center justify-center w-4 h-4 rounded text-[8px] font-bold ring-1 ${convColor(c)} ${idx === 3 ? "w-5 h-5 text-[9px]" : ""}`}>
                                        {abbrev(c)}
                                      </span>
                                      {idx < 3 && <span className="text-muted-foreground/30 text-[8px]">›</span>}
                                    </span>
                                  ))}
                                </div>
                              );
                            })()}
                          </div>
                        </td>}
                        {vis("technicalGrade") && <td className="p-3 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={`inline-flex items-center justify-center w-6 h-6 rounded font-bold text-xs ${
                              r.technicalGrade === "A" ? "bg-green-500 text-white" :
                              r.technicalGrade === "B" ? "bg-emerald-400 text-white" :
                              r.technicalGrade === "C" ? "bg-yellow-500 text-black" :
                              r.technicalGrade === "D" ? "bg-orange-500 text-white" :
                              r.technicalGrade === "F" ? "bg-red-600 text-white" :
                              "bg-muted text-muted-foreground"
                            }`}>{r.technicalGrade || "—"}</span>
                            {r.techFlags && r.techFlags.length > 0 && (
                              <span className="text-[8px] text-muted-foreground/60 leading-tight text-center max-w-[60px] truncate" title={r.techFlags}>
                                {r.techFlags.split(",").map(f =>
                                  f === "ST_BEARISH"    ? "🔻" :
                                  f === "BEARISH_DIV"  ? "⚠️" :
                                  f === "BULL_DIV"     ? "🔄" :
                                  f === "VOL_DIV"      ? "🌊" :
                                  f === "OVERBOUGHT"   ? "🔥" :
                                  f === "BELOW_EMA200" ? "📉" :
                                  f === "NEAR_BREAKOUT"? "🎯" :
                                  f === "VOL_BREAKOUT" ? "🔊" : f
                                ).join("")}
                              </span>
                            )}
                            {(() => {
                              const snaps = weeklySnapshotMap.get(r.symbol);
                              if (!snaps) return null;
                              const [s1, s2, s3] = snaps;
                              if (!s1.techGrade && !s2.techGrade && !s3.techGrade) return null;
                              const gradeColor = (g: string | null) =>
                                g === "A" ? "bg-green-700/60 text-green-300 ring-green-600" :
                                g === "B" ? "bg-emerald-700/60 text-emerald-300 ring-emerald-600" :
                                g === "C" ? "bg-yellow-700/60 text-yellow-200 ring-yellow-600" :
                                g === "D" ? "bg-orange-700/60 text-orange-300 ring-orange-600" :
                                g === "F" ? "bg-red-800/60 text-red-300 ring-red-700" :
                                "bg-muted/30 text-muted-foreground/40 ring-border/30";
                              const steps: [string | null, string][] = [
                                [s3.techGrade, "W3 (~3w ago)"], [s2.techGrade, "W2 (~2w ago)"],
                                [s1.techGrade, "W1 (~1w ago)"], [r.technicalGrade ?? null, "Now"],
                              ];
                              const tip = steps.map(([g, l]) => `${l}: ${g ?? "—"}`).join(" → ");
                              return (
                                <div title={tip} className="flex items-center gap-0.5 mt-0.5">
                                  {steps.map(([g, label], idx) => (
                                    <span key={label} className="flex items-center gap-0.5">
                                      <span className={`inline-flex items-center justify-center rounded text-[7px] font-bold ring-1 ${gradeColor(g)} ${idx === 3 ? "w-5 h-5 text-[8px]" : "w-4 h-4"}`}>
                                        {g ?? "·"}
                                      </span>
                                      {idx < 3 && <span className="text-muted-foreground/30 text-[8px]">›</span>}
                                    </span>
                                  ))}
                                </div>
                              );
                            })()}
                          </div>
                        </td>}
                        {vis("technicalScore") && (() => {
          const prevR = prevResultsMap.current.get(r.symbol);
          const cmpR  = compareMap.get(r.symbol);
          const techDelta  = prevR != null ? (r.technicalScore ?? 0) - (prevR.technicalScore ?? 0) : null;
          const cmpDelta   = cmpR  != null ? (r.technicalScore ?? 0) - (cmpR.technicalScore ?? 0) : null;
          const bigChange  = techDelta != null && Math.abs(techDelta) >= 5;
          const sA = (r as StockScore & { scoreSubA?: number }).scoreSubA;
          const sB = (r as StockScore & { scoreSubB?: number }).scoreSubB;
          const sC = (r as StockScore & { scoreSubC?: number }).scoreSubC;
          const hasBreakdown = sA != null && sB != null && sC != null;
          const deductions = (r.techFlags ?? "").includes("BEARISH_DIV") ? 6 : (r.techFlags ?? "").includes("VOL_DIV") ? 4 : !r.supertrendBullish ? 12 : 0;
          return (
            <td className={`p-3 text-right font-medium relative group/tscore ${bigChange ? techDelta! > 0 ? "text-green-400 bg-green-900/15" : "text-red-400 bg-red-900/15" : "text-foreground/80"}`}>
              <div>{(r.technicalScore ?? 0).toFixed(1)}</div>
              {bigChange && (
                <div className={`text-[8px] ${techDelta! > 0 ? "text-green-500" : "text-red-500"}`}>
                  {techDelta! > 0 ? "▲" : "▼"}{Math.abs(techDelta!).toFixed(1)}
                </div>
              )}
              {cmpDelta != null && Math.abs(cmpDelta) >= 1 && (
                <div className={`text-[8px] ${cmpDelta > 0 ? "text-blue-400" : "text-orange-400"}`}>
                  vs hist: {cmpDelta > 0 ? "+" : ""}{cmpDelta.toFixed(1)}
                </div>
              )}
              {/* Score breakdown tooltip on hover */}
              {hasBreakdown && (
                <div className="absolute right-0 top-full z-50 hidden group-hover/tscore:block bg-popover border border-border rounded-lg p-2.5 shadow-xl text-left w-48 pointer-events-none mt-0.5">
                  <div className="text-[9px] uppercase tracking-widest text-muted-foreground mb-2 font-semibold">Score Breakdown</div>
                  {([
                    { label: "Momentum State", val: sA!, wt: 50 },
                    { label: "Momentum Change", val: sB!, wt: 35 },
                    { label: "Risk Quality",    val: sC!, wt: 15 },
                  ] as const).map(({ label, val, wt }) => (
                    <div key={label} className="mb-1.5">
                      <div className="flex justify-between text-[9px] mb-0.5">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-mono text-foreground/80">{(val * wt).toFixed(1)}<span className="text-muted-foreground/50">/{wt}</span></span>
                      </div>
                      <div className="h-1 bg-muted/30 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${val >= 0.75 ? "bg-green-500" : val >= 0.5 ? "bg-emerald-400" : val >= 0.35 ? "bg-yellow-400" : "bg-red-500"}`} style={{ width: `${val * 100}%` }} />
                      </div>
                    </div>
                  ))}
                  {deductions > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/30 flex justify-between text-[9px]">
                      <span className="text-red-400">{(r.techFlags ?? "").includes("BEARISH_DIV") ? "Bearish Div" : (r.techFlags ?? "").includes("VOL_DIV") ? "Vol Divergence" : "ST Bearish"}</span>
                      <span className="font-mono text-red-400">−{deductions} pts</span>
                    </div>
                  )}
                  <div className="mt-1 pt-1 border-t border-border/30 flex justify-between text-[9px] font-semibold">
                    <span className="text-muted-foreground">Final</span>
                    <span className="font-mono text-foreground">{(r.technicalScore ?? 0).toFixed(1)}</span>
                  </div>
                </div>
              )}
            </td>
          );
        })()}
                        {vis("vqGrade") && <td className="p-3 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={`inline-flex items-center justify-center w-6 h-6 rounded font-bold text-xs ${
                              r.vqGrade === "A"   ? "bg-green-500 text-white" :
                              r.vqGrade === "B"   ? "bg-emerald-400 text-white" :
                              r.vqGrade === "C"   ? "bg-yellow-500 text-black" :
                              r.vqGrade === "D"   ? "bg-orange-500 text-white" :
                              r.vqGrade === "F"   ? "bg-red-600 text-white" :
                              r.vqGrade === "N/A" ? "bg-muted/60 text-muted-foreground text-[9px]" :
                              "bg-muted text-muted-foreground"
                            }`}>{r.vqGrade || "—"}</span>
                            {r.vqFlags && r.vqFlags.length > 0 && (
                              <span className="text-[8px] text-muted-foreground/60 leading-tight text-center max-w-[60px] truncate" title={r.vqFlags}>
                                {r.vqFlags.split(",").map(f =>
                                  f === "LOSS_MAKING"  ? "📉" :
                                  f === "GROWTH_PRICED"? "🚀" :
                                  f === "NEW_LISTING"  ? "🆕" :
                                  f === "EPS_ACCEL"    ? "⚡" : f
                                ).join("")}
                              </span>
                            )}
                          </div>
                        </td>}
                        {vis("vqScore") && <td className="p-3 text-right font-medium text-foreground/80">
                          <div>{r.vqScore != null ? r.vqScore.toFixed(1) : <span className="text-muted-foreground/40">—</span>}</div>
                          {r.latestQuarterDate && <div className="text-[8px] text-muted-foreground/40">{r.latestQuarterDate.slice(0, 7)}</div>}
                        </td>}
                        {vis("compositeScoreCurrent") && <td className={`p-3 text-right font-medium ${scoreUp ? "text-green-500" : "text-destructive"}`}>
                          {r.compositeScoreCurrent.toFixed(2)}
                        </td>}
                        {vis("compositeScore2WAgo") && <td className="p-3 text-right text-muted-foreground/70">{r.compositeScore2WAgo.toFixed(2)}</td>}
                        {vis("compositeScoreChange") && <td className={`p-3 text-right font-medium ${r.compositeScoreChange > 0 ? "text-green-500" : r.compositeScoreChange < 0 ? "text-destructive" : "text-muted-foreground/50"}`}>{r.compositeScoreChange > 0 ? "+" : ""}{r.compositeScoreChange.toFixed(2)}</td>}
                        {vis("rocCurrent") && <td className={`p-3 text-right ${rocUp ? "text-green-500" : "text-destructive"}`}>{r.rocCurrent.toFixed(2)}%</td>}
                        {vis("roc2WAgo") && <td className="p-3 text-right text-muted-foreground/70">{r.roc2WAgo.toFixed(2)}%</td>}
                        {vis("rocDiff") && <td className={`p-3 text-right font-medium ${r.rocDiff != null && r.rocDiff > 0 ? "text-green-500" : r.rocDiff != null && r.rocDiff < 0 ? "text-destructive" : "text-muted-foreground/50"}`}>{r.rocDiff != null ? `${r.rocDiff > 0 ? "+" : ""}${r.rocDiff.toFixed(2)}%` : "—"}</td>}
                        {vis("obvCurrent") && <td className={`p-3 text-right ${obvUp ? "text-green-500" : "text-destructive"}`}>{r.obvCurrent.toFixed(3)}</td>}
                        {vis("obv2WAgo") && <td className="p-3 text-right text-muted-foreground/70">{r.obv2WAgo.toFixed(3)}</td>}
                        {vis("obvDiff") && <td className={`p-3 text-right font-medium ${r.obvDiff != null && r.obvDiff > 0 ? "text-green-500" : r.obvDiff != null && r.obvDiff < 0 ? "text-destructive" : "text-muted-foreground/50"}`}>{r.obvDiff != null ? `${r.obvDiff > 0 ? "+" : ""}${r.obvDiff.toFixed(3)}` : "—"}</td>}
                        {vis("rsiCurrent") && <td className={`p-3 text-right ${rsiUp ? "text-green-500" : "text-destructive"}`}>{r.rsiCurrent.toFixed(1)}</td>}
                        {vis("rsi2WAgo") && <td className="p-3 text-right text-muted-foreground/60">{r.rsi2WAgo.toFixed(1)}</td>}
                        {vis("rsiDiff") && <td className={`p-3 text-right font-medium ${r.rsiDiff != null && r.rsiDiff > 0 ? "text-green-500" : r.rsiDiff != null && r.rsiDiff < 0 ? "text-destructive" : "text-muted-foreground/50"}`}>{r.rsiDiff != null ? `${r.rsiDiff > 0 ? "+" : ""}${r.rsiDiff.toFixed(1)}` : "—"}</td>}
                        {vis("adxCurrent") && <td className={`p-3 text-right ${adxUp ? "text-green-500" : "text-destructive"}`}>{r.adxCurrent.toFixed(1)}</td>}
                        {vis("adx2WAgo") && <td className="p-3 text-right text-muted-foreground/60">{r.adx2WAgo.toFixed(1)}</td>}
                        {vis("adxDiff") && <td className={`p-3 text-right font-medium ${r.adxDiff != null && r.adxDiff > 0 ? "text-green-500" : r.adxDiff != null && r.adxDiff < 0 ? "text-destructive" : "text-muted-foreground/50"}`}>{r.adxDiff != null ? `${r.adxDiff > 0 ? "+" : ""}${r.adxDiff.toFixed(1)}` : "—"}</td>}
                        {vis("macdCurrent") && <td className={`p-3 text-right ${macdUp ? "text-green-500" : "text-destructive"}`}>{r.macdCurrent.toFixed(3)}</td>}
                        {vis("macd2WAgo") && <td className="p-3 text-right text-muted-foreground/70">{r.macd2WAgo.toFixed(3)}</td>}
                        {vis("supertrendBullish") && <td className="p-3 text-center">
                          {r.supertrendBullish
                            ? <span className="inline-flex items-center gap-1 font-semibold text-green-500">▲ Buy</span>
                            : <span className="inline-flex items-center gap-1 font-semibold text-destructive">▼ Sell</span>
                          }
                        </td>}
                        {vis("emaRank") && <td className="p-3 text-center">
                          {(() => {
                            const rank = r.emaRank;
                            const colors: Record<number, string> = {
                              1: "bg-green-600 text-white", 2: "bg-green-500 text-white",
                              3: "bg-green-400 text-white", 4: "bg-yellow-500 text-black",
                              5: "bg-yellow-400 text-black", 6: "bg-orange-400 text-white",
                              7: "bg-orange-500 text-white", 8: "bg-red-500 text-white",
                              9: "bg-red-700 text-white",
                            };
                            const labels: Record<number, string> = {
                              1: "1 — Bull", 2: "2 — Bull", 3: "3 — Bull",
                              4: "4 — Mix",  5: "5 — Mix",  6: "6 — Mix",
                              7: "7 — Bear", 8: "8 — Bear", 9: "9 — Bear",
                            };
                            return <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${colors[rank] ?? "bg-muted text-muted-foreground"}`}>{labels[rank] ?? rank}</span>;
                          })()}
                        </td>}
                        {vis("cmfCurrent") && <td className={`p-3 text-right font-medium ${r.cmfCurrent != null && r.cmfCurrent > 0 ? "text-green-500" : r.cmfCurrent != null && r.cmfCurrent < 0 ? "text-destructive" : "text-muted-foreground/40"}`}>{r.cmfCurrent != null ? r.cmfCurrent.toFixed(3) : "—"}</td>}
                        {vis("highPct52w") && <td className={`p-3 text-right ${r.highPct52w != null && r.highPct52w >= -5 ? "text-green-500" : r.highPct52w != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.highPct52w != null ? `${r.highPct52w.toFixed(1)}%` : "—"}</td>}
                        {vis("lowPct52w") && <td className={`p-3 text-right font-medium ${r.lowPct52w != null && r.lowPct52w > 20 ? "text-green-500" : r.lowPct52w != null && r.lowPct52w > 10 ? "text-yellow-400" : r.lowPct52w != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.lowPct52w != null ? `${r.lowPct52w.toFixed(1)}%` : "—"}</td>}
                        {vis("rsVsNifty") && <td className={`p-3 text-right font-medium ${r.rsVsNifty != null && r.rsVsNifty > 0 ? "text-green-500" : r.rsVsNifty != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.rsVsNifty != null ? `${r.rsVsNifty.toFixed(2)}%` : "—"}</td>}
                        {vis("volRatio") && <td className={`p-3 text-right font-medium ${r.volRatio != null && r.volRatio > 1.5 ? "text-green-500" : r.volRatio != null && r.volRatio > 1 ? "text-yellow-500" : r.volRatio != null ? "text-muted-foreground/60" : "text-muted-foreground/40"}`}>{r.volRatio != null ? `${r.volRatio.toFixed(2)}×` : "—"}</td>}
                        {vis("atrPct") && <td className="p-3 text-right text-foreground/80">{r.atrPct != null ? `${r.atrPct.toFixed(2)}%` : "—"}</td>}
                        {vis("bbPctB") && <td className={`p-3 text-right font-medium ${r.bbPctB != null && r.bbPctB > 0.8 ? "text-yellow-400" : r.bbPctB != null && r.bbPctB < 0.2 ? "text-cyan-400" : r.bbPctB != null ? "text-foreground/80" : "text-muted-foreground/40"}`}>{r.bbPctB != null ? r.bbPctB.toFixed(3) : "—"}</td>}
                        {vis("beta1Y") && <td className={`p-3 text-right font-medium ${r.beta1Y != null && r.beta1Y > 1.5 ? "text-red-400" : r.beta1Y != null && r.beta1Y > 1 ? "text-yellow-400" : r.beta1Y != null && r.beta1Y >= 0 ? "text-green-500" : r.beta1Y != null ? "text-foreground/70" : "text-muted-foreground/40"}`}>{r.beta1Y != null ? r.beta1Y.toFixed(2) : "—"}</td>}
                        {vis("pe") && <td className="p-3 text-right text-foreground/80">{r.pe != null ? r.pe.toFixed(1) : "—"}</td>}
                        {vis("peg") && <td className={`p-3 text-right ${r.peg != null && r.peg < 1 ? "text-green-500" : r.peg != null && r.peg < 2 ? "text-yellow-500" : r.peg != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.peg != null ? r.peg.toFixed(2) : "—"}</td>}
                        {vis("roe") && <td className={`p-3 text-right ${r.roe != null && r.roe > 0 ? "text-green-500" : r.roe != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.roe != null ? `${r.roe.toFixed(1)}%` : "—"}</td>}
                        {vis("evToEbitda") && <td className={`p-3 text-right ${r.evToEbitda != null && r.evToEbitda < 15 ? "text-green-500" : r.evToEbitda != null && r.evToEbitda < 30 ? "text-yellow-500" : r.evToEbitda != null ? "text-foreground/80" : "text-muted-foreground/40"}`}>{r.evToEbitda != null ? r.evToEbitda.toFixed(1) : "—"}</td>}
                        {vis("salesGrowthAnnual") && <td className={`p-3 text-right ${r.salesGrowthAnnual != null && r.salesGrowthAnnual > 0 ? "text-green-500" : r.salesGrowthAnnual != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.salesGrowthAnnual != null ? `${r.salesGrowthAnnual.toFixed(1)}%` : "—"}</td>}
                        {vis("salesCagr3Y") && <td className={`p-3 text-right ${r.salesCagr3Y != null && r.salesCagr3Y > 0 ? "text-green-500" : r.salesCagr3Y != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.salesCagr3Y != null ? `${r.salesCagr3Y.toFixed(1)}%` : "—"}</td>}
                        {vis("salesGrowthQtrYoY") && <td className={`p-3 text-right ${r.salesGrowthQtrYoY != null && r.salesGrowthQtrYoY > 0 ? "text-green-500" : r.salesGrowthQtrYoY != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.salesGrowthQtrYoY != null ? `${r.salesGrowthQtrYoY.toFixed(1)}%` : "—"}</td>}
                        {vis("profitGrowthAnnual") && <td className={`p-3 text-right ${r.profitGrowthAnnual != null && r.profitGrowthAnnual > 0 ? "text-green-500" : r.profitGrowthAnnual != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.profitGrowthAnnual != null ? `${r.profitGrowthAnnual.toFixed(1)}%` : "—"}</td>}
                        {vis("profitGrowthQtrYoY") && <td className={`p-3 text-right ${r.profitGrowthQtrYoY != null && r.profitGrowthQtrYoY > 0 ? "text-green-500" : r.profitGrowthQtrYoY != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.profitGrowthQtrYoY != null ? `${r.profitGrowthQtrYoY.toFixed(1)}%` : "—"}</td>}
                        {vis("opm") && <td className={`p-3 text-right ${r.opm != null && r.opm > 0 ? "text-green-500" : r.opm != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.opm != null ? `${r.opm.toFixed(1)}%` : "—"}</td>}
                        {vis("stockCagr1Y") && <td className={`p-3 text-right ${r.stockCagr1Y != null && r.stockCagr1Y > 0 ? "text-green-500" : r.stockCagr1Y != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.stockCagr1Y != null ? `${r.stockCagr1Y.toFixed(1)}%` : "—"}</td>}
                        {vis("stockCagr3Y") && <td className={`p-3 text-right ${r.stockCagr3Y != null && r.stockCagr3Y > 0 ? "text-green-500" : r.stockCagr3Y != null ? "text-destructive" : "text-muted-foreground/40"}`}>{r.stockCagr3Y != null ? `${r.stockCagr3Y.toFixed(1)}%` : "—"}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Basket Editor Sheet */}
      <Sheet open={basketEditorOpen} onOpenChange={setBasketEditorOpen}>
        <SheetContent side="right" className="w-80 font-mono bg-card border-l border-border flex flex-col p-0">
          <SheetHeader className="p-4 border-b border-border">
            <SheetTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
              <FolderOpen className="w-4 h-4" /> Basket Editor
            </SheetTitle>
          </SheetHeader>

          {editingBasket && (
            <div className="flex flex-col flex-1 overflow-hidden p-4 space-y-4">
              {/* Basket name */}
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Basket Name</Label>
                <div className="flex gap-2">
                  <Input
                    value={editingBasket.name}
                    onChange={e => renameEditingBasket(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => e.key === "Enter" && commitRename()}
                    className="h-8 text-xs bg-muted/50"
                  />
                </div>
              </div>

              <Separator />

              {/* Add symbol */}
              <div className="space-y-2">
                <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">Add Symbol</Label>
                <form
                  onSubmit={e => { e.preventDefault(); addSymbolToBasket(basketAddSymbol); }}
                  className="flex gap-2"
                >
                  <Input
                    value={basketAddSymbol}
                    onChange={e => setBasketAddSymbol(e.target.value)}
                    placeholder="e.g. RELIANCE"
                    className="h-8 text-xs bg-muted/50 uppercase"
                  />
                  <Button type="submit" size="sm" className="h-8 px-3">Add</Button>
                </form>
              </div>

              {/* Symbol list */}
              <div className="space-y-1.5 flex-1 overflow-hidden flex flex-col">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    Symbols
                  </Label>
                  <Badge variant="secondary" className="text-[10px]">{editingBasket.symbols.length}</Badge>
                </div>
                {editingBasket.symbols.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground italic pt-1">No symbols yet — add some above</p>
                ) : (
                  <ScrollArea className="flex-1 border border-border rounded-md">
                    <div className="p-2 space-y-1">
                      {editingBasket.symbols.map(sym => (
                        <div key={sym} className="flex items-center justify-between rounded px-2 py-1 bg-muted/30 hover:bg-muted/60 group transition-colors">
                          <span className="text-xs font-medium">{sym}</span>
                          <button
                            onClick={() => removeSymbolFromBasket(sym)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>

              {/* Load into screener */}
              <Button
                className="w-full font-bold uppercase tracking-wider"
                onClick={() => { loadBasketToScreener(editingBasket); setBasketEditorOpen(false); }}
                disabled={editingBasket.symbols.length === 0}
              >
                <ArrowRightFromLine className="w-4 h-4 mr-2" /> Load into Screener
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Email Jobs Sheet ──────────────────────────────────────── */}
      <Sheet open={emailOpen} onOpenChange={open => { setEmailOpen(open); if (!open) { setEmailView("list"); setEditingJob(null); } }}>
        <SheetContent side="right" className="w-[420px] font-mono bg-card border-l border-border flex flex-col p-0">

          {/* LIST VIEW */}
          {emailView === "list" && (<>
            <SheetHeader className="px-5 py-4 border-b border-border shrink-0 flex flex-row items-center justify-between">
              <SheetTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                <Mail className="w-4 h-4" /> Email Jobs
              </SheetTitle>
              <Button size="sm" className="h-7 text-xs gap-1" onClick={openNewJob}>
                <Plus className="w-3 h-3" /> Add Job
              </Button>
            </SheetHeader>

            <ScrollArea className="flex-1">
              {emailJobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 gap-3 text-center px-6">
                  <Mail className="w-8 h-8 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">No email jobs yet. Add one to schedule automated screener reports.</p>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={openNewJob}>
                    <Plus className="w-3 h-3" /> Add First Job
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {emailJobs.map(job => (
                    <div key={job.id} className="p-4 space-y-2 hover:bg-muted/20 transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${job.enabled ? "bg-green-500" : "bg-muted-foreground/30"}`} />
                          <span className="text-sm font-bold text-foreground truncate">{job.name}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost" size="icon"
                            className="w-7 h-7 text-muted-foreground hover:text-primary"
                            title="Run now"
                            disabled={emailSendingId === job.id}
                            onClick={() => runJobNow(job.id)}
                          >
                            {emailSendingId === job.id
                              ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              : <Send className="w-3.5 h-3.5" />}
                          </Button>
                          <Button variant="ghost" size="icon" className="w-7 h-7 text-muted-foreground hover:text-primary" title="Edit" onClick={() => openEditJob(job)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="w-7 h-7 text-muted-foreground hover:text-destructive" title="Delete" onClick={() => deleteEmailJob(job.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                      <div className="pl-4 space-y-1">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Clock className="w-3 h-3 shrink-0" />
                          <span>{job.scheduleTime} GST</span>
                          <span className="text-border">·</span>
                          <span>{job.frequency === "weekly" && job.weekDay != null ? DAY_FULL[job.weekDay] : "daily"}</span>
                          <span className="text-border">·</span>
                          <span>{job.symbols.length} symbols</span>
                          {job.basketLabel && <><span className="text-border">·</span><span className="text-primary/70 truncate max-w-[100px]">{job.basketLabel}</span></>}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Mail className="w-3 h-3 shrink-0" />
                          <span className="truncate">{job.emails.join(", ") || "—"}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>

            <div className="px-5 py-3 border-t border-border shrink-0">
              <p className="text-[10px] text-muted-foreground">CSV attachment included with every send. Server must stay running for scheduled emails.</p>
            </div>
          </>)}

          {/* EDITOR VIEW */}
          {emailView === "editor" && editingJob && (<>
            <SheetHeader className="px-5 py-4 border-b border-border shrink-0">
              <SheetTitle className="text-sm font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                <button onClick={() => { setEmailView("list"); setEditingJob(null); }} className="text-muted-foreground hover:text-foreground mr-1">←</button>
                {editingJob.id ? "Edit Job" : "New Job"}
              </SheetTitle>
            </SheetHeader>

            <ScrollArea className="flex-1">
              <div className="p-5 space-y-5">
                {/* Name */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Job Name</Label>
                  <Input
                    placeholder="Daily Nifty 50 Report"
                    value={editingJob.name}
                    onChange={e => setEditingJob(j => j ? { ...j, name: e.target.value } : j)}
                    className="h-9 text-xs bg-muted/50"
                  />
                </div>

                {/* Basket */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Basket / Symbols</Label>
                  <Select value={editingJob.basketKey} onValueChange={v => setEditingJob(j => j ? { ...j, basketKey: v } : j)}>
                    <SelectTrigger className="h-9 text-xs bg-muted/50">
                      <SelectValue placeholder="Select basket…" />
                    </SelectTrigger>
                    <SelectContent className="font-mono text-xs">
                      <SelectItem value="__current__">Current symbols ({symbols.length})</SelectItem>
                      {(presetsData?.presets ?? []).length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          {(presetsData?.presets ?? []).map(p => (
                            <SelectItem key={`preset:${p.name}`} value={`preset:${p.name}`}>{p.name} ({p.symbols.length})</SelectItem>
                          ))}
                        </>
                      )}
                      {baskets.length > 0 && (
                        <>
                          <DropdownMenuSeparator />
                          {baskets.map(b => (
                            <SelectItem key={`basket:${b.id}`} value={`basket:${b.id}`}>{b.name} ({b.symbols.length})</SelectItem>
                          ))}
                        </>
                      )}
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">
                    {resolveBasket(editingJob.basketKey).symbols.length} symbols will be screened
                  </p>
                </div>

                {/* Emails */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Recipients</Label>
                  <Input
                    placeholder="you@example.com, other@example.com"
                    value={editingJob.emailsStr}
                    onChange={e => setEditingJob(j => j ? { ...j, emailsStr: e.target.value } : j)}
                    className="h-9 text-xs bg-muted/50 font-mono"
                  />
                  <p className="text-[10px] text-muted-foreground">Comma-separated</p>
                </div>

                {/* Subject */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Email Subject</Label>
                  <Input
                    placeholder={`${editingJob.name || "Job name"} — {date} ({N} stocks)`}
                    value={editingJob.subject}
                    onChange={e => setEditingJob(j => j ? { ...j, subject: e.target.value } : j)}
                    className="h-9 text-xs bg-muted/50"
                  />
                  <p className="text-[10px] text-muted-foreground">Leave blank to use the default subject</p>
                </div>

                {/* Body note */}
                <div className="space-y-1.5">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Email Body Note</Label>
                  <textarea
                    rows={3}
                    placeholder="Optional note shown at the top of the email…"
                    value={editingJob.bodyNote}
                    onChange={e => setEditingJob(j => j ? { ...j, bodyNote: e.target.value } : j)}
                    className="w-full rounded-md border border-input bg-muted/50 px-3 py-2 text-xs font-mono resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                </div>

                {/* Schedule */}
                <div className="space-y-3">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Clock className="w-3 h-3" /> Schedule (GST)
                  </Label>

                  {/* Frequency toggle */}
                  <div className="flex gap-1.5">
                    {(["daily", "weekly"] as const).map(freq => (
                      <button
                        key={freq}
                        onClick={() => setEditingJob(j => j ? { ...j, frequency: freq } : j)}
                        className={`flex-1 h-8 rounded text-xs font-medium border transition-colors capitalize
                          ${editingJob.frequency === freq
                            ? "bg-primary/20 border-primary/50 text-primary"
                            : "bg-muted/40 border-border text-muted-foreground hover:text-foreground"}`}
                      >
                        {freq}
                      </button>
                    ))}
                  </div>

                  {/* Day picker — weekly only */}
                  {editingJob.frequency === "weekly" && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] text-muted-foreground">Select day of week</p>
                      <div className="flex gap-1">
                        {DAY_LABELS.map((label, idx) => (
                          <button
                            key={idx}
                            onClick={() => setEditingJob(j => j ? { ...j, weekDay: idx } : j)}
                            className={`flex-1 h-7 rounded text-[10px] font-medium border transition-colors
                              ${editingJob.weekDay === idx
                                ? "bg-primary/20 border-primary/50 text-primary"
                                : "bg-muted/40 border-border text-muted-foreground hover:text-foreground"}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Time */}
                  <div className="flex items-center gap-3">
                    <Input
                      type="time"
                      value={editingJob.scheduleTime}
                      onChange={e => setEditingJob(j => j ? { ...j, scheduleTime: e.target.value } : j)}
                      className="h-9 text-xs bg-muted/50 w-32"
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {editingJob.frequency === "weekly"
                        ? `Every ${DAY_FULL[editingJob.weekDay]} at ${editingJob.scheduleTime} GST`
                        : `Every day at ${editingJob.scheduleTime} GST`}
                    </span>
                  </div>
                </div>

                {/* Enabled */}
                <div className="flex items-center justify-between py-1">
                  <div>
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Enabled</Label>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {editingJob.frequency === "weekly"
                        ? `Run every ${DAY_FULL[editingJob.weekDay]} at scheduled time`
                        : "Run every day at scheduled time"}
                    </p>
                  </div>
                  <Switch
                    checked={editingJob.enabled}
                    onCheckedChange={v => setEditingJob(j => j ? { ...j, enabled: v } : j)}
                  />
                </div>

                <div className="rounded border border-border bg-muted/20 p-3 text-[10px] text-muted-foreground space-y-1">
                  <p>Screener runs fresh before every send. Results delivered as <span className="text-primary">CSV attachment</span> + top-10 summary in the email body.</p>
                </div>
              </div>
            </ScrollArea>

            <div className="px-5 py-4 border-t border-border shrink-0 flex gap-2">
              <Button variant="outline" size="sm" className="flex-1 h-9 text-xs" onClick={() => { setEmailView("list"); setEditingJob(null); }}>
                Cancel
              </Button>
              <Button size="sm" className="flex-1 h-9 text-xs gap-1.5" onClick={saveJob} disabled={emailJobSaving || !editingJob.name.trim()}>
                {emailJobSaving ? <><RefreshCw className="w-3 h-3 animate-spin" />Saving…</> : "Save Job"}
              </Button>
            </div>
          </>)}

        </SheetContent>
      </Sheet>
    </div>
  );
}
