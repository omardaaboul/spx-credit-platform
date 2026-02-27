import type { AlertItem, CandidateCard, DashboardPayload } from "@/lib/spx0dte";
import type { VolClassificationResult, VolFeatureConfidence } from "@/lib/volatility/volRegime";
import type { VolPolicyResult } from "@/lib/policy/volPolicy";
import type { VolShockResult } from "@/lib/volatility/volShock";

export type DataMode = "LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE";
export type SessionState = "OPEN" | "CLOSED";
export type DecisionStatus = "READY" | "BLOCKED" | "NO_CANDIDATE" | "DEGRADED";
export type DecisionMode = "STRICT" | "PROBABILISTIC";

export type DecisionCode =
  | "MARKET_CLOSED"
  | "SIMULATION_ACTIVE"
  | "ALERTS_SUPPRESSED_SIMULATION"
  | "SPOT_STALE"
  | "CHAIN_STALE"
  | "GREEKS_STALE"
  | "DATA_STALE_SPOT"
  | "DATA_STALE_CHAIN"
  | "DATA_STALE_GREEKS"
  | "DATA_INCOMPLETE"
  | "FEATURE_0DTE_DISABLED"
  | "NO_DTE_BUCKET_RESOLUTION"
  | "MISSING_EXPIRY_FOR_BUCKET"
  | "REGIME_UNCLASSIFIED"
  | "NO_CREDIT_SPREAD_CANDIDATE"
  | "HARD_GATES_NOT_MET"
  | "INVALID_SPREAD_GEOMETRY"
  | "CANDIDATE_READY_DEBOUNCED"
  | "ALERT_COOLDOWN_ACTIVE"
  | "ALERT_DAY_CAP_REACHED"
  | "ALERT_DEDUPED"
  | "ALERTS_DISABLED"
  | "DATA_MODE_NOT_LIVE"
  | "POP_TOO_LOW"
  | "POP_UNAVAILABLE"
  | "ROR_TOO_LOW"
  | "CREDIT_PCT_TOO_LOW"
  | "ALERTS_NO_CANDIDATE"
  | "SOFT_LIQUIDITY_WARNING"
  | "SOFT_SLIPPAGE_WARNING"
  | "DELTA_OUT_OF_BAND"
  | "SD_MULTIPLE_LOW"
  | "MMC_GATE_FAIL"
  | "SR_BUFFER_THIN"
  | "TREND_MISMATCH"
  | "LOW_CREDIT_EFFICIENCY"
  | "HIGH_GAMMA_RISK"
  | "VOL_REGIME_UNKNOWN"
  | "VOL_CACHE_INSUFFICIENT"
  | "VOL_SHOCK"
  | "VOL_SHOCK_WARN"
  | "VOL_POLICY_BUCKET_DISABLED";

export type DecisionReason = {
  code: DecisionCode;
  message: string;
  details?: Record<string, unknown>;
};

export type DecisionStage =
  | "preflight"
  | "volatility_regime"
  | "dte_bucket_resolver"
  | "regime_classifier"
  | "candidate_generator"
  | "hard_gates"
  | "soft_warnings"
  | "deterministic_ranker"
  | "alert_policy";

export type StageStatus = "PASS" | "BLOCK" | "NO_CANDIDATE";

export type DecisionStageResult = {
  stage: DecisionStage;
  status: StageStatus;
  reasons: DecisionReason[];
  details?: Record<string, unknown>;
};

export type FreshnessAgesMs = {
  spot: number | null;
  chain: number | null;
  greeks: number | null;
  candles: number | null;
};

export type FreshnessPolicySec = {
  spot_max_age_s: number;
  chain_max_age_s: number;
  greeks_max_age_s: number;
};

export type DteBucketResolution = {
  targetDte: number;
  selectedDte: number | null;
  expiration: string | null;
  distance: number | null;
};

export type RankedCandidate = {
  candidateId: string;
  strategy: string;
  rank: number;
  score: {
    deltaMidpointFit: number;
    creditWidth: number;
    gammaPenalty: number;
    pop?: number;
    ror?: number;
    evRor?: number;
  };
  candidate: CandidateCard;
};

export type DecisionDebug = {
  runId: string;
  asOfIso: string;
  source: string;
  dataMode: DataMode;
  decisionMode: DecisionMode;
  freshnessAges: FreshnessAgesMs;
  freshnessPolicy: FreshnessPolicySec;
  session: SessionState;
  simulationMode: boolean;
  strictLiveBlocks: boolean;
  feature0dte: boolean;
  vol: {
    inputsUsed: Record<string, unknown>;
    missingInputs: string[];
    lookbackDays: number;
    sampleCount: number;
    thresholdsApplied: Record<string, unknown>;
    regime: VolClassificationResult["regime"];
    confidence: VolFeatureConfidence;
    shockFlag: boolean;
  };
  stages: DecisionStageResult[];
};

export type DecisionInput = {
  asOfIso: string;
  source: string;
  dataMode: DataMode;
  session: SessionState;
  simulationMode: boolean;
  allowSimAlerts: boolean;
  strictLiveBlocks: boolean;
  decisionMode: DecisionMode;
  feature0dte: boolean;
  freshnessAges: FreshnessAgesMs;
  freshnessPolicy: FreshnessPolicySec;
  regime: string | null;
  warnings: string[];
  candidates: CandidateCard[];
  strategyEligibility: NonNullable<DashboardPayload["strategyEligibility"]>;
  multiDteTargets: NonNullable<NonNullable<DashboardPayload["multiDte"]>["targets"]>;
  alerts: AlertItem[];
  evaluationTick?: DashboardPayload["evaluation"];
  volPolicy?: VolPolicyResult;
  vol: {
    spot: number | null;
    iv_atm: number | null;
    iv_term?: Record<number, number | null>;
    realized_range_proxy?: number | null;
    vix?: number | null;
    prevSpot?: number | null;
    prevVix?: number | null;
    samples?: Array<{ tsIso: string; iv_atm: number }>;
    freshnessAges?: {
      spot?: number | null;
      iv_atm?: number | null;
      vix?: number | null;
      realized?: number | null;
    };
  };
};

export type DecisionOutput = {
  status: DecisionStatus;
  decisionMode: DecisionMode;
  blocks: DecisionReason[];
  warnings: DecisionReason[];
  vol: {
    regime: VolClassificationResult["regime"];
    confidence: VolFeatureConfidence;
    features: VolClassificationResult["features"];
    warnings: string[];
    shock: VolShockResult;
    policy: VolPolicyResult;
  };
  candidates: CandidateCard[];
  ranked: RankedCandidate[];
  primaryCandidateId: string | null;
  dteBuckets: DteBucketResolution[];
  debug: DecisionDebug;
};
