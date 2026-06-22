export type { StockScore, ScreenerConfig } from "@nse/api-zod";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { StockScore } from "@nse/api-zod";

const BASE = "/api";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export type PresetList = { presets: { name: string; symbols: string[] }[] };
export type RunSnapshot = { id: number; runDate: string; scoredAt: string; symbolCount: number; results: StockScore[] };

export function useGetPresets() {
  return useQuery<PresetList>({
    queryKey: ["presets"],
    queryFn: () => apiFetch<PresetList>("/presets"),
  });
}

export function useGetRunHistory(params: { days: number }) {
  return useQuery<RunSnapshot[]>({
    queryKey: ["run-history", params.days],
    queryFn: () => apiFetch<RunSnapshot[]>(`/screener/runs?days=${params.days}`),
  });
}

export function useSaveRunSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { runDate: string; results: StockScore[] }) =>
      apiFetch<RunSnapshot>("/screener/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["run-history"] }),
  });
}
