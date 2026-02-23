import type { DecisionOutput } from "@/lib/contracts/decision";

export type Strategy =
  | "Iron Condor"
  | "Iron Fly"
  | "Directional Spread"
  | "Convex Debit Spread"
  | "2-DTE Credit Spread"
  | "7-DTE Credit Spread"
  | "14-DTE Credit Spread"
  | "30-DTE Credit Spread"
  | "45-DTE Credit Spread"
  | "Broken-Wing Put Butterfly";
export type AlertType = "ENTRY" | "EXIT";
export type Severity = "good" | "caution" | "risk";
export type ChecklistStatus = "pass" | "fail" | "blocked" | "na";

export type OptionLeg = {
  action: "BUY" | "SELL";
  type: "PUT" | "CALL";
  strike: number;
  delta: number;
  premium?: number | null;
  qty?: number;
  impliedVol?: number | null;
  symbol?: string;
};

export type StrategyCriterion = {
  name: string;
  passed: boolean;
  detail?: string;
};

export type ChecklistItem = {
  id?: string;
  label?: string;
  name: string;
  status: ChecklistStatus;
  detail?: string;
  reason?: string;
  observed?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  requires?: string[];
  dataAgeMs?: Record<string, number | null>;
  required?: boolean;
};

export type StrategyChecklist = {
  global: ChecklistItem[];
  regime: ChecklistItem[];
  strategy: ChecklistItem[];
};

export type AlertItem = {
  id: string;
  type: AlertType;
  strategy: Strategy;
  timeEt: string;
  spot: number;
  legs: OptionLeg[];
  credit: number | null;
  debit: number | null;
  plPct: number | null;
  popPct: number | null;
  spreadType?: string | null;
  expiry?: string | null;
  targetDte?: number | null;
  selectedDte?: number | null;
  reason: string;
  severity: Severity;
  checklistSummary?: string;
};

export type MetricSnapshot = {
  spx: number;
  emr: number;
  vix: number;
  vwap: number;
  range15mPctEm: number;
  atr1m: number;
  putCallRatio: number | null;
  iv: number;
};

export type CandidateCard = {
  candidateId?: string;
  strategy: Strategy;
  ready: boolean;
  width: number;
  credit: number;
  premium?: number;
  riskImpact?: number;
  adjustedPremium?: number;
  premiumLabel?: "Credit" | "Debit";
  execution?: {
    mid: number;
    adjusted: number;
    slippage: number;
    confidence: "high" | "medium" | "low";
    timeBucket?: "open" | "midday" | "late" | "close";
    timeMultiplier?: number;
    notes?: string;
  };
  maxRisk: number;
  popPct: number;
  reason: string;
  legs: OptionLeg[];
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    iv?: number;
    lastUpdated?: string;
  };
  daysToExpiry?: number;
  bidAskSpread?: number;
  checklist?: StrategyChecklist;
  blockedReason?: string;
  criteria?: StrategyCriterion[];
};

export type OpenTrade = {
  id: string;
  strategy: Strategy;
  entryEt: string;
  spot: number;
  legs: OptionLeg[];
  initialCredit: number;
  currentDebit: number;
  plPct: number;
  popPct: number;
  status: "OPEN" | "EXIT_PENDING" | "CLOSED";
  nextReason: string;
};

export type PricePoint = {
  t: string;
  price: number;
  vwap: number;
};

export type VolPoint = {
  t: string;
  emr: number;
  rangePctEm: number;
  atr: number;
};

