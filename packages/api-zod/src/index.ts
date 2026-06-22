import * as zod from "zod";

export const HealthCheckResponse = zod.object({ status: zod.string() });

export const RunScreenBody = zod.object({
  symbols: zod.array(zod.string()).min(1),
  config: zod.object({
    lookbackDays: zod.number().default(90),
    minHistoryDays: zod.number().default(60),
    rocPeriod: zod.number().default(20),
    rsiPeriod: zod.number().default(14),
    adxPeriod: zod.number().default(14),
    macdFast: zod.number().default(12),
    macdSlow: zod.number().default(26),
    macdSignal: zod.number().default(9),
    obvLookback: zod.number().default(20),
    accelRocPeriod: zod.number().default(10),
    accelDiffPeriod: zod.number().default(5),
    twoWeekOffset: zod.number().default(10),
    weightRoc: zod.number().default(0.35),
    weightMacd: zod.number().default(0.25),
    weightObv: zod.number().default(0.20),
    weightRsi: zod.number().default(0.20),
    useSyntheticData: zod.boolean().default(false),
  }).optional(),
});

export type StockScore = {
  symbol: string;
  compositeScoreCurrent: number;
  compositeScore2WAgo: number;
  compositeScoreChange: number;
  rocCurrent: number; roc2WAgo: number; rocDiff?: number | null;
  zRocCurrent: number; zRoc2WAgo: number;
  macdCurrent: number; macd2WAgo: number;
  zMacdCurrent: number; zMacd2WAgo: number;
  obvCurrent: number; obv2WAgo: number; obvDiff?: number | null;
  zObvCurrent: number; zObv2WAgo: number;
  rsiCurrent: number; rsi2WAgo: number; rsiDiff?: number | null;
  adxCurrent: number; adx2WAgo: number; adxDiff?: number | null;
  supertrendBullish: boolean; supertrendValue: number; emaRank: number;
  pe?: number | null; conviction?: string;
  technicalGrade?: string; technicalScore?: number;
  vqGrade?: string; vqScore?: number | null; vqFlags?: string;
  roe?: number | null; roa?: number | null; evToEbitda?: number | null;
  salesGrowthAnnual?: number | null; salesCagr3Y?: number | null;
  salesGrowthQtrYoY?: number | null; profitGrowthAnnual?: number | null;
  profitGrowthQtrYoY?: number | null; opm?: number | null;
  stockCagr1Y?: number | null; stockCagr3Y?: number | null;
  cmfCurrent?: number | null; highPct52w?: number | null; lowPct52w?: number | null;
  rsVsNifty?: number | null; volRatio?: number | null; atrPct?: number | null;
  bbPctB?: number | null; bbPctB2W?: number | null; beta1Y?: number | null;
  sector?: string | null; latestQuarterDate?: string | null;
  bearishDivergence?: boolean | null; techFlags?: string | null;
  epsAcceleration?: boolean | null; peg?: number | null;
  scoreSubA?: number | null; scoreSubB?: number | null; scoreSubC?: number | null;
  dateCurrent: string; date2WAgo: string;
};

export type ScreenerConfig = {
  lookbackDays?: number; minHistoryDays?: number; rocPeriod?: number;
  rsiPeriod?: number; adxPeriod?: number; macdFast?: number;
  macdSlow?: number; macdSignal?: number; obvLookback?: number;
  accelRocPeriod?: number; accelDiffPeriod?: number; twoWeekOffset?: number;
  weightRoc?: number; weightMacd?: number; weightObv?: number; weightRsi?: number;
  useSyntheticData?: boolean;
};