export type DashboardPayload = {
  generatedAtEt: string;
  generatedAtParis: string;
  data_mode?: "LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE";
  data_age_ms?: {
    spot: number | null;
    candles: number | null;
    chain: number | null;
    greeks: number | null;
  };
  market_closed_override?: boolean;
  market: {
    isOpen: boolean;
    hoursEt: string;
    source: string;
    telegramEnabled: boolean;
  };
  staleData?: {
    active: boolean;
    ageSeconds: number | null;
    thresholdSeconds: number;
    detail: string;
  };
  dataFeeds?: Record<
    string,
    {
      value?: unknown;
      timestampIso?: string | null;
      source?: string;
      error?: string | null;
    }
  >;
  dataContract?: {
    status: "healthy" | "degraded" | "inactive";
    checkedAtIso: string;
    checkedAtEt?: string;
    issues: string[];
    feeds: Record<
      string,
      {
        key: string;
        label: string;
        maxAgeMs: number;
        source: string;
        ageMs: number | null;
        isValid: boolean;
        error?: string;
      }
    >;
  };
  metrics: MetricSnapshot;
  candidates: CandidateCard[];
  globalChecklist?: ChecklistItem[];
  regimeSummary?: {
    regime: string;
    favoredStrategy: string;
    reason: string;
    confidencePct?: number;
    confidenceTier?: "high" | "medium" | "low" | string;
    trendDirection?: string;
    trendAlignmentScore?: number;
  };
  upcomingMacroEvents?: Array<{
    date: string;
    timeEt: string;
    name: string;
    daysOut: number;
    inMarketHours: boolean;
    info?: string;
    url?: string;
    eventType?: string;
    impact?: "Low" | "Medium" | "High" | string;
  }>;
  macroCalendarStatus?: {
    updatedAtUtc: string | null;
    ageHours: number | null;
    stale: boolean;
    detail: string;
  };
  strategyEligibility?: Array<{
    strategy: Strategy;
    status: ChecklistStatus;
    reason: string;
  }>;
  alerts: AlertItem[];
  openTrades: OpenTrade[];
  priceSeries: PricePoint[];
  volSeries: VolPoint[];
  warnings?: string[];
  sleeveSettings?: {
    sleeveCapital: number;
    totalAccount: number;
    maxDrawdownPct: number;
    dailyRealizedPnl: number;
    weeklyRealizedPnl: number;
    dailyLock: boolean;
    weeklyLock: boolean;
  };
  sleeveLimits?: {
    maxRiskPerTrade: number;
    maxOpenRisk: number;
    maxDailyLoss: number;
    maxWeeklyLoss: number;
  };
  startupHealth?: {
    telegram: {
      ok: boolean;
      label: string;
      detail: string;
    };
    tastySdk: {
      ok: boolean;
      label: string;
      detail: string;
    };
    tastyCredentials: {
      ok: boolean;
      label: string;
      detail: string;
    };
  };
  executionModel?: {
    settings?: {
      enabled: boolean;
      narrowWidthCutoff: number;
      creditOffsetNarrow: number;
      creditOffsetWide: number;
      debitOffsetNarrow: number;
      debitOffsetWide: number;
      markImpactPct: number;
      openBucketMultiplier?: number;
      midBucketMultiplier?: number;
      lateBucketMultiplier?: number;
      closeBucketMultiplier?: number;
    };
    byStrategy: Array<{
      strategy: Strategy;
      creditOffset: number;
      debitOffset: number;
      markImpactPct: number;
      timeBucket?: "open" | "midday" | "late" | "close";
      timeMultiplier?: number;
    }>;
  };
  alertPolicy?: {
    cooldownSecondsByStrategy: Record<string, number>;
    maxAlertsPerDayByStrategy: Record<string, number>;
  };
  alertPolicyState?: {
    dateEt: string;
    byStrategy: Record<
      string,
      {
        sentToday: number;
        cooldownRemainingSec: number;
      }
    >;
    suppressedCount: number;
  };
  evaluation?: {
    tickId: number;
    intervalMs: number;
    debounceTicks: number;
    checkedAtIso: string;
  };
  openRiskHeatmap?: {
    totalRiskDollars: number;
    bySide: Array<{ side: "bullish" | "bearish" | "neutral"; riskDollars: number }>;
    byStrategy: Array<{ strategy: Strategy; side: "bullish" | "bearish" | "neutral"; riskDollars: number }>;
  };
  analyticsScorecard?: {
    sampleSize: number;
    byStrategy: Array<{
      strategy: Strategy;
      trades: number;
      winRatePct: number;
      expectancyPct: number;
    }>;
    byRegime: Array<{
      regime: string;
      trades: number;
      winRatePct: number;
      expectancyPct: number;
    }>;
    byMacroTag: Array<{
      macroTag: string;
      trades: number;
      expectancyPct: number;
    }>;
    byVolTag: Array<{
      volTag: string;
      trades: number;
      expectancyPct: number;
    }>;
  };
  replaySummary?: Record<string, unknown>;
  replayWalkForward?: {
    rowsAnalyzed: number;
    windowSize: number;
    stepSize: number;
    windows: Array<{
      index: number;
      startTsIso: string;
      endTsIso: string;
      sampleCount: number;
      entryAlerts: number;
      exitAlerts: number;
      readyRatePct: number;
      favoredStrategy: string;
    }>;
  };
  preflight?: {
    go: boolean;
    checkedAtEt: string;
    checkedAtParis: string;
    checks: Array<{ name: string; status: "pass" | "fail" | "blocked" | "na"; detail: string }>;
  };
  strategyMode?: {
    longerTimeframesOnly: boolean;
    pausedStrategies: Strategy[];
    allowedStrategies: Strategy[];
    reason: string;
  };
  multiDteSettings?: {
    minDelta: number;
    maxDelta: number;
    minIV: number;
    maxBidAskSpread: number;
    dataFreshnessThreshold: number;
    requireGreeksValidation: boolean;
    dteThresholds: Record<string, { minPremium: number }>;
  };
  twoDte?: {
    ready: boolean;
    reason: string;
    checklist: ChecklistItem[];
    recommendation?: {
      type: string;
      right: "CALL" | "PUT";
      expiry: string;
      short_strike: number;
      long_strike: number;
      short_symbol?: string;
      long_symbol?: string;
      short_delta: number;
      long_delta: number | null;
      distance_points: number;
      width: number;
      credit: number;
      max_loss_points: number;
      max_loss_dollars: number;
      stop_debit: number;
      liquidity_ratio: number;
      profit_take_debit: number;
      delta_stop: number | null;
      use_delta_stop: boolean;
      legs: OptionLeg[];
    } | null;
    metrics?: Record<string, number | string | null>;
    settings?: Record<string, number | boolean>;
    openTrades?: Array<Record<string, unknown>>;
    executionMode?: {
      paperEnabled: boolean;
      paperReady: boolean;
      paperDryRun: boolean;
      detail: string;
    };
  };
  multiDte?: {
    targets: Array<{
      strategy_label: Strategy;
      target_dte: number;
      selected_dte: number | null;
      expiration: string | null;
      ready: boolean;
      reason: string;
      checklist: ChecklistItem[];
      recommendation?: {
        type: string;
        right: "CALL" | "PUT";
        expiry: string;
        short_strike: number;
        long_strike: number;
        short_symbol?: string;
        long_symbol?: string;
        short_delta: number;
        long_delta: number | null;
        distance_points: number;
        width: number;
        credit: number;
        max_loss_points: number;
        max_loss_dollars: number;
        stop_debit: number;
        liquidity_ratio: number;
        profit_take_debit: number;
        delta_stop: number | null;
        use_delta_stop: boolean;
        legs: OptionLeg[];
        target_dte?: number;
        selected_dte?: number | null;
      } | null;
      metrics?: Record<string, number | string | null>;
    }>;
  };
  bwb?: {
    ready: boolean;
    reason: string;
    checklist: ChecklistItem[];
    recommendation?: Record<string, unknown> | null;
    metrics?: Record<string, number | string | null>;
    settings?: Record<string, number | boolean | string>;
    openPosition?: Record<string, unknown> | null;
    monitor?: Record<string, number | string | boolean | null>;
  };
  decision?: DecisionOutput;
  tradeMemory?: {
    candidateSync?: {
      inserted: number;
      updated: number;
      invalidated: number;
      expired: number;
      activeIds: string[];
    };
    markSync?: {
      updated: number;
    };
  };
};

export function formatOptionLegLine(leg: OptionLeg): string {
  const verb = leg.action === "SELL" ? "Sell" : "Buy";
  const deltaSign = leg.delta >= 0 ? "+" : "";
  return `${verb} 1 ${leg.type} ${Math.round(leg.strike)} (Δ ${deltaSign}${leg.delta.toFixed(2)})`;
}

export function severityDotClass(severity: Severity): string {
  if (severity === "good") return "bg-emerald-500";
  if (severity === "caution") return "bg-amber-500";
  return "bg-rose-500";
}

export function statusTone(plPct: number): Severity {
  if (plPct >= 0.5) return "good";
  if (plPct >= 0.2) return "caution";
  return "risk";
}
