import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import type { AlertItem, DashboardPayload, OpenTrade, OptionLeg, Strategy } from "@/lib/spx0dte";
import type { DecisionInput } from "@/lib/contracts/decision";
import { applyDataContractToRows, evaluateDataContract } from "@/lib/dataContract";
import { evaluateDecision } from "@/lib/engine/evaluate";
import { resolveDataMode } from "@/lib/engine/dataMode";
import { recordIvSample } from "@/lib/data/ivCache";
import {
  allowSimAlertsEnabled,
  feature0dteEnabled,
  simulationModeEnabled,
  tastyCredentialsPresent,
  telegramChatId,
  telegramConfigured,
  telegramToken,
} from "@/lib/server/runtimeEnv";
import {
  acceptCandidateAsTrade,
  recordAlertSentEvent,
  upsertCandidatesFromDashboard,
  updateOpenTradeMarksFromDashboard,
} from "@/lib/server/tradeMemory";

export const dynamic = "force-dynamic";

const MARKET_HOURS_ET = "09:30-16:00 ET (Mon-Fri)";
const TELEGRAM_STATE_PATH =
  process.env.SPX0DTE_TELEGRAM_STATE_PATH ||
  path.join(process.env.HOME || "/tmp", ".spx0dte_telegram_state.json");
const PY_SNAPSHOT_SCRIPT = path.join(process.cwd(), "scripts", "spx0dte_snapshot.py");
const PY_BACKTEST_SCRIPT = path.join(process.cwd(), "scripts", "backtest_10y.py");
const PAPER_ORDER_SCRIPT = path.join(process.cwd(), "scripts", "paper_two_dte_order.py");
const PAPER_PRIMARY_ORDER_SCRIPT = path.join(process.cwd(), "scripts", "paper_primary_order.py");
const SLEEVE_SETTINGS_PATH = path.join(process.cwd(), "storage", ".sleeve_settings.json");
const MACRO_EVENTS_PATH = path.join(process.cwd(), "storage", "macro_events.json");
const TWO_DTE_SETTINGS_PATH = path.join(process.cwd(), "storage", ".two_dte_settings.json");
const MULTI_DTE_SETTINGS_PATH = path.join(process.cwd(), "storage", ".multi_dte_settings.json");
const TWO_DTE_STATE_PATH = path.join(process.cwd(), "storage", ".two_dte_state.json");
const BWB_SETTINGS_PATH = path.join(process.cwd(), "storage", ".bwb_settings.json");
const BWB_STATE_PATH = path.join(process.cwd(), "storage", ".bwb_state.json");
const BWB_LOG_PATH = path.join(process.cwd(), "storage", "bwb_trade_log.jsonl");
const SNAPSHOT_LOG_PATH = path.join(process.cwd(), "storage", "spx0dte_snapshot_log.jsonl");
const LAST_CHART_SERIES_PATH = path.join(process.cwd(), "storage", ".last_spx_chart_series.json");
const ALERT_ACK_STATE_PATH = path.join(process.cwd(), "storage", ".alert_ack_state.json");
const EXECUTION_MODEL_PATH = path.join(process.cwd(), "storage", ".execution_model.json");
const ALERT_POLICY_PATH = path.join(process.cwd(), "storage", ".alert_policy.json");
const ALERT_POLICY_STATE_PATH = path.join(process.cwd(), "storage", ".alert_policy_state.json");
const PRECHECK_STATE_PATH = path.join(process.cwd(), "storage", ".preflight_state.json");
const SYSTEM_ALERT_STATE_PATH = path.join(process.cwd(), "storage", ".system_alert_state.json");
const PROVIDER_HEALTH_STATE_PATH = path.join(process.cwd(), "storage", ".provider_health_state.json");
const ENTRY_DEBOUNCE_STATE_PATH = path.join(process.cwd(), "storage", ".entry_debounce_state.json");
const EVALUATION_STATE_PATH = path.join(process.cwd(), "storage", ".evaluation_state.json");
const DEBUG_MODE = String(process.env.SPX0DTE_DEBUG || "false").toLowerCase() === "true";
const SIMULATION_MODE = simulationModeEnabled();
const ALLOW_SIM_ALERTS = allowSimAlertsEnabled();
const STRICT_LIVE_BLOCKS = String(process.env.STRICT_LIVE_BLOCKS ?? "false").toLowerCase() !== "false";
const ENABLE_SYSTEM_HEALTH_ALERTS =
  String(process.env.SPX0DTE_ENABLE_SYSTEM_HEALTH_ALERTS ?? "false").toLowerCase() !== "false";
const ENABLE_GATE_NOTICE_ALERTS =
  String(process.env.SPX0DTE_ENABLE_GATE_NOTICE_ALERTS ?? "false").toLowerCase() !== "false";
const ENABLE_MACRO_ALERTS =
  String(process.env.SPX0DTE_ENABLE_MACRO_ALERTS ?? "true").toLowerCase() !== "false";
const FEATURE_0DTE = feature0dteEnabled();

type TelegramDedupeState = {
  sent_ids: string[];
};

type SystemAlertState = {
  lastStaleDetail?: string;
  lastStaleSentAtIso?: string;
  staleActivePreviously?: boolean;
  lastDegradedIssueKey?: string;
  lastDegradedSentAtIso?: string;
  degradedActivePreviously?: boolean;
  lastGateNoticeKey?: string;
  lastGateNoticeSentAtIso?: string;
  gateNoticeActivePreviously?: boolean;
  lastMacroBlockKey?: string;
  lastMacroBlockSentAtIso?: string;
  macroBlockActivePreviously?: boolean;
  lastMacroNoticeDailyKey?: string;
};

type EntryDebounceState = {
  updatedAtIso: string;
  byKey: Record<
    string,
    {
      consecutiveReady: number;
      lastReady: boolean;
      lastSeenIso: string;
    }
  >;
};

type EvaluationRuntimeState = {
  tickId: number;
  lastTickIso: string;
};

type ProviderHealthState = {
  provider_status: "tastytrade-live" | "tastytrade-partial" | "down";
  auth_status: "ok" | "refreshing" | "failed";
  last_auth_ok_ts: string | null;
  updated_at: string;
  issue_codes: string[];
  source?: string;
};

type AlertAckState = {
  entries: Array<{
    fingerprint: string;
    material_key: string;
    acked_at_iso: string;
  }>;
};

type SymbolBucket = "dte0" | "dte2" | "bwb";

type ExecutionModelSettings = {
  enabled: boolean;
  narrowWidthCutoff: number;
  creditOffsetNarrow: number;
  creditOffsetWide: number;
  debitOffsetNarrow: number;
  debitOffsetWide: number;
  markImpactPct: number;
  openBucketMultiplier: number;
  midBucketMultiplier: number;
  lateBucketMultiplier: number;
  closeBucketMultiplier: number;
};

type AlertPolicySettings = {
  cooldownSecondsByStrategy: Record<string, number>;
  maxAlertsPerDayByStrategy: Record<string, number>;
};

type AlertPolicyRuntimeState = {
  dateEt: string;
  byStrategy: Record<
    string,
    {
      sentToday: number;
      lastSentIso?: string;
      lastAlertId?: string;
    }
  >;
};

type BwbSettings = {
  enabled: boolean;
  target_dte: number;
  min_dte: number;
  max_dte: number;
  iv_rank_threshold: number;
  short_delta_min: number;
  short_delta_max: number;
  near_long_delta_target: number;
  near_long_delta_tolerance: number;
  far_long_delta_max: number;
  narrow_wing_min: number;
  narrow_wing_max: number;
  wide_to_narrow_min_ratio: number;
  min_credit_per_narrow: number;
  max_risk_pct_account: number;
  max_total_margin_pct_account: number;
  profit_take_credit_frac: number;
  profit_take_width_frac: number;
  stop_loss_credit_frac: number;
  exit_dte: number;
  delta_alert_threshold: number;
  gamma_alert_threshold: number;
  allow_adjustments: boolean;
  adjustment_mode: "NONE" | "ROLL" | "CONVERT_VERTICAL";
};

type BwbPosition = {
  id: string;
  strategy: "Broken-Wing Put Butterfly";
  opened_at_iso: string;
  expiry: string;
  long_put_strike: number;
  short_put_strike: number;
  far_long_put_strike: number;
  near_long_symbol: string;
  short_symbol: string;
  far_long_symbol: string;
  narrow_wing_width: number;
  wide_wing_width: number;
  entry_credit: number;
  max_risk_points: number;
  max_risk_dollars: number;
  legs: Array<{
    role: "near_long" | "short" | "far_long";
    symbol: string;
    right: "PUT";
    strike: number;
    qty: number;
    action: "BUY" | "SELL";
    delta?: number | null;
  }>;
  adjustment_count: number;
  status: "OPEN";
};

type BwbState = {
  position: BwbPosition | null;
  lastEntryAttemptIso?: string;
  lastExitAttemptIso?: string;
  lastGreekAlertDay?: string;
  lastAdjustmentIso?: string;
};

type SnapshotWithWarnings = DashboardPayload & { warnings?: string[] };
let tastySdkCache: { checkedAtMs: number; installed: boolean } | null = null;
type SleeveSettings = {
  sleeveCapital: number;
  totalAccount: number;
  maxDrawdownPct: number;
  dailyRealizedPnl: number;
  weeklyRealizedPnl: number;
  dailyLock: boolean;
  weeklyLock: boolean;
};

type ReqCtx = { requestId: string; startedAtMs: number; method: string; path: string };

function buildReqCtx(request: Request, method: string): ReqCtx {
  const hdr = request.headers.get("x-request-id");
  const requestId = hdr && hdr.trim() ? hdr.trim() : randomUUID();
  return {
    requestId,
    startedAtMs: Date.now(),
    method,
    path: new URL(request.url).pathname,
  };
}

function debugLog(ctx: ReqCtx, event: string, extra: Record<string, unknown> = {}): void {
  if (!DEBUG_MODE) return;
  const payload = {
    ts: new Date().toISOString(),
    request_id: ctx.requestId,
    event,
    method: ctx.method,
    path: ctx.path,
    ...extra,
  };
  console.log(JSON.stringify(payload));
}

function resolvePythonExecutable(): string {
  const configured = String(process.env.SPX0DTE_PYTHON_BIN || "").trim();
  if (configured) return configured;
  const localVenv = process.platform === "win32"
    ? path.join(process.cwd(), ".venv", "Scripts", "python.exe")
    : path.join(process.cwd(), ".venv", "bin", "python");
  if (existsSync(localVenv)) return localVenv;
  return process.platform === "win32" ? "python" : "python3";
}

function defaultSleeveSettings(): SleeveSettings {
  return {
    sleeveCapital: 10_000,
    totalAccount: 160_000,
    maxDrawdownPct: 15,
    dailyRealizedPnl: 0,
    weeklyRealizedPnl: 0,
    dailyLock: false,
    weeklyLock: false,
  };
}

function sanitizeSleeveSettings(input: Record<string, unknown>): SleeveSettings {
  const base = defaultSleeveSettings();
  const asNumber = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const sleeveCapital = Math.max(1_000, asNumber(input.sleeveCapital, base.sleeveCapital));
  const totalAccount = Math.max(1_000, asNumber(input.totalAccount, base.totalAccount));
  const maxDrawdownPct = Math.min(50, Math.max(1, asNumber(input.maxDrawdownPct, base.maxDrawdownPct)));
  return {
    sleeveCapital,
    totalAccount,
    maxDrawdownPct,
    dailyRealizedPnl: asNumber(input.dailyRealizedPnl, base.dailyRealizedPnl),
    weeklyRealizedPnl: asNumber(input.weeklyRealizedPnl, base.weeklyRealizedPnl),
    dailyLock: Boolean(input.dailyLock),
    weeklyLock: Boolean(input.weeklyLock),
  };
}

function loadSleeveSettings(): SleeveSettings {
  try {
    if (!existsSync(SLEEVE_SETTINGS_PATH)) return defaultSleeveSettings();
    const parsed = JSON.parse(readFileSync(SLEEVE_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    return sanitizeSleeveSettings({
      sleeveCapital: parsed.sleeveCapital ?? parsed.sleeve_capital,
      totalAccount: parsed.totalAccount ?? parsed.total_account,
      maxDrawdownPct: parsed.maxDrawdownPct ?? parsed.max_drawdown_pct,
      dailyRealizedPnl: parsed.dailyRealizedPnl ?? parsed.daily_realized_pnl,
      weeklyRealizedPnl: parsed.weeklyRealizedPnl ?? parsed.weekly_realized_pnl,
      dailyLock: parsed.dailyLock ?? parsed.daily_lock,
      weeklyLock: parsed.weeklyLock ?? parsed.weekly_lock,
    });
  } catch {
    return defaultSleeveSettings();
  }
}

function saveSleeveSettings(settings: SleeveSettings): void {
  const toWrite = {
    sleeve_capital: settings.sleeveCapital,
    total_account: settings.totalAccount,
    max_drawdown_pct: settings.maxDrawdownPct,
    daily_realized_pnl: settings.dailyRealizedPnl,
    weekly_realized_pnl: settings.weeklyRealizedPnl,
    daily_lock: settings.dailyLock,
    weekly_lock: settings.weeklyLock,
  };
  mkdirSync(path.dirname(SLEEVE_SETTINGS_PATH), { recursive: true });
  writeFileSync(SLEEVE_SETTINGS_PATH, JSON.stringify(toWrite, null, 2));
}

function attachSleeve(payload: DashboardPayload): DashboardPayload {
  const settings = loadSleeveSettings();
  const limits = {
    maxRiskPerTrade: settings.sleeveCapital * 0.03,
    maxOpenRisk: settings.sleeveCapital * 0.06,
    maxDailyLoss: settings.sleeveCapital * 0.04,
    maxWeeklyLoss: settings.sleeveCapital * 0.08,
  };
  return {
    ...payload,
    sleeveSettings: settings,
    sleeveLimits: limits,
  };
}

const STRATEGY_KEYS = [
  "Iron Condor",
  "Iron Fly",
  "Directional Spread",
  "Convex Debit Spread",
  "2-DTE Credit Spread",
  "7-DTE Credit Spread",
  "14-DTE Credit Spread",
  "30-DTE Credit Spread",
  "45-DTE Credit Spread",
] as const;

const LONGER_TIMEFRAME_STRATEGIES: Strategy[] = [
  "2-DTE Credit Spread",
  "7-DTE Credit Spread",
  "14-DTE Credit Spread",
  "30-DTE Credit Spread",
  "45-DTE Credit Spread",
];
const LEGACY_LONGER_ONLY_ENV = process.env.SPX0DTE_LONGER_TIMEFRAMES_ONLY;
const LONGER_TIMEFRAME_ONLY_ENABLED =
  LEGACY_LONGER_ONLY_ENV == null
    ? !FEATURE_0DTE
    : String(LEGACY_LONGER_ONLY_ENV).toLowerCase() === "true";
const BWB_ENABLED = String(process.env.SPX0DTE_ENABLE_BWB ?? "false").toLowerCase() === "true";

function defaultExecutionModelSettings(): ExecutionModelSettings {
  return {
    enabled: true,
    narrowWidthCutoff: 50,
    creditOffsetNarrow: 0.15,
    creditOffsetWide: 0.2,
    debitOffsetNarrow: 0.1,
    debitOffsetWide: 0.15,
    markImpactPct: 0.03,
    openBucketMultiplier: 1.2,
    midBucketMultiplier: 1.0,
    lateBucketMultiplier: 1.15,
    closeBucketMultiplier: 1.3,
  };
}

function sanitizeExecutionModelSettings(input: Record<string, unknown>): ExecutionModelSettings {
  const base = defaultExecutionModelSettings();
  const asNumber = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    enabled: Boolean(input.enabled ?? base.enabled),
    narrowWidthCutoff: Math.max(10, Math.min(150, asNumber(input.narrowWidthCutoff, base.narrowWidthCutoff))),
    creditOffsetNarrow: Math.max(0.01, Math.min(2, asNumber(input.creditOffsetNarrow, base.creditOffsetNarrow))),
    creditOffsetWide: Math.max(0.01, Math.min(3, asNumber(input.creditOffsetWide, base.creditOffsetWide))),
    debitOffsetNarrow: Math.max(0.01, Math.min(2, asNumber(input.debitOffsetNarrow, base.debitOffsetNarrow))),
    debitOffsetWide: Math.max(0.01, Math.min(3, asNumber(input.debitOffsetWide, base.debitOffsetWide))),
    markImpactPct: Math.max(0, Math.min(0.5, asNumber(input.markImpactPct, base.markImpactPct))),
    openBucketMultiplier: Math.max(0.5, Math.min(2, asNumber(input.openBucketMultiplier, base.openBucketMultiplier))),
    midBucketMultiplier: Math.max(0.5, Math.min(2, asNumber(input.midBucketMultiplier, base.midBucketMultiplier))),
    lateBucketMultiplier: Math.max(0.5, Math.min(2, asNumber(input.lateBucketMultiplier, base.lateBucketMultiplier))),
    closeBucketMultiplier: Math.max(0.5, Math.min(2.5, asNumber(input.closeBucketMultiplier, base.closeBucketMultiplier))),
  };
}

function loadExecutionModelSettings(): ExecutionModelSettings {
  try {
    if (!existsSync(EXECUTION_MODEL_PATH)) return defaultExecutionModelSettings();
    const parsed = JSON.parse(readFileSync(EXECUTION_MODEL_PATH, "utf8")) as Record<string, unknown>;
    return sanitizeExecutionModelSettings(parsed);
  } catch {
    return defaultExecutionModelSettings();
  }
}

function saveExecutionModelSettings(settings: ExecutionModelSettings): void {
  mkdirSync(path.dirname(EXECUTION_MODEL_PATH), { recursive: true });
  writeFileSync(EXECUTION_MODEL_PATH, JSON.stringify(settings, null, 2));
}

function defaultAlertPolicySettings(): AlertPolicySettings {
  return {
    cooldownSecondsByStrategy: {
      "Iron Condor": 300,
      "Iron Fly": 300,
      "Directional Spread": 300,
      "Convex Debit Spread": 180,
      "2-DTE Credit Spread": 900,
      "Broken-Wing Put Butterfly": 1800,
    },
    maxAlertsPerDayByStrategy: {
      "Iron Condor": 8,
      "Iron Fly": 8,
      "Directional Spread": 8,
      "Convex Debit Spread": 10,
      "2-DTE Credit Spread": 4,
      "Broken-Wing Put Butterfly": 3,
    },
  };
}

function sanitizeAlertPolicySettings(input: Record<string, unknown>): AlertPolicySettings {
  const base = defaultAlertPolicySettings();
  const cooldownRaw = (input.cooldownSecondsByStrategy ?? {}) as Record<string, unknown>;
  const maxRaw = (input.maxAlertsPerDayByStrategy ?? {}) as Record<string, unknown>;
  const cooldownSecondsByStrategy: Record<string, number> = {};
  const maxAlertsPerDayByStrategy: Record<string, number> = {};
  for (const strategy of STRATEGY_KEYS) {
    const cooldown = Number(cooldownRaw[strategy] ?? base.cooldownSecondsByStrategy[strategy]);
    const max = Number(maxRaw[strategy] ?? base.maxAlertsPerDayByStrategy[strategy]);
    cooldownSecondsByStrategy[strategy] = Number.isFinite(cooldown) ? Math.max(0, Math.min(86_400, Math.round(cooldown))) : base.cooldownSecondsByStrategy[strategy];
    maxAlertsPerDayByStrategy[strategy] = Number.isFinite(max) ? Math.max(1, Math.min(100, Math.round(max))) : base.maxAlertsPerDayByStrategy[strategy];
  }
  return { cooldownSecondsByStrategy, maxAlertsPerDayByStrategy };
}

function loadAlertPolicySettings(): AlertPolicySettings {
  try {
    if (!existsSync(ALERT_POLICY_PATH)) return defaultAlertPolicySettings();
    const parsed = JSON.parse(readFileSync(ALERT_POLICY_PATH, "utf8")) as Record<string, unknown>;
    return sanitizeAlertPolicySettings(parsed);
  } catch {
    return defaultAlertPolicySettings();
  }
}

function saveAlertPolicySettings(settings: AlertPolicySettings): void {
  mkdirSync(path.dirname(ALERT_POLICY_PATH), { recursive: true });
  writeFileSync(ALERT_POLICY_PATH, JSON.stringify(settings, null, 2));
}

function loadAlertPolicyRuntimeState(now = new Date()): AlertPolicyRuntimeState {
  const today = todayEtKey(now);
  try {
    if (!existsSync(ALERT_POLICY_STATE_PATH)) return { dateEt: today, byStrategy: {} };
    const parsed = JSON.parse(readFileSync(ALERT_POLICY_STATE_PATH, "utf8")) as AlertPolicyRuntimeState;
    if (!parsed || typeof parsed !== "object") return { dateEt: today, byStrategy: {} };
    if (parsed.dateEt !== today) return { dateEt: today, byStrategy: {} };
    return {
      dateEt: parsed.dateEt,
      byStrategy: typeof parsed.byStrategy === "object" && parsed.byStrategy != null ? parsed.byStrategy : {},
    };
  } catch {
    return { dateEt: today, byStrategy: {} };
  }
}

function saveAlertPolicyRuntimeState(state: AlertPolicyRuntimeState): void {
  mkdirSync(path.dirname(ALERT_POLICY_STATE_PATH), { recursive: true });
  writeFileSync(ALERT_POLICY_STATE_PATH, JSON.stringify(state, null, 2));
}

function hasTastyCredentials(): boolean {
  return tastyCredentialsPresent();
}

function detectTastySdkInstalled(): boolean {
  const now = Date.now();
  if (tastySdkCache && now - tastySdkCache.checkedAtMs < 5 * 60_000) {
    return tastySdkCache.installed;
  }

  const pythonPath = [process.cwd(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const pythonExec = resolvePythonExecutable();
  try {
    execFileSync(pythonExec, ["-c", "import tastytrade"], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: pythonPath },
      timeout: 6_000,
      maxBuffer: 512 * 1024,
      encoding: "utf8",
      stdio: "ignore",
    });
    tastySdkCache = { checkedAtMs: now, installed: true };
    return true;
  } catch {
    tastySdkCache = { checkedAtMs: now, installed: false };
    return false;
  }
}

function attachStartupHealth(payload: DashboardPayload): DashboardPayload {
  const telegramOk = telegramConfigured();
  const credentialsOk = hasTastyCredentials();
  let sdkOk = detectTastySdkInstalled();

  const warnings = payload.warnings ?? [];
  if (
    warnings.some((w) =>
      /tastytrade.*import failed|no module named ['"`]tastytrade['"`]/i.test(w),
    )
  ) {
    sdkOk = false;
  }

  return {
    ...payload,
    startupHealth: {
      telegram: {
        ok: telegramOk,
        label: telegramOk ? "OK" : "FAIL",
        detail: telegramOk
          ? "Token + chat ID configured."
          : "Missing TELEGRAM_BOT_TOKEN (or TELEGRAM_TOKEN) or TELEGRAM_CHAT_ID.",
      },
      tastySdk: {
        ok: sdkOk,
        label: sdkOk ? "INSTALLED" : "MISSING",
        detail: sdkOk ? "Python tastytrade package import succeeded." : "Install requirements in your active Python environment.",
      },
      tastyCredentials: {
        ok: credentialsOk,
        label: credentialsOk ? "PRESENT" : "MISSING",
        detail: credentialsOk
          ? "Tasty credentials found."
          : "Set TASTY_API_TOKEN and TASTY_API_SECRET.",
      },
    },
  };
}

function unavailableCriteria(marketClosed: boolean): Array<{ name: string; passed: boolean; detail: string }> {
  if (marketClosed) {
    return [
      {
        name: "[Global] Market open (09:30-16:00 ET)",
        passed: false,
        detail: "Market closed.",
      },
      {
        name: "[Global] Entry window (10:00-13:30 ET)",
        passed: false,
        detail: "No entries outside the trading session.",
      },
      {
        name: "[Data] Live chain/greeks available",
        passed: false,
        detail: "Feed not evaluated while market is closed.",
      },
    ];
  }

  return [
    {
      name: "[Data] Live market snapshot available",
      passed: false,
      detail: "Live data unavailable.",
    },
    {
      name: "[Data] 0DTE option chain available",
      passed: false,
      detail: "Unable to fetch option chain.",
    },
    {
      name: "[Data] Greeks/liquidity metrics available",
      passed: false,
      detail: "Insufficient data for strategy checks.",
    },
  ];
}

function unavailableChecklistRows(marketClosed: boolean): Array<{ name: string; status: "pass" | "fail" | "blocked" | "na"; detail: string; required: boolean }> {
  const detail = marketClosed ? "Market closed." : "Live data unavailable.";
  if (marketClosed) {
    return [
      { name: "Time >= 10:00 ET", status: "na", detail, required: false },
      { name: "Time <= 13:30 ET (short premium)", status: "na", detail, required: false },
      { name: "Not within 30 min of macro event", status: "na", detail, required: false },
      { name: "Not in weekly/daily loss lock", status: "na", detail, required: false },
      { name: "Sleeve open risk < 6%", status: "na", detail, required: false },
      { name: "Candidate max risk <= 3% sleeve", status: "na", detail, required: false },
      { name: "Volatility Expansion flag = FALSE", status: "na", detail, required: false },
    ];
  }
  return [
    { name: "Time >= 10:00 ET", status: "fail", detail, required: true },
    { name: "Time <= 13:30 ET (short premium)", status: "fail", detail, required: true },
    { name: "Not within 30 min of macro event", status: "fail", detail, required: true },
    { name: "Not in weekly/daily loss lock", status: "fail", detail, required: true },
    { name: "Sleeve open risk < 6%", status: "fail", detail, required: true },
    { name: "Candidate max risk <= 3% sleeve", status: "fail", detail, required: true },
    { name: "Volatility Expansion flag = FALSE", status: "fail", detail, required: true },
  ];
}

function unavailableRegimeRows(marketClosed: boolean): Array<{ name: string; status: "pass" | "fail" | "blocked" | "na"; detail: string; required: boolean }> {
  if (marketClosed) {
    return [
      {
        name: "Regime classified",
        status: "na",
        detail: "Regime paused while market is closed.",
        required: false,
      },
      {
        name: "Multi-timeframe trend confirmation available",
        status: "na",
        detail: "Trend confirmation paused while market is closed.",
        required: false,
      },
      {
        name: "Regime confidence >= 60%",
        status: "na",
        detail: "Regime confidence not evaluated outside market hours.",
        required: false,
      },
      {
        name: "Strategy allowed in this regime",
        status: "na",
        detail: "No active regime while market is closed.",
        required: false,
      },
    ];
  }
  return [
    {
      name: "Regime classified",
      status: "fail",
      detail: marketClosed ? "No live intraday regime while market is closed." : "Live regime unavailable.",
      required: true,
    },
    {
      name: "Multi-timeframe trend confirmation available",
      status: "fail",
      detail: marketClosed ? "Trend confirmation disabled while market is closed." : "Trend confirmation unavailable.",
      required: true,
    },
    {
      name: "Regime confidence >= 60%",
      status: "fail",
      detail: "Regime confidence unavailable.",
      required: true,
    },
    {
      name: "Strategy allowed in this regime",
      status: "fail",
      detail: "Regime unclassified.",
      required: true,
    },
  ];
}

function unavailableStrategyRows(strategy: string): Array<{ name: string; status: "pass" | "fail" | "blocked" | "na"; detail: string; required: boolean }> {
  return [
    {
      name: `${strategy} candidate exists`,
      status: "fail",
      detail: "Data incomplete - blocking trade.",
      required: true,
    },
  ];
}

function compactWarning(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("tasty_auth_failed")) return "TASTY_AUTH_FAILED";
  if (lower.includes("missing tastytrade credentials")) return "Credentials missing.";
  if (lower.includes("unable to authenticate")) return "Auth failed.";
  if (lower.includes("index snapshot request failed")) return "SPX/VIX snapshot request failed.";
  if (lower.includes("option chain request failed")) return "Option chain request failed.";
  if (lower.includes("market metrics request failed")) return "IV metrics request failed.";
  if (lower.includes("no same-day expiration")) return "No 0DTE chain (SPX/SPXW).";
  if (lower.includes("chain fallback active")) return "Using SPXW chain fallback.";
  if (lower.includes("market-data fallback selected")) return "Using alternate Tasty market-data mode.";
  if (lower.includes("dxlink streaming unavailable")) return "Live stream unavailable.";
  if (lower.includes("fetch failed")) return "Market data fetch failed.";
  if (lower.includes("import failed")) return "tastytrade package missing.";
  if (lower.includes("data incomplete")) return "Data incomplete - blocking trade.";
  return "Live data partial.";
}

function nowEtParis() {
  const now = new Date();
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const paris = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  return { et, paris };
}

function parseIsoDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function parseEtTimeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function loadUpcomingMacroEvents(now = new Date()): Array<{
  date: string;
  timeEt: string;
  name: string;
  daysOut: number;
  inMarketHours: boolean;
  info?: string;
  url?: string;
  eventType?: string;
  impact?: "Low" | "Medium" | "High" | string;
}> {
  try {
    if (!existsSync(MACRO_EVENTS_PATH)) return [];
    const raw = JSON.parse(readFileSync(MACRO_EVENTS_PATH, "utf8")) as unknown;
    const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { events?: unknown[] })?.events) ? (raw as { events: unknown[] }).events : [];
    if (!Array.isArray(rows)) return [];

    const etTodayText = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const etToday = parseIsoDate(etTodayText);
    if (!etToday) return [];
    const msPerDay = 24 * 60 * 60 * 1000;

    const events = rows
      .map((item) => {
        if (typeof item !== "object" || item == null) return null;
        const row = item as {
          date?: unknown;
          time_et?: unknown;
          name?: unknown;
          info?: unknown;
          url?: unknown;
          type?: unknown;
          impact?: unknown;
        };
        const dateText = String(row.date ?? "").slice(0, 10);
        const name = String(row.name ?? "").trim();
        const timeEt = String(row.time_et ?? "").trim();
        const info = String(row.info ?? "").trim();
        const url = String(row.url ?? "").trim();
        const eventType = String(row.type ?? "").trim();
        const impactRaw = String(row.impact ?? "").trim();
        if (!dateText || !name) return null;
        const eventDate = parseIsoDate(dateText);
        if (!eventDate) return null;
        const daysOut = Math.floor((eventDate.getTime() - etToday.getTime()) / msPerDay);
        if (daysOut < 0 || daysOut > 7) return null;
        const mins = parseEtTimeToMinutes(timeEt);
        const inMarketHours = mins != null && mins >= 570 && mins <= 960; // 09:30-16:00 ET
        const normalizedUrl = /^https?:\/\//i.test(url) ? url : undefined;
        const impact =
          /^high$/i.test(impactRaw) ? "High" : /^medium$/i.test(impactRaw) ? "Medium" : /^low$/i.test(impactRaw) ? "Low" : undefined;
        return {
          date: dateText,
          timeEt: timeEt || "-",
          name,
          daysOut,
          inMarketHours,
          info: info || undefined,
          url: normalizedUrl,
          eventType: eventType || inferMacroTypeFromName(name),
          impact: impact ?? inferMacroImpact(name),
        };
      })
      .filter(
        (
          v,
        ): v is {
          date: string;
          timeEt: string;
          name: string;
          daysOut: number;
          inMarketHours: boolean;
          info: string | undefined;
          url: string | undefined;
          eventType: string;
          impact: "Low" | "Medium" | "High";
        } => v !== null,
      )
      .sort((a, b) => (a.daysOut - b.daysOut) || a.date.localeCompare(b.date) || a.timeEt.localeCompare(b.timeEt))
      .slice(0, 12);

    return events;
  } catch {
    return [];
  }
}

function inferMacroTypeFromName(name: string): string {
  const n = name.toLowerCase();
  if (/(cpi|ppi|pce|inflation)/.test(n)) return "Inflation";
  if (/(nfp|jobs|jobless|employment|unemployment)/.test(n)) return "Labor";
  if (/(fomc|fed|powell|rate)/.test(n)) return "Monetary Policy";
  if (/(confidence|sentiment)/.test(n)) return "Sentiment";
  if (/(gdp|ism|retail|manufacturing)/.test(n)) return "Growth";
  return "Macro";
}

function inferMacroImpact(name: string): "Low" | "Medium" | "High" {
  const n = name.toLowerCase();
  if (/(cpi|ppi|pce|nfp|fomc|powell|rate decision|fed)/.test(n)) return "High";
  if (/(jobless|confidence|ism|gdp|retail)/.test(n)) return "Medium";
  return "Low";
}

function loadMacroCalendarStatus(now = new Date()): {
  updatedAtUtc: string | null;
  ageHours: number | null;
  stale: boolean;
  detail: string;
} {
  try {
    if (!existsSync(MACRO_EVENTS_PATH)) {
      return { updatedAtUtc: null, ageHours: null, stale: true, detail: "Macro calendar file missing." };
    }
    const raw = JSON.parse(readFileSync(MACRO_EVENTS_PATH, "utf8")) as unknown;
    const root = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
    const updatedRaw = String(root.updated_at_utc ?? "").trim();
    const ms = Date.parse(updatedRaw);
    if (!Number.isFinite(ms)) {
      return { updatedAtUtc: null, ageHours: null, stale: true, detail: "Missing updated_at_utc in macro calendar." };
    }
    const ageHours = Math.max(0, (now.getTime() - ms) / (1000 * 60 * 60));
    const stale = ageHours > 24;
    return {
      updatedAtUtc: updatedRaw,
      ageHours: Number(ageHours.toFixed(1)),
      stale,
      detail: stale ? `Macro calendar is stale (${ageHours.toFixed(1)}h old). Update daily.` : `Macro calendar fresh (${ageHours.toFixed(1)}h old).`,
    };
  } catch {
    return { updatedAtUtc: null, ageHours: null, stale: true, detail: "Macro calendar unreadable." };
  }
}

function getEtClock(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { weekday, hour, minute };
}

function nthWeekdayOfMonthUtc(year: number, month0: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstWeekday = first.getUTCDay();
  const delta = (weekday - firstWeekday + 7) % 7;
  const day = 1 + delta + (n - 1) * 7;
  return new Date(Date.UTC(year, month0, day));
}

function lastWeekdayOfMonthUtc(year: number, month0: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  const lastWeekday = last.getUTCDay();
  const delta = (lastWeekday - weekday + 7) % 7;
  const day = last.getUTCDate() - delta;
  return new Date(Date.UTC(year, month0, day));
}

function observedFixedHolidayUtc(year: number, month0: number, day: number): Date {
  const d = new Date(Date.UTC(year, month0, day));
  const wd = d.getUTCDay();
  if (wd === 6) return new Date(Date.UTC(year, month0, day - 1)); // Saturday -> Friday
  if (wd === 0) return new Date(Date.UTC(year, month0, day + 1)); // Sunday -> Monday
  return d;
}

function easterSundayUtc(year: number): Date {
  // Meeus/Jones/Butcher Gregorian algorithm.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isUsEquityHolidayEt(now = new Date()): boolean {
  const etDate = new Date(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now),
  );
  if (Number.isNaN(etDate.getTime())) return false;
  const year = etDate.getUTCFullYear();
  const today = dateKeyUtc(etDate);

  const holidays = new Set<string>();
  const add = (d: Date) => holidays.add(dateKeyUtc(d));

  // Fixed-date holidays (observed).
  add(observedFixedHolidayUtc(year, 0, 1));   // New Year's Day
  add(observedFixedHolidayUtc(year, 5, 19));  // Juneteenth
  add(observedFixedHolidayUtc(year, 6, 4));   // Independence Day
  add(observedFixedHolidayUtc(year, 11, 25)); // Christmas Day
  // If next year's New Year's is observed on Dec 31 this year.
  add(observedFixedHolidayUtc(year + 1, 0, 1));

  // Floating holidays.
  add(nthWeekdayOfMonthUtc(year, 0, 1, 3));    // MLK Day (3rd Monday Jan)
  add(nthWeekdayOfMonthUtc(year, 1, 1, 3));    // Presidents' Day (3rd Monday Feb)
  add(lastWeekdayOfMonthUtc(year, 4, 1));      // Memorial Day (last Monday May)
  add(nthWeekdayOfMonthUtc(year, 8, 1, 1));    // Labor Day (1st Monday Sep)
  add(nthWeekdayOfMonthUtc(year, 10, 4, 4));   // Thanksgiving (4th Thursday Nov)

  // Good Friday (2 days before Easter).
  const easter = easterSundayUtc(year);
  const goodFriday = new Date(easter.getTime() - 2 * 24 * 60 * 60 * 1000);
  add(goodFriday);

  return holidays.has(today);
}

function isMarketOpenEt(now = new Date()): boolean {
  if (process.env.SPX0DTE_FORCE_MARKET_OPEN === "true") {
    return true;
  }

  const { weekday, hour, minute } = getEtClock(now);
  const isWeekday = weekday !== "Sat" && weekday !== "Sun";
  if (!isWeekday) return false;
  if (isUsEquityHolidayEt(now)) return false;

  const mins = hour * 60 + minute;
  const openMins = 9 * 60 + 30;
  const closeMins = 16 * 60;
  return mins >= openMins && mins < closeMins;
}

function leg(action: "BUY" | "SELL", type: "PUT" | "CALL", strike: number, delta: number): OptionLeg {
  return { action, type, strike, delta };
}

function buildUnavailablePayload(message: string): SnapshotWithWarnings {
  const { et, paris } = nowEtParis();
  const isClosedMessage = message.toLowerCase().includes("market closed");
  const criteria = unavailableCriteria(isClosedMessage);
  const checklistRows = unavailableChecklistRows(isClosedMessage);
  const regimeRows = unavailableRegimeRows(isClosedMessage);

  return {
    generatedAtEt: et,
    generatedAtParis: paris,
    market: {
      isOpen: isMarketOpenEt(),
      hoursEt: MARKET_HOURS_ET,
      source: "live-unavailable",
      telegramEnabled: false,
    },
    metrics: {
      spx: 0,
      emr: 0,
      vix: 0,
      vwap: 0,
      range15mPctEm: 0,
      atr1m: 0,
      putCallRatio: null,
      iv: 0,
    },
    candidates: [
      {
        strategy: "Iron Condor",
        ready: false,
        width: 0,
        credit: 0,
        maxRisk: 0,
        popPct: 0,
        reason: "Live data unavailable.",
        blockedReason: "Data incomplete - blocking trade.",
        legs: [],
        checklist: {
          global: checklistRows,
          regime: regimeRows,
          strategy: unavailableStrategyRows("Iron Condor"),
        },
        criteria,
      },
      {
        strategy: "Iron Fly",
        ready: false,
        width: 0,
        credit: 0,
        maxRisk: 0,
        popPct: 0,
        reason: "Live data unavailable.",
        blockedReason: "Data incomplete - blocking trade.",
        legs: [],
        checklist: {
          global: checklistRows,
          regime: regimeRows,
          strategy: unavailableStrategyRows("Iron Fly"),
        },
        criteria,
      },
      {
        strategy: "Directional Spread",
        ready: false,
        width: 0,
        credit: 0,
        maxRisk: 0,
        popPct: 0,
        reason: "Live data unavailable.",
        blockedReason: "Data incomplete - blocking trade.",
        legs: [],
        checklist: {
          global: checklistRows,
          regime: regimeRows,
          strategy: unavailableStrategyRows("Directional Spread"),
        },
        criteria,
      },
      {
        strategy: "Convex Debit Spread",
        ready: false,
        width: 0,
        credit: 0,
        maxRisk: 0,
        popPct: 0,
        reason: "Live data unavailable.",
        blockedReason: "Data incomplete - blocking trade.",
        legs: [],
        checklist: {
          global: checklistRows,
          regime: regimeRows,
          strategy: unavailableStrategyRows("Convex Debit Spread"),
        },
        criteria,
      },
    ],
    globalChecklist: checklistRows,
    regimeSummary: {
      regime: "UNCLASSIFIED",
      favoredStrategy: "None",
      reason: "Data incomplete - blocking trade.",
    },
    upcomingMacroEvents: loadUpcomingMacroEvents(),
    strategyEligibility: [
      { strategy: "Iron Condor", status: "fail", reason: "Regime unclassified." },
      { strategy: "Iron Fly", status: "fail", reason: "Regime unclassified." },
      { strategy: "Directional Spread", status: "fail", reason: "Regime unclassified." },
      { strategy: "Convex Debit Spread", status: "fail", reason: "Regime unclassified." },
      { strategy: "2-DTE Credit Spread", status: "fail", reason: "Data unavailable." },
      { strategy: "7-DTE Credit Spread", status: "fail", reason: "Data unavailable." },
      { strategy: "14-DTE Credit Spread", status: "fail", reason: "Data unavailable." },
      { strategy: "30-DTE Credit Spread", status: "fail", reason: "Data unavailable." },
      { strategy: "45-DTE Credit Spread", status: "fail", reason: "Data unavailable." },
    ],
    alerts: [],
    openTrades: [],
    priceSeries: [],
    volSeries: [],
    symbolValidation: {
      dte0: [],
      dte2: [],
      bwb: [],
      targets: {
        "2": { expiration: null, symbols: [] },
        "7": { expiration: null, symbols: [] },
        "14": { expiration: null, symbols: [] },
        "30": { expiration: null, symbols: [] },
        "45": { expiration: null, symbols: [] },
      },
      chain: {
        underlyingSymbol: "SPX",
        chainExpiryMin: null,
        chainExpiryMax: null,
        expirationsPresent: [],
      },
      checks: {
        spot_reasonable: false,
        chain_has_target_expirations: false,
        greeks_match_chain: false,
        chain_age_ok: false,
        spot_age_ok: false,
        greeks_age_ok: false,
      },
    },
    dataFeeds: {
      underlying_price: {
        timestampIso: null,
        source: "market-closed",
      },
      option_chain: {
        timestampIso: null,
        source: "market-closed",
      },
      greeks: {
        timestampIso: null,
        source: "market-closed",
      },
    },
    warnings: [message],
    twoDte: {
      ready: false,
      reason: "Data incomplete - blocking trade.",
      checklist: [
        { name: "2-DTE sleeve enabled", status: "fail", detail: message, required: true },
      ],
      recommendation: null,
      metrics: {},
      settings: {},
      openTrades: [],
      executionMode: {
        paperEnabled: false,
        paperReady: false,
        paperDryRun: false,
        detail: "Paper trading disabled.",
      },
    },
    multiDte: {
      targets: [2, 7, 14, 30, 45].map((target) => ({
        strategy_label: `${target}-DTE Credit Spread` as Strategy,
        target_dte: target,
        selected_dte: null,
        expiration: null,
        ready: false,
        reason: message,
        checklist: [{ name: `${target}-DTE data available`, status: "fail", detail: message, required: true }],
        recommendation: null,
        metrics: {},
      })),
    },
    bwb: {
      ready: false,
      reason: "Data incomplete - blocking BWB sleeve.",
      checklist: [
        { name: "BWB data available", status: "fail", detail: message, required: true },
      ],
      recommendation: null,
      metrics: {},
      settings: loadBwbSettings(),
      openPosition: null,
      monitor: { hasPosition: false },
    },
    sleeveSettings: defaultSleeveSettings(),
    sleeveLimits: {
      maxRiskPerTrade: 300,
      maxOpenRisk: 600,
      maxDailyLoss: 400,
      maxWeeklyLoss: 800,
    },
  };
}

type TwoDteSettings = {
  enabled: boolean;
  width: number;
  short_delta_min: number;
  short_delta_max: number;
  auto_select_params: boolean;
  min_strike_distance: number;
  max_strike_distance: number;
  min_credit: number;
  max_credit: number;
  use_delta_stop: boolean;
  delta_stop: number;
  stop_multiple: number;
  profit_take_debit: number;
  require_measured_move: boolean;
  allow_catalyst: boolean;
};

const DEFAULT_TWO_DTE_SETTINGS: TwoDteSettings = {
  enabled: true,
  width: 10,
  short_delta_min: 0.1,
  short_delta_max: 0.2,
  auto_select_params: true,
  min_strike_distance: 30,
  max_strike_distance: 50,
  min_credit: 0.8,
  max_credit: 1.0,
  use_delta_stop: true,
  delta_stop: 0.4,
  stop_multiple: 3,
  profit_take_debit: 0.05,
  require_measured_move: false,
  allow_catalyst: false,
};

type MultiDteSettings = {
  minDelta: number;
  maxDelta: number;
  minIV: number;
  maxBidAskSpread: number;
  dataFreshnessThreshold: number;
  requireGreeksValidation: boolean;
  dteThresholds: Record<string, { minPremium: number }>;
};

const DEFAULT_MULTI_DTE_SETTINGS: MultiDteSettings = {
  minDelta: 0.15,
  maxDelta: 0.35,
  minIV: 8,
  maxBidAskSpread: 0.5,
  dataFreshnessThreshold: 30,
  requireGreeksValidation: true,
  dteThresholds: {
    "2": { minPremium: 50 },
    "7": { minPremium: 100 },
    "14": { minPremium: 150 },
    "30": { minPremium: 200 },
    "45": { minPremium: 250 },
  },
};

function sanitizeMultiDteSettings(input: Record<string, unknown>): MultiDteSettings {
  const num = (key: keyof Omit<MultiDteSettings, "requireGreeksValidation" | "dteThresholds">, min: number, max: number) => {
    const v = Number(input[key]);
    if (!Number.isFinite(v)) return DEFAULT_MULTI_DTE_SETTINGS[key] as number;
    return Math.max(min, Math.min(max, v));
  };
  const thresholdsRaw = (input.dteThresholds ?? {}) as Record<string, unknown>;
  const nextThresholds: Record<string, { minPremium: number }> = {};
  for (const key of ["2", "7", "14", "30", "45"]) {
    const row = (thresholdsRaw[key] ?? {}) as Record<string, unknown>;
    const minPremium = Number(row.minPremium);
    nextThresholds[key] = {
      minPremium: Number.isFinite(minPremium)
        ? Math.max(1, Math.min(10_000, minPremium))
        : DEFAULT_MULTI_DTE_SETTINGS.dteThresholds[key].minPremium,
    };
  }
  return {
    minDelta: num("minDelta", 0.05, 0.5),
    maxDelta: num("maxDelta", 0.05, 0.6),
    minIV: num("minIV", 1, 100),
    maxBidAskSpread: num("maxBidAskSpread", 0.01, 10),
    dataFreshnessThreshold: Math.round(num("dataFreshnessThreshold", 5, 300)),
    requireGreeksValidation: Boolean(input.requireGreeksValidation ?? DEFAULT_MULTI_DTE_SETTINGS.requireGreeksValidation),
    dteThresholds: nextThresholds,
  };
}

function loadMultiDteSettings(): MultiDteSettings {
  try {
    if (!existsSync(MULTI_DTE_SETTINGS_PATH)) return DEFAULT_MULTI_DTE_SETTINGS;
    const raw = JSON.parse(readFileSync(MULTI_DTE_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    return sanitizeMultiDteSettings(raw);
  } catch {
    return DEFAULT_MULTI_DTE_SETTINGS;
  }
}

function saveMultiDteSettings(settings: MultiDteSettings): void {
  mkdirSync(path.dirname(MULTI_DTE_SETTINGS_PATH), { recursive: true });
  writeFileSync(MULTI_DTE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function loadTwoDteSettings(): TwoDteSettings {
  try {
    if (!existsSync(TWO_DTE_SETTINGS_PATH)) return DEFAULT_TWO_DTE_SETTINGS;
    const raw = JSON.parse(readFileSync(TWO_DTE_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    return sanitizeTwoDteSettings(raw);
  } catch {
    return DEFAULT_TWO_DTE_SETTINGS;
  }
}

function sanitizeTwoDteSettings(input: Record<string, unknown>): TwoDteSettings {
  const num = (key: keyof TwoDteSettings, min: number, max: number) => {
    const v = Number(input[key]);
    if (!Number.isFinite(v)) return DEFAULT_TWO_DTE_SETTINGS[key] as number;
    return Math.max(min, Math.min(max, v));
  };
  return {
    enabled: Boolean(input.enabled ?? DEFAULT_TWO_DTE_SETTINGS.enabled),
    width: Math.round(num("width", 5, 50)),
    short_delta_min: num("short_delta_min", 0.05, 0.4),
    short_delta_max: num("short_delta_max", 0.05, 0.5),
    auto_select_params: Boolean(input.auto_select_params ?? DEFAULT_TWO_DTE_SETTINGS.auto_select_params),
    min_strike_distance: num("min_strike_distance", 10, 100),
    max_strike_distance: num("max_strike_distance", 10, 150),
    min_credit: num("min_credit", 0.1, 5),
    max_credit: num("max_credit", 0.1, 8),
    use_delta_stop: Boolean(input.use_delta_stop ?? DEFAULT_TWO_DTE_SETTINGS.use_delta_stop),
    delta_stop: num("delta_stop", 0.1, 0.8),
    stop_multiple: num("stop_multiple", 1.5, 5),
    profit_take_debit: num("profit_take_debit", 0.01, 0.2),
    require_measured_move: Boolean(input.require_measured_move ?? DEFAULT_TWO_DTE_SETTINGS.require_measured_move),
    allow_catalyst: Boolean(input.allow_catalyst ?? DEFAULT_TWO_DTE_SETTINGS.allow_catalyst),
  };
}

function saveTwoDteSettings(settings: TwoDteSettings): void {
  mkdirSync(path.dirname(TWO_DTE_SETTINGS_PATH), { recursive: true });
  writeFileSync(TWO_DTE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

type TwoDteOrder = Record<string, unknown>;

function loadTwoDteOrders(): TwoDteOrder[] {
  try {
    if (!existsSync(TWO_DTE_STATE_PATH)) return [];
    const raw = JSON.parse(readFileSync(TWO_DTE_STATE_PATH, "utf8")) as { orders?: unknown[] };
    return Array.isArray(raw.orders) ? raw.orders.filter((o): o is TwoDteOrder => typeof o === "object" && o != null) : [];
  } catch {
    return [];
  }
}

function saveTwoDteOrders(orders: TwoDteOrder[]): void {
  mkdirSync(path.dirname(TWO_DTE_STATE_PATH), { recursive: true });
  writeFileSync(TWO_DTE_STATE_PATH, JSON.stringify({ orders }, null, 2));
}

const DEFAULT_BWB_SETTINGS: BwbSettings = {
  enabled: true,
  target_dte: 21,
  min_dte: 14,
  max_dte: 30,
  iv_rank_threshold: 50,
  short_delta_min: 0.28,
  short_delta_max: 0.3,
  near_long_delta_target: 0.32,
  near_long_delta_tolerance: 0.04,
  far_long_delta_max: 0.2,
  narrow_wing_min: 5,
  narrow_wing_max: 10,
  wide_to_narrow_min_ratio: 2.0,
  min_credit_per_narrow: 0.1,
  max_risk_pct_account: 0.01,
  max_total_margin_pct_account: 0.12,
  profit_take_credit_frac: 0.5,
  profit_take_width_frac: 0.02,
  stop_loss_credit_frac: 0.5,
  exit_dte: 7,
  delta_alert_threshold: 0.5,
  gamma_alert_threshold: 0.08,
  allow_adjustments: false,
  adjustment_mode: "NONE",
};

function sanitizeBwbSettings(input: Record<string, unknown>): BwbSettings {
  const num = (key: keyof BwbSettings, min: number, max: number): number => {
    const raw = Number(input[key]);
    if (!Number.isFinite(raw)) return Number(DEFAULT_BWB_SETTINGS[key]);
    return Math.max(min, Math.min(max, raw));
  };
  const modeRaw = String(input.adjustment_mode ?? DEFAULT_BWB_SETTINGS.adjustment_mode).toUpperCase();
  const adjustment_mode: BwbSettings["adjustment_mode"] =
    modeRaw === "ROLL" || modeRaw === "CONVERT_VERTICAL" ? modeRaw : "NONE";
  return {
    enabled: Boolean(input.enabled ?? DEFAULT_BWB_SETTINGS.enabled),
    target_dte: Math.round(num("target_dte", 7, 60)),
    min_dte: Math.round(num("min_dte", 7, 45)),
    max_dte: Math.round(num("max_dte", 8, 90)),
    iv_rank_threshold: num("iv_rank_threshold", 1, 100),
    short_delta_min: num("short_delta_min", 0.05, 0.45),
    short_delta_max: num("short_delta_max", 0.05, 0.45),
    near_long_delta_target: num("near_long_delta_target", 0.05, 0.6),
    near_long_delta_tolerance: num("near_long_delta_tolerance", 0.01, 0.2),
    far_long_delta_max: num("far_long_delta_max", 0.01, 0.4),
    narrow_wing_min: num("narrow_wing_min", 1, 50),
    narrow_wing_max: num("narrow_wing_max", 2, 80),
    wide_to_narrow_min_ratio: num("wide_to_narrow_min_ratio", 1.1, 5),
    min_credit_per_narrow: num("min_credit_per_narrow", 0.01, 1),
    max_risk_pct_account: num("max_risk_pct_account", 0.001, 0.05),
    max_total_margin_pct_account: num("max_total_margin_pct_account", 0.01, 0.5),
    profit_take_credit_frac: num("profit_take_credit_frac", 0.1, 1),
    profit_take_width_frac: num("profit_take_width_frac", 0.001, 0.2),
    stop_loss_credit_frac: num("stop_loss_credit_frac", 0.05, 5),
    exit_dte: Math.round(num("exit_dte", 1, 21)),
    delta_alert_threshold: num("delta_alert_threshold", 0.05, 2),
    gamma_alert_threshold: num("gamma_alert_threshold", 0.005, 2),
    allow_adjustments: Boolean(input.allow_adjustments ?? DEFAULT_BWB_SETTINGS.allow_adjustments),
    adjustment_mode,
  };
}

function loadBwbSettings(): BwbSettings {
  try {
    if (!existsSync(BWB_SETTINGS_PATH)) return DEFAULT_BWB_SETTINGS;
    const parsed = JSON.parse(readFileSync(BWB_SETTINGS_PATH, "utf8")) as Record<string, unknown>;
    return sanitizeBwbSettings(parsed);
  } catch {
    return DEFAULT_BWB_SETTINGS;
  }
}

function saveBwbSettings(settings: BwbSettings): void {
  mkdirSync(path.dirname(BWB_SETTINGS_PATH), { recursive: true });
  writeFileSync(BWB_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function loadBwbState(): BwbState {
  try {
    if (!existsSync(BWB_STATE_PATH)) return { position: null };
    const parsed = JSON.parse(readFileSync(BWB_STATE_PATH, "utf8")) as Partial<BwbState>;
    return {
      position: parsed.position ?? null,
      lastEntryAttemptIso: parsed.lastEntryAttemptIso,
      lastExitAttemptIso: parsed.lastExitAttemptIso,
      lastGreekAlertDay: parsed.lastGreekAlertDay,
      lastAdjustmentIso: parsed.lastAdjustmentIso,
    };
  } catch {
    return { position: null };
  }
}

function saveBwbState(state: BwbState): void {
  mkdirSync(path.dirname(BWB_STATE_PATH), { recursive: true });
  writeFileSync(BWB_STATE_PATH, JSON.stringify(state, null, 2));
}

function appendBwbLog(row: Record<string, unknown>): void {
  try {
    mkdirSync(path.dirname(BWB_LOG_PATH), { recursive: true });
    const line = `${JSON.stringify(row)}\n`;
    writeFileSync(BWB_LOG_PATH, line, { flag: "a" });
  } catch {
    // keep pipeline resilient
  }
}

function minutesSince(isoText?: string): number | null {
  if (!isoText) return null;
  const dt = new Date(isoText);
  if (Number.isNaN(dt.getTime())) return null;
  return (Date.now() - dt.getTime()) / 60000;
}

function buildBwbPositionFromRecommendation(recommendation: Record<string, unknown>): BwbPosition | null {
  const legsRaw = Array.isArray(recommendation.legs) ? recommendation.legs : [];
  const legs = legsRaw
    .map((leg) => {
      const row = leg as Record<string, unknown>;
      const role = String(row.role ?? "").trim() as BwbPosition["legs"][number]["role"];
      const symbol = String(row.symbol ?? "").trim();
      const strike = Number(row.strike ?? 0);
      const qty = Number(row.qty ?? 1);
      const action = String(row.action ?? "").toUpperCase();
      const right = String((row.type ?? row.right) ?? "").toUpperCase();
      const deltaVal = row.delta == null ? null : Number(row.delta);
      if (!symbol || !Number.isFinite(strike) || !Number.isFinite(qty) || qty <= 0) return null;
      if (role !== "near_long" && role !== "short" && role !== "far_long") return null;
      if (action !== "BUY" && action !== "SELL") return null;
      if (right !== "PUT") return null;
      return {
        role,
        symbol,
        right: "PUT" as const,
        strike,
        qty: Math.max(1, Math.round(qty)),
        action: action as "BUY" | "SELL",
        delta: Number.isFinite(deltaVal) ? deltaVal : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (legs.length !== 3) return null;
  const near = legs.find((row) => row.role === "near_long");
  const short = legs.find((row) => row.role === "short");
  const far = legs.find((row) => row.role === "far_long");
  if (!near || !short || !far) return null;
  const entry_credit = Number(recommendation.credit ?? 0);
  const max_risk_points = Number(recommendation.max_risk_points ?? 0);
  const max_risk_dollars = Number(recommendation.max_risk_dollars ?? max_risk_points * 100);
  const narrow_wing_width = Number(recommendation.narrow_wing_width ?? Math.abs(near.strike - short.strike));
  const wide_wing_width = Number(recommendation.wide_wing_width ?? Math.abs(short.strike - far.strike));
  const expiry = String(recommendation.expiry ?? "").trim();
  if (
    !Number.isFinite(entry_credit) ||
    !Number.isFinite(max_risk_points) ||
    !Number.isFinite(max_risk_dollars) ||
    !Number.isFinite(narrow_wing_width) ||
    !Number.isFinite(wide_wing_width) ||
    !expiry
  ) {
    return null;
  }
  return {
    id: `BWB-${Date.now()}`,
    strategy: "Broken-Wing Put Butterfly",
    opened_at_iso: new Date().toISOString(),
    expiry,
    long_put_strike: near.strike,
    short_put_strike: short.strike,
    far_long_put_strike: far.strike,
    near_long_symbol: near.symbol,
    short_symbol: short.symbol,
    far_long_symbol: far.symbol,
    narrow_wing_width,
    wide_wing_width,
    entry_credit,
    max_risk_points,
    max_risk_dollars,
    legs,
    adjustment_count: 0,
    status: "OPEN",
  };
}

function mapBwbOpenLegs(position: BwbPosition): Array<{ symbol: string; action: "BUY_TO_OPEN" | "SELL_TO_OPEN"; qty: number }> {
  return position.legs.map((row) => ({
    symbol: row.symbol,
    action: row.action === "BUY" ? "BUY_TO_OPEN" : "SELL_TO_OPEN",
    qty: row.qty,
  }));
}

function mapBwbCloseLegs(position: BwbPosition): Array<{ symbol: string; action: "BUY_TO_CLOSE" | "SELL_TO_CLOSE"; qty: number }> {
  return position.legs.map((row) => ({
    symbol: row.symbol,
    action: row.action === "BUY" ? "SELL_TO_CLOSE" : "BUY_TO_CLOSE",
    qty: row.qty,
  }));
}

function paperTradingConfig() {
  const enabled = String(process.env.SPX0DTE_PAPER_TRADING || "").toLowerCase() === "true";
  const dryRun = String(process.env.SPX0DTE_PAPER_DRY_RUN || "false").toLowerCase() === "true";
  const isTest =
    String(process.env.TASTY_ENV || "").toLowerCase() === "sandbox" ||
    String(process.env.TASTY_IS_TEST || "false").toLowerCase() === "true";
  const requireTest = String(process.env.SPX0DTE_PAPER_REQUIRE_TEST || "true").toLowerCase() === "true";
  const accountNumber = process.env.TASTY_ACCOUNT_NUMBER || process.env.SPX0DTE_PAPER_ACCOUNT_NUMBER || "";
  const oauthCreds = Boolean(process.env.TASTY_API_SECRET && process.env.TASTY_API_TOKEN);
  const ready = enabled && (!requireTest || isTest) && oauthCreds;
  const detail = !enabled
    ? "Paper trading disabled (set SPX0DTE_PAPER_TRADING=true)."
    : requireTest && !isTest
      ? "Paper trading requires TASTY_IS_TEST=true."
      : !oauthCreds
        ? "Paper trading requires TASTY_API_TOKEN and TASTY_API_SECRET."
        : "Paper trading enabled.";
  return { enabled, dryRun, isTest, requireTest, accountNumber, ready, detail };
}

function parsePaperExecError(err: unknown): { message: string; raw?: Record<string, unknown> } {
  const asText = (v: unknown): string =>
    typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : "";

  const payloadFromText = (text: string): { message: string; raw?: Record<string, unknown> } | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const candidate = lines.length ? lines[lines.length - 1] : trimmed;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const message = String(parsed.message ?? "").trim();
      if (message) {
        return { message, raw: parsed };
      }
      return { message: candidate, raw: parsed };
    } catch {
      return { message: candidate };
    }
  };

  if (err && typeof err === "object") {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const fromStdout = payloadFromText(asText(e.stdout));
    if (fromStdout) return fromStdout;
    const fromStderr = payloadFromText(asText(e.stderr));
    if (fromStderr) return fromStderr;
    const msg = typeof e.message === "string" ? e.message : "";
    if (msg.trim()) return { message: msg.trim() };
  }

  return { message: String(err) };
}

function submitPaperTwoDteOrder(input: {
  shortSymbol: string;
  longSymbol: string;
  entryCredit: number;
  stopDebit: number;
  profitTakeDebit: number;
  accountNumber?: string;
  dryRun: boolean;
}): { ok: boolean; message: string; raw?: Record<string, unknown> } {
  const pythonExec = resolvePythonExecutable();
  if (!existsSync(PAPER_ORDER_SCRIPT)) {
    return { ok: false, message: "Paper order script missing." };
  }
  const symbolValidation = validateSymbolSetForBucket({
    symbols: [input.shortSymbol, input.longSymbol],
    bucket: "dte2",
    context: "2-DTE",
  });
  if (!symbolValidation.ok) {
    return { ok: false, message: symbolValidation.message };
  }
  try {
    const payload = {
      short_symbol: input.shortSymbol,
      long_symbol: input.longSymbol,
      entry_credit: input.entryCredit,
      stop_debit: input.stopDebit,
      profit_take_debit: input.profitTakeDebit,
      account_number: input.accountNumber || undefined,
      dry_run: input.dryRun,
    };
    const out = execFileSync(pythonExec, [PAPER_ORDER_SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: [process.cwd(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
      input: JSON.stringify(payload),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    return {
      ok: Boolean(parsed.ok),
      message: String(parsed.message ?? (Boolean(parsed.ok) ? "Paper order submitted." : "Paper order failed.")),
      raw: parsed,
    };
  } catch (err) {
    const parsedErr = parsePaperExecError(err);
    return { ok: false, message: `Paper submit failed: ${parsedErr.message}`, raw: parsedErr.raw };
  }
}

function submitPaperPrimaryOrder(input: {
  strategy: string;
  orderSide: "CREDIT" | "DEBIT";
  limitPrice: number;
  legs: Array<{
    symbol: string;
    action: "BUY_TO_OPEN" | "SELL_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_CLOSE";
    qty: number;
  }>;
  accountNumber?: string;
  dryRun: boolean;
  symbolBucket?: SymbolBucket;
}): { ok: boolean; message: string; raw?: Record<string, unknown> } {
  const pythonExec = resolvePythonExecutable();
  if (!existsSync(PAPER_PRIMARY_ORDER_SCRIPT)) {
    return { ok: false, message: "Paper primary-order script missing." };
  }
  const symbolValidation = validateSymbolSetForBucket({
    symbols: input.legs.map((row) => row.symbol),
    bucket: input.symbolBucket ?? "dte0",
    context: input.strategy,
  });
  if (!symbolValidation.ok) {
    return { ok: false, message: symbolValidation.message };
  }
  try {
    const payload = {
      strategy: input.strategy,
      order_side: input.orderSide,
      limit_price: input.limitPrice,
      legs: input.legs,
      account_number: input.accountNumber || undefined,
      dry_run: input.dryRun,
    };
    const out = execFileSync(pythonExec, [PAPER_PRIMARY_ORDER_SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: [process.cwd(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
      input: JSON.stringify(payload),
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    const parsed = JSON.parse(out) as Record<string, unknown>;
    return {
      ok: Boolean(parsed.ok),
      message: String(parsed.message ?? (Boolean(parsed.ok) ? "Paper order submitted." : "Paper order failed.")),
      raw: parsed,
    };
  } catch (err) {
    const parsedErr = parsePaperExecError(err);
    return { ok: false, message: `Paper submit failed: ${parsedErr.message}`, raw: parsedErr.raw };
  }
}

function readPythonSnapshot(): SnapshotWithWarnings | null {
  if (!existsSync(PY_SNAPSHOT_SCRIPT)) {
    return null;
  }

  try {
    const pythonPath = [process.cwd(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const pythonExec = resolvePythonExecutable();
    const output = execFileSync(pythonExec, [PY_SNAPSHOT_SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: pythonPath },
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });

    const parsed = JSON.parse(output) as SnapshotWithWarnings;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function runHistoricalBacktest(input: { years: number; sleeveCapital: number }): {
  ok: boolean;
  message: string;
  result?: Record<string, unknown>;
} {
  if (!existsSync(PY_BACKTEST_SCRIPT)) {
    return { ok: false, message: "Historical backtest script missing." };
  }
  const pythonExec = resolvePythonExecutable();
  const payload = {
    years: Math.max(2, Math.min(50, Math.round(Number(input.years) || 10))),
    sleeveCapital: Math.max(1000, Number(input.sleeveCapital) || 10_000),
  };
  try {
    const pythonPath = [process.cwd(), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const output = execFileSync(pythonExec, [PY_BACKTEST_SCRIPT], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONPATH: pythonPath },
      input: JSON.stringify(payload),
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const ok = Boolean(parsed.ok);
    return {
      ok,
      message: String(parsed.message ?? (ok ? "Historical backtest complete." : "Historical backtest failed.")),
      result: parsed,
    };
  } catch (err) {
    const parsedErr = parsePaperExecError(err);
    return { ok: false, message: `Historical backtest failed: ${parsedErr.message}`, result: parsedErr.raw };
  }
}

function normalizeOptionSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function optionSymbolLooksValid(symbol: string): boolean {
  return /^\.?[A-Z0-9]+[A-Z]?\d{6}[PC]\d+(?:\.\d+)?$/.test(normalizeOptionSymbol(symbol));
}

function extractSymbolValidationSets(snapshot: SnapshotWithWarnings | null): Record<SymbolBucket, Set<string>> {
  const out: Record<SymbolBucket, Set<string>> = {
    dte0: new Set<string>(),
    dte2: new Set<string>(),
    bwb: new Set<string>(),
  };
  if (!snapshot) return out;
  const root = snapshot as unknown as Record<string, unknown>;
  const symbolValidation = (root.symbolValidation ?? null) as Record<string, unknown> | null;
  if (!symbolValidation) return out;
  for (const key of ["dte0", "dte2", "bwb"] as const) {
    const rows = symbolValidation[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const sym = normalizeOptionSymbol(String(row ?? ""));
      if (sym) out[key].add(sym);
    }
  }
  return out;
}

function validateSymbolSetForBucket(input: {
  symbols: string[];
  bucket: SymbolBucket;
  context: string;
}): { ok: boolean; message: string } {
  const normalized = input.symbols.map((s) => normalizeOptionSymbol(s)).filter(Boolean);
  if (normalized.length === 0) {
    return { ok: false, message: "Missing option symbols for validation." };
  }
  const malformed = normalized.filter((s) => !optionSymbolLooksValid(s));
  if (malformed.length > 0) {
    return {
      ok: false,
      message: `Invalid option symbol format: ${malformed.slice(0, 2).join(", ")}`,
    };
  }

  const live = readPythonSnapshot();
  if (!live) {
    return { ok: false, message: "Live symbol validator unavailable. Blocking paper submit." };
  }
  const sets = extractSymbolValidationSets(live);
  const allowed = sets[input.bucket];
  if (allowed.size === 0) {
    return {
      ok: false,
      message: `No live symbols loaded for ${input.context}. Blocking paper submit.`,
    };
  }
  const stale = normalized.filter((s) => !allowed.has(s));
  if (stale.length > 0) {
    return {
      ok: false,
      message: `Stale/invalid symbols for ${input.context}: ${stale.slice(0, 2).join(", ")}`,
    };
  }
  return { ok: true, message: "Symbols validated." };
}

function alertLegSignature(alert: AlertItem): string {
  if (!Array.isArray(alert.legs) || alert.legs.length === 0) return "NOLEGS";
  return alert.legs
    .map((leg) => `${leg.action}:${leg.type}:${Math.round(leg.strike)}`)
    .join("|");
}

function alertFingerprint(alert: AlertItem): string {
  return `${alert.type}|${alert.strategy}|${alertLegSignature(alert)}`;
}

function alertMaterialKey(alert: AlertItem): string {
  const reason = String(alert.reason ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `${alertFingerprint(alert)}|${reason}`;
}

function loadAlertAckState(): AlertAckState {
  try {
    if (!existsSync(ALERT_ACK_STATE_PATH)) return { entries: [] };
    const parsed = JSON.parse(readFileSync(ALERT_ACK_STATE_PATH, "utf8")) as AlertAckState;
    if (!Array.isArray(parsed.entries)) return { entries: [] };
    return { entries: parsed.entries.slice(-1000) };
  } catch {
    return { entries: [] };
  }
}

function saveAlertAckState(state: AlertAckState): void {
  try {
    mkdirSync(path.dirname(ALERT_ACK_STATE_PATH), { recursive: true });
    writeFileSync(ALERT_ACK_STATE_PATH, JSON.stringify({ entries: state.entries.slice(-1000) }, null, 2));
  } catch {
    // keep API resilient
  }
}

function applyAlertAckSuppression(alerts: AlertItem[]): AlertItem[] {
  if (alerts.length === 0) return alerts;
  const ackState = loadAlertAckState();
  if (ackState.entries.length === 0) return alerts;
  const map = new Map<string, string>();
  for (const row of ackState.entries) {
    if (!row?.fingerprint || !row?.material_key) continue;
    map.set(row.fingerprint, row.material_key);
  }
  return alerts.filter((alert) => {
    const fp = alertFingerprint(alert);
    const material = alertMaterialKey(alert);
    return map.get(fp) !== material;
  });
}

function acknowledgeAlert(input: unknown): { ok: boolean; message: string } {
  const row = (input ?? {}) as Record<string, unknown>;
  const strategy = String(row.strategy ?? "").trim() as AlertItem["strategy"];
  const typeRaw = String(row.type ?? "").trim().toUpperCase();
  const reason = String(row.reason ?? "").trim();
  if (!strategy || (typeRaw !== "ENTRY" && typeRaw !== "EXIT") || !reason) {
    return { ok: false, message: "Invalid alert payload for acknowledgement." };
  }
  const legsRaw = Array.isArray(row.legs) ? row.legs : [];
  const mappedLegs = legsRaw
    .map((leg) => {
      const item = leg as Record<string, unknown>;
      const action = String(item.action ?? "").toUpperCase();
      const type = String(item.type ?? "").toUpperCase();
      const strike = Number(item.strike ?? 0);
      const delta = Number(item.delta ?? 0);
      if ((action !== "BUY" && action !== "SELL") || (type !== "PUT" && type !== "CALL")) return null;
      if (!Number.isFinite(strike) || !Number.isFinite(delta)) return null;
      return {
        action: action as "BUY" | "SELL",
        type: type as "PUT" | "CALL",
        strike,
        delta,
        qty: Number(item.qty ?? 1),
      };
    });
  const legs = mappedLegs.filter((v): v is NonNullable<typeof v> => v !== null);
  const alert: AlertItem = {
    id: String(row.id ?? ""),
    type: typeRaw as AlertItem["type"],
    strategy,
    timeEt: String(row.timeEt ?? ""),
    spot: Number(row.spot ?? 0),
    legs,
    credit: row.credit == null ? null : Number(row.credit),
    debit: row.debit == null ? null : Number(row.debit),
    plPct: row.plPct == null ? null : Number(row.plPct),
    popPct: row.popPct == null ? null : Number(row.popPct),
    reason,
    severity: "caution",
    checklistSummary: String(row.checklistSummary ?? ""),
  };
  const state = loadAlertAckState();
  const fp = alertFingerprint(alert);
  const material = alertMaterialKey(alert);
  const nowIso = new Date().toISOString();
  const filtered = state.entries.filter((entry) => entry.fingerprint !== fp);
  filtered.push({ fingerprint: fp, material_key: material, acked_at_iso: nowIso });
  saveAlertAckState({ entries: filtered });
  return { ok: true, message: "Alert acknowledged." };
}

function appendSnapshotLog(payload: DashboardPayload): void {
  try {
    const row = {
      ts_iso: new Date().toISOString(),
      generated_et: payload.generatedAtEt,
      generated_paris: payload.generatedAtParis,
      market_source: payload.market.source,
      market_open: payload.market.isOpen,
      regime: payload.regimeSummary?.regime ?? "UNCLASSIFIED",
      favored_strategy: payload.regimeSummary?.favoredStrategy ?? "None",
      regime_confidence_pct: payload.regimeSummary?.confidencePct ?? null,
      trend_direction: payload.regimeSummary?.trendDirection ?? null,
      metrics: {
        spx: payload.metrics.spx,
        emr: payload.metrics.emr,
        vix: payload.metrics.vix,
        atr1m: payload.metrics.atr1m,
        range15mPctEm: payload.metrics.range15mPctEm,
      },
      candidates: payload.candidates.map((c) => ({
        strategy: c.strategy,
        ready: c.ready,
        reason: c.reason,
        credit: c.credit,
        width: c.width,
        maxRisk: c.maxRisk,
        popPct: c.popPct,
      })),
      alerts: payload.alerts.map((a) => ({
        id: a.id,
        type: a.type,
        strategy: a.strategy,
        reason: a.reason,
      })),
      bwb: {
        ready: Boolean(payload.bwb?.ready),
        hasOpenPosition: Boolean(payload.bwb?.openPosition),
        shouldExit: Boolean((payload.bwb?.monitor as Record<string, unknown> | undefined)?.should_exit),
        reason: String(payload.bwb?.reason ?? ""),
      },
      warnings: payload.warnings ?? [],
      stale_data: payload.staleData ?? null,
      data_contract: payload.dataContract ?? null,
      evaluation: payload.evaluation ?? null,
      data_feed_ages_ms:
        payload.dataContract?.feeds != null
          ? Object.fromEntries(
              Object.entries(payload.dataContract.feeds).map(([key, feed]) => [
                key,
                typeof feed.ageMs === "number" ? feed.ageMs : null,
              ]),
            )
          : null,
      checklist_statuses: payload.candidates.map((c) => ({
        strategy: c.strategy,
        global: c.checklist?.global?.map((r) => ({ name: r.name, status: r.status })) ?? [],
        regime: c.checklist?.regime?.map((r) => ({ name: r.name, status: r.status })) ?? [],
        strategy_rows: c.checklist?.strategy?.map((r) => ({ name: r.name, status: r.status })) ?? [],
      })),
      preflight_go: payload.preflight?.go ?? null,
      open_risk_heatmap: payload.openRiskHeatmap ?? null,
    };
    mkdirSync(path.dirname(SNAPSHOT_LOG_PATH), { recursive: true });
    writeFileSync(SNAPSHOT_LOG_PATH, `${JSON.stringify(row)}\n`, { flag: "a" });
  } catch {
    // keep GET resilient
  }
}

function persistLastChartSeries(payload: DashboardPayload): void {
  try {
    const spot = Number(payload.metrics?.spx);
    const priceSeries = Array.isArray(payload.priceSeries) ? payload.priceSeries : [];
    if (!Number.isFinite(spot) || spot <= 1000 || priceSeries.length === 0) return;
    mkdirSync(path.dirname(LAST_CHART_SERIES_PATH), { recursive: true });
    writeFileSync(
      LAST_CHART_SERIES_PATH,
      JSON.stringify(
        {
          updatedAtIso: new Date().toISOString(),
          generatedAtEt: payload.generatedAtEt,
          source: payload.market?.source ?? "unknown",
          spot,
          priceSeries,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // non-fatal cache write
  }
}

function readSnapshotLogRows(limit: number): Array<Record<string, unknown>> {
  try {
    if (!existsSync(SNAPSHOT_LOG_PATH)) return [];
    const text = readFileSync(SNAPSHOT_LOG_PATH, "utf8");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const sliced = lines.slice(-Math.max(50, Math.min(limit, 5000)));
    const out: Array<Record<string, unknown>> = [];
    for (const line of sliced) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        out.push(parsed);
      } catch {
        // ignore invalid line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function buildReplaySummary(limit: number): Record<string, unknown> {
  const rows = readSnapshotLogRows(limit);
  const strategyStats = new Map<string, { ready: number; total: number; transitions: number; lastReady: boolean | null }>();
  const regimeCounts = new Map<string, number>();
  const transitions: Array<{ ts_iso: string; strategy: string; reason: string }> = [];
  let entryAlerts = 0;
  let exitAlerts = 0;

  for (const row of rows) {
    const regime = String(row.regime ?? "UNCLASSIFIED");
    regimeCounts.set(regime, (regimeCounts.get(regime) ?? 0) + 1);
    const candidates = Array.isArray(row.candidates) ? row.candidates : [];
    for (const raw of candidates) {
      const card = raw as Record<string, unknown>;
      const strategy = String(card.strategy ?? "");
      if (!strategy) continue;
      const ready = Boolean(card.ready);
      const reason = String(card.reason ?? "");
      const stats = strategyStats.get(strategy) ?? { ready: 0, total: 0, transitions: 0, lastReady: null };
      stats.total += 1;
      if (ready) stats.ready += 1;
      if (stats.lastReady === false && ready) {
        stats.transitions += 1;
        transitions.push({
          ts_iso: String(row.ts_iso ?? ""),
          strategy,
          reason,
        });
      }
      stats.lastReady = ready;
      strategyStats.set(strategy, stats);
    }
    const alerts = Array.isArray(row.alerts) ? row.alerts : [];
    for (const rawAlert of alerts) {
      const t = String((rawAlert as Record<string, unknown>).type ?? "");
      if (t === "ENTRY") entryAlerts += 1;
      if (t === "EXIT") exitAlerts += 1;
    }
  }

  const byStrategy = Array.from(strategyStats.entries()).map(([strategy, stats]) => ({
    strategy,
    ready_samples: stats.ready,
    total_samples: stats.total,
    ready_rate_pct: stats.total > 0 ? (stats.ready / stats.total) * 100 : 0,
    ready_transitions: stats.transitions,
  }));
  const byRegime = Array.from(regimeCounts.entries()).map(([regime, count]) => ({ regime, count }));
  const firstTs = rows.length > 0 ? String(rows[0].ts_iso ?? "") : null;
  const lastTs = rows.length > 0 ? String(rows[rows.length - 1].ts_iso ?? "") : null;

  return {
    rows_analyzed: rows.length,
    first_ts_iso: firstTs,
    last_ts_iso: lastTs,
    entry_alert_samples: entryAlerts,
    exit_alert_samples: exitAlerts,
    by_strategy: byStrategy,
    by_regime: byRegime,
    transitions: transitions.slice(-50).reverse(),
  };
}

function parseClockToSeconds(value: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = Number(match[3] ?? "0");
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return null;
  return hh * 3600 + mm * 60 + ss;
}

function estimateDataAgeSeconds(payload: DashboardPayload): number | null {
  const generatedSec = parseClockToSeconds(payload.generatedAtEt);
  const lastPricePoint = payload.priceSeries[payload.priceSeries.length - 1];
  const candleSec = lastPricePoint ? parseClockToSeconds(lastPricePoint.t) : null;
  if (generatedSec == null || candleSec == null) return null;
  let diff = generatedSec - candleSec;
  if (diff < 0) diff += 24 * 3600;
  if (diff > 6 * 3600) return null;
  return diff;
}

function feedAgeMs(payload: DashboardPayload, key: "underlying_price" | "intraday_candles" | "option_chain" | "greeks"): number | null {
  const feed = (payload.dataFeeds ?? {})[key] as { timestampIso?: string | null } | undefined;
  const ts = parseIsoMs(feed?.timestampIso ?? undefined);
  if (ts == null) return null;
  return Math.max(0, Date.now() - ts);
}

function freshnessPolicySec() {
  const fallback = (value: unknown, base: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return base;
    return Math.max(1, Math.min(3_600, Math.round(n)));
  };
  return {
    spot_max_age_s: fallback(process.env.SPX0DTE_SPOT_MAX_AGE_S, 2),
    chain_max_age_s: fallback(process.env.SPX0DTE_CHAIN_MAX_AGE_S, 5),
    greeks_max_age_s: fallback(process.env.SPX0DTE_GREEKS_MAX_AGE_S, 5),
  };
}

function toFiniteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeIvDecimal(value: unknown): number | null {
  const iv = toFiniteNumber(value);
  if (iv == null || iv <= 0) return null;
  return iv > 3 ? iv / 100 : iv;
}

function extractIvAtm(payload: DashboardPayload): number | null {
  for (const target of payload.multiDte?.targets ?? []) {
    const rec = (target.recommendation ?? null) as Record<string, unknown> | null;
    const metrics = (target.metrics ?? {}) as Record<string, unknown>;
    const iv =
      normalizeIvDecimal(rec?.iv_atm) ??
      normalizeIvDecimal(metrics.iv_atm) ??
      normalizeIvDecimal(metrics.iv);
    if (iv != null) return iv;
  }

  const twoDteRec = (payload.twoDte?.recommendation ?? null) as Record<string, unknown> | null;
  const twoDteMetrics = (payload.twoDte?.metrics ?? {}) as Record<string, unknown>;
  return (
    normalizeIvDecimal(twoDteRec?.iv_atm) ??
    normalizeIvDecimal(twoDteMetrics.iv_atm) ??
    normalizeIvDecimal(twoDteMetrics.iv) ??
    normalizeIvDecimal(payload.metrics?.iv)
  );
}

function extractIvTerm(payload: DashboardPayload): Record<number, number | null> {
  const out: Record<number, number | null> = {};
  for (const target of payload.multiDte?.targets ?? []) {
    const bucket = Number(target.selected_dte ?? target.target_dte);
    if (!Number.isFinite(bucket) || bucket <= 0) continue;
    const rec = (target.recommendation ?? null) as Record<string, unknown> | null;
    const metrics = (target.metrics ?? {}) as Record<string, unknown>;
    out[Math.round(bucket)] =
      normalizeIvDecimal(rec?.iv_atm) ??
      normalizeIvDecimal(metrics.iv_atm) ??
      normalizeIvDecimal(metrics.iv);
  }
  return out;
}

function withDataModeAndAges(payload: DashboardPayload, marketClosedOverride: boolean): DashboardPayload {
  const ages = {
    spot: feedAgeMs(payload, "underlying_price"),
    candles: feedAgeMs(payload, "intraday_candles"),
    chain: feedAgeMs(payload, "option_chain"),
    greeks: feedAgeMs(payload, "greeks"),
  };
  const inferred = resolveDataMode({
    source: payload.market?.source ?? "unknown",
    session: payload.market?.isOpen ? "OPEN" : "CLOSED",
    simulationMode: marketClosedOverride,
    freshnessAges: ages,
    freshnessPolicy: freshnessPolicySec(),
  });
  return {
    ...payload,
    data_mode: marketClosedOverride ? "HISTORICAL" : inferred,
    data_age_ms: ages,
    market_closed_override: marketClosedOverride,
  };
}

function buildDecisionInput(payload: DashboardPayload): DecisionInput {
  const freshnessPolicy = freshnessPolicySec();
  const ages = {
    spot: typeof payload.data_age_ms?.spot === "number" ? payload.data_age_ms.spot : null,
    chain: typeof payload.data_age_ms?.chain === "number" ? payload.data_age_ms.chain : null,
    greeks: typeof payload.data_age_ms?.greeks === "number" ? payload.data_age_ms.greeks : null,
    candles: typeof payload.data_age_ms?.candles === "number" ? payload.data_age_ms.candles : null,
  };
  const fallbackMode = resolveDataMode({
    source: payload.market?.source ?? "unknown",
    session: payload.market?.isOpen ? "OPEN" : "CLOSED",
    simulationMode: Boolean(payload.market_closed_override),
    freshnessAges: ages,
    freshnessPolicy,
  });
  const spot = toFiniteNumber(payload.metrics?.spx);
  const ivAtm = extractIvAtm(payload);
  const ivTerm = extractIvTerm(payload);
  const vix = toFiniteNumber(payload.metrics?.vix);
  const prevSpot = (() => {
    const rows = payload.priceSeries ?? [];
    if (rows.length < 2) return null;
    return toFiniteNumber(rows[rows.length - 2]?.price);
  })();
  const ivSamplePack =
    ivAtm == null
      ? { samples: [] as Array<{ tsIso: string; iv_atm: number }> }
      : recordIvSample(
          {
            tsIso: new Date().toISOString(),
            iv_atm: ivAtm,
          },
          {
            lookbackDays: Math.max(10, Number(process.env.VOL_LOOKBACK_DAYS ?? 60)),
          },
        );

  return {
    asOfIso: new Date().toISOString(),
    source: payload.market?.source ?? "unknown",
    dataMode: payload.data_mode ?? fallbackMode,
    session: payload.market?.isOpen ? "OPEN" : "CLOSED",
    simulationMode: Boolean(payload.market_closed_override),
    allowSimAlerts: ALLOW_SIM_ALERTS,
    strictLiveBlocks: STRICT_LIVE_BLOCKS,
    feature0dte: FEATURE_0DTE,
    freshnessAges: ages,
    freshnessPolicy,
    regime: payload.regimeSummary?.regime ?? null,
    warnings: payload.warnings ?? [],
    candidates: payload.candidates ?? [],
    strategyEligibility: payload.strategyEligibility ?? [],
    multiDteTargets: payload.multiDte?.targets ?? [],
    alerts: payload.alerts ?? [],
    evaluationTick: payload.evaluation,
    vol: {
      spot,
      iv_atm: ivAtm,
      iv_term: ivTerm,
      realized_range_proxy: toFiniteNumber(payload.metrics?.atr1m),
      vix,
      prevSpot,
      prevVix: null,
      samples: ivSamplePack.samples,
      freshnessAges: {
        spot: ages.spot,
        iv_atm: ages.chain,
        vix: ages.spot,
        realized: ages.candles,
      },
    },
  };
}

function applyStaleDataKillSwitch(payload: DashboardPayload): DashboardPayload {
  const thresholdSeconds = (() => {
    const raw = Number(process.env.SPX0DTE_STALE_MAX_SECONDS ?? 90);
    if (!Number.isFinite(raw)) return 90;
    return Math.max(30, Math.min(1_800, Math.round(raw)));
  })();

  const ageSeconds = estimateDataAgeSeconds(payload);
  const noLiveBars = payload.market.isOpen && payload.priceSeries.length === 0;
  const staleByAge = payload.market.isOpen && ageSeconds != null && ageSeconds > thresholdSeconds;
  const staleBySource = payload.market.isOpen && payload.market.source === "live-unavailable";
  const nonLiveSource = payload.market.isOpen && payload.market.source !== "tastytrade-live";
  const active = noLiveBars || staleByAge || staleBySource || nonLiveSource;
  const detail = noLiveBars
    ? "No live intraday bars detected."
    : staleBySource
      ? "Live source unavailable."
      : nonLiveSource
        ? `Live source required; current source is ${payload.market.source}.`
      : staleByAge
        ? `Data age ${ageSeconds}s exceeds ${thresholdSeconds}s threshold.`
        : ageSeconds == null
          ? "Data age unavailable."
          : `Data age ${ageSeconds}s within threshold.`;

  let next = {
    ...payload,
    staleData: {
      active,
      ageSeconds,
      thresholdSeconds,
      detail,
    },
  };
  if (!active) return next;

  const staleReason = `Data stale: ${detail}`;
  next = {
    ...next,
    candidates: next.candidates.map((candidate) => ({
      ...candidate,
      ready: false,
      blockedReason: staleReason,
      reason: staleReason,
      checklist: candidate.checklist
        ? {
            ...candidate.checklist,
            global: [
              {
                name: "Live data freshness <= threshold",
                status: "blocked",
                detail,
                required: true,
              },
              ...candidate.checklist.global.filter((row) => row.name !== "Live data freshness <= threshold"),
            ],
          }
        : candidate.checklist,
    })),
    globalChecklist: [
      {
        name: "Live data freshness <= threshold",
        status: "blocked",
        detail,
        required: true,
      },
      ...(next.globalChecklist ?? []).filter((row) => row.name !== "Live data freshness <= threshold"),
    ],
    alerts: next.alerts.filter((alert) => alert.type !== "ENTRY"),
    warnings: Array.from(new Set([...(next.warnings ?? []), "Data stale. New entries blocked."])).slice(0, 2),
  };
  return next;
}

function applyDataContract(payload: DashboardPayload): DashboardPayload {
  const contract = evaluateDataContract(payload, Date.now(), { allowClosedEvaluation: SIMULATION_MODE });
  const checkedAtEt = payload.generatedAtEt ? `${payload.generatedAtEt} ET` : undefined;

  const applyRows = (
    rows: Array<{ name: string; status: "pass" | "fail" | "blocked" | "na"; detail?: string; required?: boolean }>,
    section: "global" | "regime" | "strategy",
    strategy?: Strategy,
  ) => applyDataContractToRows(rows, section, strategy, contract, { strictLiveBlocks: STRICT_LIVE_BLOCKS });

  let next: DashboardPayload = {
    ...payload,
    globalChecklist: applyRows(payload.globalChecklist ?? [], "global"),
    candidates: payload.candidates.map((candidate) => {
      if (!candidate.checklist) return candidate;
      return {
        ...candidate,
        checklist: {
          global: applyRows(candidate.checklist.global ?? [], "global", candidate.strategy),
          regime: applyRows(candidate.checklist.regime ?? [], "regime", candidate.strategy),
          strategy: applyRows(candidate.checklist.strategy ?? [], "strategy", candidate.strategy),
        },
      };
    }),
    twoDte: payload.twoDte
      ? {
          ...payload.twoDte,
          checklist: applyRows(payload.twoDte.checklist ?? [], "strategy", "2-DTE Credit Spread"),
        }
      : payload.twoDte,
    bwb: payload.bwb
      ? {
          ...payload.bwb,
          checklist: applyRows(payload.bwb.checklist ?? [], "strategy", "Broken-Wing Put Butterfly"),
        }
      : payload.bwb,
    dataContract: {
      status: contract.status,
      checkedAtIso: contract.checkedAtIso,
      checkedAtEt,
      issues: contract.issues,
      feeds: Object.fromEntries(
        Object.entries(contract.feeds).map(([key, feed]) => [
          key,
          {
            key: feed.key,
            label: feed.label,
            maxAgeMs: feed.maxAgeMs,
            source: feed.source,
            ageMs: feed.ageMs,
            isValid: feed.isValid,
            error: feed.error,
          },
        ]),
      ),
    },
  };

  if (contract.status !== "degraded" || !payload.market.isOpen) {
    return next;
  }

  const issue = contract.issues[0] ?? "Data contract degraded.";
  if (!STRICT_LIVE_BLOCKS) {
    return {
      ...next,
      warnings: Array.from(new Set([...(next.warnings ?? []), `DEGRADED: ${issue}`])).slice(0, 3),
    };
  }

  const gateRow = {
    name: "System Health gate (data contract)",
    status: "blocked" as const,
    detail: issue,
    reason: issue,
    required: true,
    id: "global.system-health-gate",
    label: "System Health gate (data contract)",
    requires: [],
    dataAgeMs: {},
  };

  const addGate = (
    rows: Array<{ name: string; status: "pass" | "fail" | "blocked" | "na"; detail?: string; required?: boolean }>,
  ) => [gateRow, ...rows.filter((row) => row.name !== gateRow.name)];

  next = {
    ...next,
    globalChecklist: addGate((next.globalChecklist ?? []) as Array<{ name: string; status: "pass" | "fail" | "blocked" | "na"; detail?: string; required?: boolean }>),
    candidates: next.candidates.map((candidate) => ({
      ...candidate,
      ready: false,
      blockedReason: `DEGRADED: ${issue}`,
      reason: `DEGRADED: ${issue}`,
      checklist: candidate.checklist
        ? {
            ...candidate.checklist,
            global: addGate(candidate.checklist.global),
          }
        : candidate.checklist,
    })),
    strategyEligibility: (next.strategyEligibility ?? []).map((row) => ({
      ...row,
      status: "blocked",
      reason: `DEGRADED: ${issue}`,
    })),
    warnings: Array.from(new Set([...(next.warnings ?? []), `DEGRADED: ${issue}`])).slice(0, 3),
    alerts: (next.alerts ?? []).filter((alert) => alert.type !== "ENTRY"),
  };
  return next;
}

function legSignatureFromCandidate(candidate: DashboardPayload["candidates"][number]): string {
  if (!Array.isArray(candidate.legs) || candidate.legs.length === 0) return "NOLEGS";
  return candidate.legs.map((leg) => `${leg.action}:${leg.type}:${Math.round(leg.strike)}`).join("|");
}

function loadEntryDebounceState(): EntryDebounceState {
  try {
    if (!existsSync(ENTRY_DEBOUNCE_STATE_PATH)) {
      return { updatedAtIso: new Date().toISOString(), byKey: {} };
    }
    const parsed = JSON.parse(readFileSync(ENTRY_DEBOUNCE_STATE_PATH, "utf8")) as EntryDebounceState;
    if (!parsed || typeof parsed !== "object" || typeof parsed.byKey !== "object" || parsed.byKey == null) {
      return { updatedAtIso: new Date().toISOString(), byKey: {} };
    }
    return {
      updatedAtIso: String(parsed.updatedAtIso ?? new Date().toISOString()),
      byKey: parsed.byKey,
    };
  } catch {
    return { updatedAtIso: new Date().toISOString(), byKey: {} };
  }
}

function saveEntryDebounceState(state: EntryDebounceState): void {
  try {
    mkdirSync(path.dirname(ENTRY_DEBOUNCE_STATE_PATH), { recursive: true });
    writeFileSync(ENTRY_DEBOUNCE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // best effort
  }
}

function applyEntryDebounce(payload: DashboardPayload): DashboardPayload {
  const requiredTicks = Math.max(1, Number(process.env.SPX0DTE_ENTRY_STABILITY_TICKS ?? 2));
  if (!payload.market.isOpen) {
    saveEntryDebounceState({ updatedAtIso: new Date().toISOString(), byKey: {} });
    return payload;
  }

  const state = loadEntryDebounceState();
  const nowIso = new Date().toISOString();
  const nextByKey: EntryDebounceState["byKey"] = {};
  const stableStrategies = new Set<Strategy>();
  const debugNotes: string[] = [];

  for (const candidate of payload.candidates) {
    const key = `${candidate.strategy}|${legSignatureFromCandidate(candidate)}`;
    const prev = state.byKey[key];
    const ready = Boolean(candidate.ready);
    const consecutiveReady = ready ? (prev?.consecutiveReady ?? 0) + 1 : 0;
    nextByKey[key] = {
      consecutiveReady,
      lastReady: ready,
      lastSeenIso: nowIso,
    };
    if (ready && consecutiveReady >= requiredTicks) {
      stableStrategies.add(candidate.strategy);
    } else if (ready && requiredTicks > 1) {
      debugNotes.push(`${candidate.strategy} stability ${consecutiveReady}/${requiredTicks}`);
    }
  }

  saveEntryDebounceState({ updatedAtIso: nowIso, byKey: nextByKey });

  const alerts = payload.alerts.filter((alert) => {
    if (alert.type !== "ENTRY") return true;
    return stableStrategies.has(alert.strategy);
  });

  const warnings = debugNotes.length > 0
    ? Array.from(new Set([...(payload.warnings ?? []), `Entry debounce: ${debugNotes.slice(0, 2).join("; ")}`])).slice(0, 3)
    : payload.warnings;

  return {
    ...payload,
    alerts,
    warnings,
  };
}

function withStrategyChecklistRow(
  candidate: DashboardPayload["candidates"][number],
  row: { name: string; status: "pass" | "fail" | "blocked" | "na"; detail: string; required?: boolean },
): DashboardPayload["candidates"][number] {
  const checklist = candidate.checklist ?? { global: [], regime: [], strategy: [] };
  return {
    ...candidate,
    checklist: {
      ...checklist,
      strategy: [...(checklist.strategy ?? []), row],
    },
  };
}

function blockCandidateWithReason(
  candidate: DashboardPayload["candidates"][number],
  reason: string,
  rowName: string,
): DashboardPayload["candidates"][number] {
  const next = withStrategyChecklistRow(candidate, {
    name: rowName,
    status: "fail",
    detail: reason,
    required: true,
  });
  return {
    ...next,
    ready: false,
    blockedReason: reason,
    reason,
  };
}

function applySnapshotHeaderIntegrityGuards(payload: DashboardPayload, ctx: ReqCtx): DashboardPayload {
  const raw = (payload.symbolValidation ?? null) as Record<string, unknown> | null;
  if (!raw) return payload;
  const chain = (raw.chain ?? {}) as Record<string, unknown>;
  const checks = (raw.checks ?? {}) as Record<string, unknown>;
  const targets = (raw.targets ?? {}) as Record<string, unknown>;
  const expirationsPresent = new Set<string>(
    Array.isArray(chain.expirationsPresent) ? chain.expirationsPresent.map((v) => String(v)) : [],
  );
  const spot = Number(payload.metrics?.spx ?? Number.NaN);
  const maxRel = Number(process.env.SPX0DTE_MAX_REL_STRIKE_DISTANCE ?? 0.08);
  const maxAbs = Number(process.env.SPX0DTE_MAX_ABS_STRIKE_DISTANCE ?? 600);

  const marketNeedsFreshness = Boolean(
    payload.market.isOpen &&
      (payload.data_mode === "LIVE" || payload.data_mode === "DELAYED" || payload.market.source.startsWith("tastytrade-")),
  );
  const spotAgeOk = checks.spot_age_ok === true;
  const chainAgeOk = checks.chain_age_ok === true;
  const greeksAgeOk = checks.greeks_age_ok === true;
  const greeksMatchChain = checks.greeks_match_chain === true;

  let candidates = payload.candidates.map((candidate) => {
    const dteMatch = String(candidate.strategy).match(/(\d+)-DTE/i);
    const targetDte = dteMatch ? Number(dteMatch[1]) : null;
    let next = candidate;

    const shortLeg = (candidate.legs ?? []).find((leg) => leg.action === "SELL");
    if (candidate.ready && Number.isFinite(spot) && shortLeg && Number.isFinite(shortLeg.strike)) {
      const absDistance = Math.abs(shortLeg.strike - spot);
      const relDistance = absDistance / Math.max(Math.abs(spot), 1e-9);
      if (relDistance > maxRel || absDistance > maxAbs) {
        const reason = `BLOCKED: Strike/spot mismatch (spot=${spot.toFixed(2)}, short=${shortLeg.strike.toFixed(2)}, rel=${relDistance.toFixed(4)}, chain_ts=${payload.dataFeeds?.option_chain?.timestampIso ?? "n/a"}, spot_ts=${payload.dataFeeds?.underlying_price?.timestampIso ?? "n/a"})`;
        debugLog(ctx, "integrity_block", {
          target_dte: targetDte,
          selected_expiry: null,
          short_strike: shortLeg.strike,
          long_strike: (candidate.legs ?? []).find((leg) => leg.action === "BUY")?.strike ?? null,
          spot,
          rel_distance: relDistance,
          spot_ts: payload.dataFeeds?.underlying_price?.timestampIso ?? null,
          chain_ts: payload.dataFeeds?.option_chain?.timestampIso ?? null,
          greeks_ts: payload.dataFeeds?.greeks?.timestampIso ?? null,
          data_mode: payload.data_mode ?? null,
          reason: "strike_sanity",
        });
        next = blockCandidateWithReason(next, reason, "Strike sanity");
      }
    }

    if (targetDte != null && Number.isFinite(targetDte)) {
      const targetNode = (targets[String(targetDte)] ?? {}) as Record<string, unknown>;
      const selectedExpiry = typeof targetNode.expiration === "string" ? targetNode.expiration : null;
      if (next.ready && selectedExpiry && !expirationsPresent.has(selectedExpiry)) {
        const reason = `BLOCKED: Chain missing selected expiry ${selectedExpiry} for target ${targetDte}`;
        debugLog(ctx, "integrity_block", {
          target_dte: targetDte,
          selected_expiry: selectedExpiry,
          short_strike: (next.legs ?? []).find((leg) => leg.action === "SELL")?.strike ?? null,
          long_strike: (next.legs ?? []).find((leg) => leg.action === "BUY")?.strike ?? null,
          spot,
          rel_distance: null,
          spot_ts: payload.dataFeeds?.underlying_price?.timestampIso ?? null,
          chain_ts: payload.dataFeeds?.option_chain?.timestampIso ?? null,
          greeks_ts: payload.dataFeeds?.greeks?.timestampIso ?? null,
          data_mode: payload.data_mode ?? null,
          reason: "missing_selected_expiry",
        });
        next = blockCandidateWithReason(next, reason, "Chain expiry presence");
      }

      const symbols = new Set(
        Array.isArray(targetNode.symbols) ? targetNode.symbols.map((v) => String(v).toUpperCase()) : [],
      );
      if (next.ready && symbols.size > 0) {
        const missing = (next.legs ?? [])
          .map((leg) => String(leg.symbol ?? "").toUpperCase())
          .filter((sym) => sym && !symbols.has(sym));
        if (missing.length > 0) {
          const reason = `BLOCKED: Leg not found in chain (${missing.slice(0, 2).join(", ")})`;
          debugLog(ctx, "integrity_block", {
            target_dte: targetDte,
            selected_expiry: selectedExpiry,
            short_strike: (next.legs ?? []).find((leg) => leg.action === "SELL")?.strike ?? null,
            long_strike: (next.legs ?? []).find((leg) => leg.action === "BUY")?.strike ?? null,
            spot,
            rel_distance: null,
            spot_ts: payload.dataFeeds?.underlying_price?.timestampIso ?? null,
            chain_ts: payload.dataFeeds?.option_chain?.timestampIso ?? null,
            greeks_ts: payload.dataFeeds?.greeks?.timestampIso ?? null,
            data_mode: payload.data_mode ?? null,
            reason: "missing_leg_symbol",
          });
          next = blockCandidateWithReason(next, reason, "Leg presence");
        }
      }
    }

    if (next.ready) {
      const greek = next.greeks ?? {};
      const haveLegGreeks =
        Number.isFinite(Number(greek.delta)) &&
        Number.isFinite(Number(greek.gamma)) &&
        Number.isFinite(Number(greek.theta)) &&
        Number.isFinite(Number(greek.vega));
      if (!haveLegGreeks || (marketNeedsFreshness && (!greeksAgeOk || !greeksMatchChain))) {
        const reason = !haveLegGreeks
          ? "BLOCKED: Greeks missing for one or more legs."
          : "BLOCKED: Greeks feed stale/mismatched for selected legs.";
        debugLog(ctx, "integrity_block", {
          target_dte: targetDte,
          selected_expiry: null,
          short_strike: (next.legs ?? []).find((leg) => leg.action === "SELL")?.strike ?? null,
          long_strike: (next.legs ?? []).find((leg) => leg.action === "BUY")?.strike ?? null,
          spot,
          rel_distance: null,
          spot_ts: payload.dataFeeds?.underlying_price?.timestampIso ?? null,
          chain_ts: payload.dataFeeds?.option_chain?.timestampIso ?? null,
          greeks_ts: payload.dataFeeds?.greeks?.timestampIso ?? null,
          data_mode: payload.data_mode ?? null,
          reason: "greeks_inconsistent",
        });
        next = blockCandidateWithReason(next, reason, "Greeks consistency");
      }
    }

    return next;
  });

  if (marketNeedsFreshness && STRICT_LIVE_BLOCKS && (!spotAgeOk || !chainAgeOk || !greeksAgeOk)) {
    const issue = `BLOCKED: feed freshness failed (spot_age_ok=${spotAgeOk}, chain_age_ok=${chainAgeOk}, greeks_age_ok=${greeksAgeOk})`;
    candidates = candidates.map((candidate) => blockCandidateWithReason(candidate, issue, "Snapshot feed freshness"));
  }

  return {
    ...payload,
    candidates,
    strategyEligibility: (payload.strategyEligibility ?? []).map((row) => {
      const candidate = candidates.find((c) => c.strategy === row.strategy);
      if (!candidate) return row;
      return {
        ...row,
        status: candidate.ready ? "pass" : "fail",
        reason: candidate.ready ? row.reason : (candidate.blockedReason || row.reason),
      };
    }),
  };
}

function loadEvaluationState(): EvaluationRuntimeState {
  try {
    if (!existsSync(EVALUATION_STATE_PATH)) {
      return { tickId: 0, lastTickIso: new Date().toISOString() };
    }
    const parsed = JSON.parse(readFileSync(EVALUATION_STATE_PATH, "utf8")) as EvaluationRuntimeState;
    const tickId = Number(parsed?.tickId);
    return {
      tickId: Number.isFinite(tickId) && tickId >= 0 ? Math.floor(tickId) : 0,
      lastTickIso: String(parsed?.lastTickIso ?? new Date().toISOString()),
    };
  } catch {
    return { tickId: 0, lastTickIso: new Date().toISOString() };
  }
}

function saveEvaluationState(state: EvaluationRuntimeState): void {
  try {
    mkdirSync(path.dirname(EVALUATION_STATE_PATH), { recursive: true });
    writeFileSync(EVALUATION_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // best effort
  }
}

function loadProviderHealthState(): ProviderHealthState {
  try {
    if (!existsSync(PROVIDER_HEALTH_STATE_PATH)) {
      return {
        provider_status: "down",
        auth_status: "failed",
        last_auth_ok_ts: null,
        updated_at: new Date().toISOString(),
        issue_codes: [],
      };
    }
    const parsed = JSON.parse(readFileSync(PROVIDER_HEALTH_STATE_PATH, "utf8")) as ProviderHealthState;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid state");
    return {
      provider_status: parsed.provider_status ?? "down",
      auth_status: parsed.auth_status ?? "failed",
      last_auth_ok_ts: parsed.last_auth_ok_ts ?? null,
      updated_at: parsed.updated_at ?? new Date().toISOString(),
      issue_codes: Array.isArray(parsed.issue_codes) ? parsed.issue_codes.map((v) => String(v)) : [],
      source: parsed.source ? String(parsed.source) : undefined,
    };
  } catch {
    return {
      provider_status: "down",
      auth_status: "failed",
      last_auth_ok_ts: null,
      updated_at: new Date().toISOString(),
      issue_codes: [],
    };
  }
}

function saveProviderHealthState(payload: DashboardPayload): void {
  try {
    const current = loadProviderHealthState();
    const warnings = (payload.warnings ?? []).map((w) => String(w));
    const hasAuthFailure = warnings.some((w) => /tasty_auth_failed|auth failed|unable to authenticate/i.test(w));
    const issueCodes = hasAuthFailure ? ["TASTY_AUTH_FAILED"] : [];
    const source = String(payload.market?.source ?? "unknown");
    const providerStatus: ProviderHealthState["provider_status"] =
      source === "tastytrade-live"
        ? "tastytrade-live"
        : source.includes("tastytrade")
          ? "tastytrade-partial"
          : "down";
    const authStatus: ProviderHealthState["auth_status"] = hasAuthFailure
      ? "failed"
      : providerStatus === "tastytrade-live"
        ? "ok"
        : "refreshing";

    const next: ProviderHealthState = {
      provider_status: providerStatus,
      auth_status: authStatus,
      last_auth_ok_ts: authStatus === "ok" ? new Date().toISOString() : current.last_auth_ok_ts,
      updated_at: new Date().toISOString(),
      issue_codes: issueCodes,
      source,
    };
    mkdirSync(path.dirname(PROVIDER_HEALTH_STATE_PATH), { recursive: true });
    writeFileSync(PROVIDER_HEALTH_STATE_PATH, JSON.stringify(next, null, 2));
  } catch {
    // best effort
  }
}

function withEvaluationTick(payload: DashboardPayload): DashboardPayload {
  const intervalMs = Math.max(5_000, Math.min(10_000, Number(process.env.SPX0DTE_EVAL_INTERVAL_MS ?? 5_000)));
  const debounceTicks = Math.max(1, Number(process.env.SPX0DTE_ENTRY_STABILITY_TICKS ?? 2));
  const state = loadEvaluationState();
  const tickId = payload.market.isOpen ? state.tickId + 1 : state.tickId;
  const nowIso = new Date().toISOString();
  saveEvaluationState({ tickId, lastTickIso: nowIso });
  return {
    ...payload,
    evaluation: {
      tickId,
      intervalMs,
      debounceTicks,
      checkedAtIso: nowIso,
    },
  };
}

function isDebitStrategy(strategy: string): boolean {
  return strategy === "Convex Debit Spread";
}

type ExecutionTimeBucket = "open" | "midday" | "late" | "close";

function parseEtClockMinutes(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(clock.trim());
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function executionTimeBucketFromGeneratedEt(generatedEt: string): ExecutionTimeBucket {
  const mins = parseEtClockMinutes(generatedEt);
  if (mins == null) return "midday";
  if (mins <= 10 * 60 + 45) return "open";
  if (mins <= 12 * 60 + 30) return "midday";
  if (mins <= 14 * 60 + 30) return "late";
  return "close";
}

function executionTimeBucketMultiplier(model: ExecutionModelSettings, bucket: ExecutionTimeBucket): number {
  if (bucket === "open") return model.openBucketMultiplier;
  if (bucket === "midday") return model.midBucketMultiplier;
  if (bucket === "late") return model.lateBucketMultiplier;
  return model.closeBucketMultiplier;
}

function parseDetailNumber(detail?: string): number | null {
  if (!detail) return null;
  const match = detail.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function applyExecutionModel(payload: DashboardPayload): DashboardPayload {
  const model = loadExecutionModelSettings();
  const staleActive = Boolean(payload.staleData?.active);
  const sourceLive = payload.market.source === "tastytrade-live";
  const timeBucket = executionTimeBucketFromGeneratedEt(payload.generatedAtEt);
  const bucketMultiplier = model.enabled ? executionTimeBucketMultiplier(model, timeBucket) : 1;

  const candidates = payload.candidates.map((candidate) => {
    const width = Number(candidate.width || 0);
    const mid = Number(candidate.credit || 0);
    const hasStructure = width > 0 && mid > 0 && Array.isArray(candidate.legs) && candidate.legs.length > 0;
    const baseSlippage =
      width <= model.narrowWidthCutoff
        ? (isDebitStrategy(candidate.strategy) ? model.debitOffsetNarrow : model.creditOffsetNarrow)
        : (isDebitStrategy(candidate.strategy) ? model.debitOffsetWide : model.creditOffsetWide);
    const slippage = model.enabled && hasStructure ? baseSlippage * bucketMultiplier : 0;
    const adjusted = isDebitStrategy(candidate.strategy) ? mid + slippage : Math.max(0, mid - slippage);
    const liquidityRow = candidate.checklist?.global.find((row) => /liquidity/i.test(row.name));
    const liquidityRatio = parseDetailNumber(liquidityRow?.detail);

    let confidence: "high" | "medium" | "low" = "low";
    if (!staleActive && sourceLive && liquidityRatio != null && liquidityRatio <= 0.08) confidence = "high";
    else if (!staleActive && liquidityRatio != null && liquidityRatio <= 0.12) confidence = "medium";

    const creditLabel: "Credit" | "Debit" = isDebitStrategy(candidate.strategy) ? "Debit" : "Credit";
    const notes = `${creditLabel} (mid ${mid.toFixed(2)} → adj ${adjusted.toFixed(2)}, slip ${slippage.toFixed(2)}, ${timeBucket} x${bucketMultiplier.toFixed(2)})`;
    return {
      ...candidate,
      adjustedPremium: adjusted,
      premiumLabel: creditLabel,
      execution: {
        mid,
        adjusted,
        slippage,
        confidence,
        timeBucket,
        timeMultiplier: bucketMultiplier,
        notes,
      },
    };
  });

  const twoDteCandidate = candidates.find((candidate) => candidate.strategy === "2-DTE Credit Spread");
  const twoDteRecommendation =
    payload.twoDte?.recommendation && typeof payload.twoDte.recommendation === "object"
      ? {
          ...payload.twoDte.recommendation,
          adjusted_credit: twoDteCandidate?.adjustedPremium ?? payload.twoDte.recommendation.credit,
        }
      : payload.twoDte?.recommendation;

  return {
    ...payload,
    candidates,
    twoDte: payload.twoDte
      ? {
          ...payload.twoDte,
          recommendation: twoDteRecommendation,
        }
      : payload.twoDte,
    executionModel: {
      settings: model,
      byStrategy: STRATEGY_KEYS.map((strategy) => ({
        strategy,
        creditOffset: strategy === "Convex Debit Spread" ? 0 : model.creditOffsetNarrow,
        debitOffset: strategy === "Convex Debit Spread" ? model.debitOffsetNarrow : 0,
        markImpactPct: model.markImpactPct,
        timeBucket,
        timeMultiplier: bucketMultiplier,
      })),
    },
  };
}

function parseIso(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function applyAlertPolicy(payload: DashboardPayload): DashboardPayload {
  const policy = loadAlertPolicySettings();
  const state = loadAlertPolicyRuntimeState();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  let suppressedCount = 0;
  let changed = false;

  const allowed: AlertItem[] = [];
  for (const alert of payload.alerts) {
    const strategy = alert.strategy;
    const strategyState = state.byStrategy[strategy] ?? { sentToday: 0 };
    const cooldown = policy.cooldownSecondsByStrategy[strategy] ?? 0;
    const maxAlerts = policy.maxAlertsPerDayByStrategy[strategy] ?? 100;
    const lastMs = parseIso(strategyState.lastSentIso);
    const secondsSince = lastMs == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((nowMs - lastMs) / 1000));
    const cooldownRemaining = Math.max(0, cooldown - secondsSince);
    const sameAsLast = strategyState.lastAlertId != null && strategyState.lastAlertId === alert.id;

    const exceededDaily = strategyState.sentToday >= maxAlerts;
    const inCooldown = cooldownRemaining > 0 && !sameAsLast;
    if (!sameAsLast && (exceededDaily || inCooldown)) {
      suppressedCount += 1;
      continue;
    }
    allowed.push(alert);
    if (!sameAsLast) {
      strategyState.sentToday += 1;
      strategyState.lastSentIso = nowIso;
      strategyState.lastAlertId = alert.id;
      changed = true;
    }
    state.byStrategy[strategy] = strategyState;
  }

  if (changed) {
    saveAlertPolicyRuntimeState(state);
  }

  const byStrategy: Record<string, { sentToday: number; cooldownRemainingSec: number }> = {};
  for (const strategy of STRATEGY_KEYS) {
    const strategyState = state.byStrategy[strategy] ?? { sentToday: 0 };
    const cooldown = policy.cooldownSecondsByStrategy[strategy] ?? 0;
    const lastMs = parseIso(strategyState.lastSentIso);
    const secondsSince = lastMs == null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((nowMs - lastMs) / 1000));
    byStrategy[strategy] = {
      sentToday: strategyState.sentToday,
      cooldownRemainingSec: Math.max(0, cooldown - secondsSince),
    };
  }

  return {
    ...payload,
    alerts: allowed,
    alertPolicy: policy,
    alertPolicyState: {
      dateEt: state.dateEt,
      byStrategy,
      suppressedCount,
    },
  };
}

type PerfRow = {
  strategy: string;
  regime: string;
  pnlPct: number | null;
  macroTag: string;
  volTag: string;
};

function readAlertStateTradesRaw(): Array<Record<string, unknown>> {
  try {
    const statePath = path.join(process.cwd(), "storage", ".alert_state.json");
    if (!existsSync(statePath)) return [];
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { trades?: unknown[] };
    return Array.isArray(parsed.trades)
      ? parsed.trades.filter((row): row is Record<string, unknown> => typeof row === "object" && row != null)
      : [];
  } catch {
    return [];
  }
}

function readBwbLogRows(limit = 1000): Array<Record<string, unknown>> {
  try {
    if (!existsSync(BWB_LOG_PATH)) return [];
    const lines = readFileSync(BWB_LOG_PATH, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-limit);
    const rows: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        rows.push(parsed);
      } catch {
        // skip
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function ivChangeToVolTag(ivChangePct: number | null): string {
  if (ivChangePct == null || !Number.isFinite(ivChangePct)) return "UNKNOWN";
  if (ivChangePct >= 10) return "IV_UP_10+";
  if (ivChangePct >= 4) return "IV_UP_4_10";
  if (ivChangePct <= -10) return "IV_DOWN_10+";
  if (ivChangePct <= -4) return "IV_DOWN_4_10";
  return "IV_STABLE";
}

function buildPerfRows(): PerfRow[] {
  const rows: PerfRow[] = [];
  for (const trade of readAlertStateTradesRaw()) {
    const strategyRaw = String(trade.strategy ?? "").toUpperCase();
    const strategy =
      strategyRaw === "IRON_CONDOR"
        ? "Iron Condor"
        : strategyRaw === "IRON_FLY"
          ? "Iron Fly"
          : strategyRaw === "CREDIT_SPREAD"
            ? "Directional Spread"
            : strategyRaw === "CONVEX_DEBIT"
              ? "Convex Debit Spread"
              : strategyRaw || "Unknown";
    const pnlRaw = Number(trade.profit_pct ?? Number.NaN);
    const pnlPct = Number.isFinite(pnlRaw) ? pnlRaw * 100 : null;
    const regime = String(trade.regime_at_entry ?? "UNKNOWN");
    const macroTag = String(trade.macro_tag ?? "NONE");
    const ivChange = Number(trade.iv_change_pct_at_exit ?? Number.NaN);
    rows.push({
      strategy,
      regime,
      pnlPct,
      macroTag,
      volTag: ivChangeToVolTag(Number.isFinite(ivChange) ? ivChange : null),
    });
  }

  for (const order of loadTwoDteOrders()) {
    const status = String(order.status ?? "").toUpperCase();
    if (status !== "CLOSED" && status !== "EXIT_PENDING") continue;
    const entryCredit = Number(order.entry_credit ?? Number.NaN);
    const exitDebit = Number(order.exit_debit ?? order.mark_debit ?? Number.NaN);
    const pnlPct =
      Number.isFinite(entryCredit) && entryCredit > 0 && Number.isFinite(exitDebit)
        ? ((entryCredit - exitDebit) / entryCredit) * 100
        : null;
    rows.push({
      strategy: "2-DTE Credit Spread",
      regime: String(order.regime_at_entry ?? "UNKNOWN"),
      pnlPct,
      macroTag: String(order.macro_tag ?? "NONE"),
      volTag: ivChangeToVolTag(Number(order.iv_change_pct_at_exit ?? Number.NaN)),
    });
  }

  for (const row of readBwbLogRows()) {
    const event = String(row.event ?? "").toUpperCase();
    if (event !== "EXIT") continue;
    const entryCredit = Number(row.entry_credit ?? Number.NaN);
    const exitDebit = Number(row.exit_debit ?? Number.NaN);
    const pnlPct =
      Number.isFinite(entryCredit) && entryCredit > 0 && Number.isFinite(exitDebit)
        ? ((entryCredit - exitDebit) / entryCredit) * 100
        : null;
    rows.push({
      strategy: "Broken-Wing Put Butterfly",
      regime: String(row.regime_at_entry ?? "UNKNOWN"),
      pnlPct,
      macroTag: String(row.macro_tag ?? "NONE"),
      volTag: ivChangeToVolTag(Number(row.iv_change_pct_at_exit ?? Number.NaN)),
    });
  }

  return rows;
}

function summarizePerfGroup(rows: PerfRow[]): { trades: number; winRatePct: number; expectancyPct: number } {
  const sample = rows.filter((row) => row.pnlPct != null) as Array<PerfRow & { pnlPct: number }>;
  if (sample.length === 0) {
    return { trades: 0, winRatePct: 0, expectancyPct: 0 };
  }
  const wins = sample.filter((row) => row.pnlPct > 0).length;
  const expectancy = sample.reduce((sum, row) => sum + row.pnlPct, 0) / sample.length;
  return {
    trades: sample.length,
    winRatePct: (wins / sample.length) * 100,
    expectancyPct: expectancy,
  };
}

function buildAnalyticsScorecard(payload: DashboardPayload): DashboardPayload {
  const rows = buildPerfRows();
  const byStrategy = new Map<string, PerfRow[]>();
  const byRegime = new Map<string, PerfRow[]>();
  const byMacroTag = new Map<string, PerfRow[]>();
  const byVolTag = new Map<string, PerfRow[]>();

  for (const row of rows) {
    const push = (map: Map<string, PerfRow[]>, key: string) => {
      const arr = map.get(key) ?? [];
      arr.push(row);
      map.set(key, arr);
    };
    push(byStrategy, row.strategy);
    push(byRegime, row.regime || "UNKNOWN");
    push(byMacroTag, row.macroTag || "NONE");
    push(byVolTag, row.volTag || "UNKNOWN");
  }

  const toSortedWithWinRate = (map: Map<string, PerfRow[]>, keyName: "strategy" | "regime") =>
    Array.from(map.entries())
      .map(([key, values]) => {
        const summary = summarizePerfGroup(values);
        return {
          [keyName]: key,
          trades: summary.trades,
          winRatePct: summary.winRatePct,
          expectancyPct: summary.expectancyPct,
        };
      })
      .sort((a, b) => b.trades - a.trades);

  const toSortedExpectancyOnly = (map: Map<string, PerfRow[]>, keyName: "macroTag" | "volTag") =>
    Array.from(map.entries())
      .map(([key, values]) => {
        const summary = summarizePerfGroup(values);
        return {
          [keyName]: key,
          trades: summary.trades,
          expectancyPct: summary.expectancyPct,
        };
      })
      .sort((a, b) => b.trades - a.trades);

  const sampleSize = rows.filter((row) => row.pnlPct != null).length;
  type Scorecard = NonNullable<DashboardPayload["analyticsScorecard"]>;
  return {
    ...payload,
    analyticsScorecard: {
      sampleSize,
      byStrategy: toSortedWithWinRate(byStrategy, "strategy") as Scorecard["byStrategy"],
      byRegime: toSortedWithWinRate(byRegime, "regime") as Scorecard["byRegime"],
      byMacroTag: toSortedExpectancyOnly(byMacroTag, "macroTag") as Scorecard["byMacroTag"],
      byVolTag: toSortedExpectancyOnly(byVolTag, "volTag") as Scorecard["byVolTag"],
    },
  };
}

function inferSideFromLegs(strategy: string, legs: OptionLeg[]): "bullish" | "bearish" | "neutral" {
  if (strategy === "Iron Condor" || strategy === "Iron Fly" || strategy === "Broken-Wing Put Butterfly") return "neutral";
  const shortLeg = legs.find((leg) => leg.action === "SELL");
  const longLeg = legs.find((leg) => leg.action === "BUY");
  if (!shortLeg || !longLeg) return "neutral";
  if (strategy === "Directional Spread" || strategy === "2-DTE Credit Spread") {
    if (shortLeg.type === "PUT") return "bullish";
    if (shortLeg.type === "CALL") return "bearish";
  }
  if (strategy === "Convex Debit Spread") {
    if (longLeg.type === "CALL") return "bullish";
    if (longLeg.type === "PUT") return "bearish";
  }
  return "neutral";
}

function inferRiskDollars(trade: OpenTrade): number {
  const credit = Number(trade.initialCredit ?? 0);
  const legs = trade.legs ?? [];
  const puts = legs.filter((leg) => leg.type === "PUT").map((leg) => leg.strike);
  const calls = legs.filter((leg) => leg.type === "CALL").map((leg) => leg.strike);

  if (trade.strategy === "Convex Debit Spread") {
    return Math.max(0, credit * 100);
  }
  if (trade.strategy === "Directional Spread" || trade.strategy === "2-DTE Credit Spread") {
    if (legs.length >= 2) {
      const width = Math.abs(legs[0].strike - legs[1].strike);
      return Math.max(0, (width - credit) * 100);
    }
  }
  if (trade.strategy === "Iron Condor" || trade.strategy === "Iron Fly" || trade.strategy === "Broken-Wing Put Butterfly") {
    const putWidth = puts.length >= 2 ? Math.abs(Math.max(...puts) - Math.min(...puts)) : 0;
    const callWidth = calls.length >= 2 ? Math.abs(Math.max(...calls) - Math.min(...calls)) : 0;
    const width = Math.max(putWidth, callWidth);
    if (width > 0) return Math.max(0, (width - credit) * 100);
  }
  return 0;
}

function withOpenRiskHeatmap(payload: DashboardPayload): DashboardPayload {
  type Heatmap = NonNullable<DashboardPayload["openRiskHeatmap"]>;
  const baseRows = payload.openTrades.map((trade) => ({
    strategy: trade.strategy,
    side: inferSideFromLegs(trade.strategy, trade.legs),
    risk: inferRiskDollars(trade),
  }));

  const twoDteSource = (() => {
    const fromPayload = Array.isArray(payload.twoDte?.openTrades) ? payload.twoDte?.openTrades : null;
    if (fromPayload && fromPayload.length > 0) return fromPayload;
    // Closed-market snapshots may provide no inline open-trade state, so fall back to persisted orders.
    return loadTwoDteOrders();
  })();

  const twoDteRows = twoDteSource
    .filter((row) => {
      const status = String(row.status ?? "").toUpperCase();
      return status === "OPEN" || status === "EXIT_PENDING";
    })
    .map((row) => {
      const right = String(row.right ?? "").toUpperCase();
      return {
        strategy: "2-DTE Credit Spread" as const,
        side: right === "PUT" ? ("bullish" as const) : ("bearish" as const),
        risk: Math.max(0, Number(row.max_loss_dollars ?? 0)),
      };
    });

  const bwbPos = payload.bwb?.openPosition as Record<string, unknown> | undefined;
  const bwbRows = bwbPos
    ? [
        {
          strategy: "Broken-Wing Put Butterfly" as const,
          side: "neutral" as const,
          risk: Math.max(0, Number(bwbPos.max_risk_dollars ?? 0)),
        },
      ]
    : [];

  const rows = [...baseRows, ...twoDteRows, ...bwbRows].filter((row) => row.risk > 0);
  const bySideMap = new Map<"bullish" | "bearish" | "neutral", number>([
    ["bullish", 0],
    ["bearish", 0],
    ["neutral", 0],
  ]);
  const byStrategyMap = new Map<string, { side: "bullish" | "bearish" | "neutral"; risk: number }>();
  let totalRisk = 0;
  for (const row of rows) {
    totalRisk += row.risk;
    bySideMap.set(row.side, (bySideMap.get(row.side) ?? 0) + row.risk);
    const current = byStrategyMap.get(row.strategy) ?? { side: row.side, risk: 0 };
    current.risk += row.risk;
    byStrategyMap.set(row.strategy, current);
  }

  return {
    ...payload,
    openRiskHeatmap: {
      totalRiskDollars: totalRisk,
      bySide: Array.from(bySideMap.entries()).map(([side, riskDollars]) => ({ side, riskDollars })),
      byStrategy: Array.from(byStrategyMap.entries()).map(([strategy, row]) => ({
        strategy: strategy as Heatmap["byStrategy"][number]["strategy"],
        side: row.side,
        riskDollars: row.risk,
      })),
    },
  };
}

function buildPreflight(payload: DashboardPayload): DashboardPayload["preflight"] {
  const check = (name: string, status: "pass" | "fail" | "blocked" | "na", detail: string) => ({ name, status, detail });
  const globalRows = payload.globalChecklist ?? [];
  const macroRow = globalRows.find((row) => /macro/i.test(row.name));
  const volRow = globalRows.find((row) => /volatility expansion/i.test(row.name));
  const anyReady = payload.candidates.some((candidate) => candidate.ready);
  const dataFreshPass = payload.staleData ? !payload.staleData.active : false;
  const contractHealthy =
    payload.dataContract?.status === "healthy" ||
    (!payload.market.isOpen && payload.dataContract?.status === "inactive") ||
    (!STRICT_LIVE_BLOCKS && payload.dataContract?.status === "degraded");

  const checks = [
    check("Market open", payload.market.isOpen ? "pass" : "fail", payload.market.isOpen ? "Session active." : "Market closed."),
    check(
      "Data freshness",
      dataFreshPass ? "pass" : "fail",
      payload.staleData?.detail ?? "Freshness check unavailable.",
    ),
    check(
      "Data contract valid",
      contractHealthy ? "pass" : "blocked",
      contractHealthy
        ? "All required live feeds fresh."
        : (payload.dataContract?.issues?.[0] ?? "Required feed missing/stale."),
    ),
    check(
      "Macro block clear",
      macroRow ? (macroRow.status === "pass" ? "pass" : "fail") : "na",
      macroRow?.detail ?? "No macro row found.",
    ),
    check(
      "Vol expansion clear",
      volRow ? (volRow.status === "pass" ? "pass" : "fail") : "na",
      volRow?.detail ?? "No volatility row found.",
    ),
    check("At least one eligible strategy", anyReady ? "pass" : "fail", anyReady ? "Checklist has at least one READY setup." : "No strategy READY."),
    check(
      "Telegram configured",
      payload.startupHealth?.telegram.ok ? "pass" : "na",
      payload.startupHealth?.telegram.detail ?? "Health check unavailable.",
    ),
  ];
  const go = checks.every((row) => row.status === "pass" || row.status === "na");
  return {
    go,
    checkedAtEt: payload.generatedAtEt,
    checkedAtParis: payload.generatedAtParis,
    checks,
  };
}

function savePreflight(preflight: DashboardPayload["preflight"]): void {
  try {
    mkdirSync(path.dirname(PRECHECK_STATE_PATH), { recursive: true });
    writeFileSync(PRECHECK_STATE_PATH, JSON.stringify(preflight, null, 2));
  } catch {
    // keep resilient
  }
}

function buildWalkForwardReplay(limit: number, windowSize: number, stepSize: number): DashboardPayload["replayWalkForward"] {
  const rows = readSnapshotLogRows(limit);
  const windows: NonNullable<DashboardPayload["replayWalkForward"]>["windows"] = [];
  if (rows.length === 0) {
    return { rowsAnalyzed: 0, windowSize, stepSize, windows };
  }
  const safeWindow = Math.max(30, Math.min(1_000, windowSize));
  const safeStep = Math.max(10, Math.min(500, stepSize));
  for (let end = safeWindow; end <= rows.length; end += safeStep) {
    const slice = rows.slice(end - safeWindow, end);
    let entryAlerts = 0;
    let exitAlerts = 0;
    let readyCount = 0;
    let sampleCount = 0;
    const strategyReady = new Map<string, number>();
    for (const row of slice) {
      const alerts = Array.isArray(row.alerts) ? row.alerts : [];
      for (const alert of alerts) {
        const type = String((alert as Record<string, unknown>).type ?? "");
        if (type === "ENTRY") entryAlerts += 1;
        if (type === "EXIT") exitAlerts += 1;
      }
      const candidates = Array.isArray(row.candidates) ? row.candidates : [];
      for (const candidate of candidates) {
        sampleCount += 1;
        const card = candidate as Record<string, unknown>;
        const strategy = String(card.strategy ?? "Unknown");
        const ready = Boolean(card.ready);
        if (ready) {
          readyCount += 1;
          strategyReady.set(strategy, (strategyReady.get(strategy) ?? 0) + 1);
        }
      }
    }
    const favoredStrategy =
      Array.from(strategyReady.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "None";
    const startTsIso = String(slice[0]?.ts_iso ?? "");
    const endTsIso = String(slice[slice.length - 1]?.ts_iso ?? "");
    windows.push({
      index: windows.length + 1,
      startTsIso,
      endTsIso,
      sampleCount: slice.length,
      entryAlerts,
      exitAlerts,
      readyRatePct: sampleCount > 0 ? (readyCount / sampleCount) * 100 : 0,
      favoredStrategy,
    });
  }
  return {
    rowsAnalyzed: rows.length,
    windowSize: safeWindow,
    stepSize: safeStep,
    windows,
  };
}

function readTradeStateOpenTrades(): OpenTrade[] {
  try {
    const statePath = path.join(process.cwd(), "storage", ".alert_state.json");
    if (!existsSync(statePath)) return [];

    const text = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(text) as { trades?: Array<Record<string, unknown>> };
    const rawTrades = Array.isArray(parsed.trades) ? parsed.trades : [];

    return rawTrades
      .filter((t) => String(t.status) === "open" || String(t.status) === "exit_pending")
      .map((t, idx) => {
        const strategyRaw = String(t.strategy ?? "");
        const isFly = strategyRaw === "IRON_FLY";
        const isDirectional = strategyRaw === "CREDIT_SPREAD";
        const short = Number(t.short_strike ?? 0);
        let legs: OptionLeg[];
        let strategy: "Iron Condor" | "Iron Fly" | "Directional Spread";

        if (isFly) {
          strategy = "Iron Fly";
          legs = [
            leg("SELL", "PUT", short, Number(t.short_put_delta ?? -0.5)),
            leg("BUY", "PUT", Number(t.long_put ?? 0), Number(t.long_put_delta ?? -0.1)),
            leg("SELL", "CALL", short, Number(t.short_call_delta ?? 0.5)),
            leg("BUY", "CALL", Number(t.long_call ?? 0), Number(t.long_call_delta ?? 0.1)),
          ];
        } else if (isDirectional) {
          strategy = "Directional Spread";
          const spreadType = String(t.spread_type ?? "").toUpperCase();
          const right: "PUT" | "CALL" = spreadType === "BULL_PUT_SPREAD" ? "PUT" : "CALL";
          legs = [
            leg("SELL", right, Number(t.short_strike ?? 0), Number(t.short_delta ?? 0)),
            leg("BUY", right, Number(t.long_strike ?? 0), Number(t.long_delta ?? 0)),
          ];
        } else {
          strategy = "Iron Condor";
          legs = [
            leg("SELL", "PUT", Number(t.short_put ?? 0), Number(t.short_put_delta ?? -0.12)),
            leg("BUY", "PUT", Number(t.long_put ?? 0), Number(t.long_put_delta ?? -0.02)),
            leg("SELL", "CALL", Number(t.short_call ?? 0), Number(t.short_call_delta ?? 0.12)),
            leg("BUY", "CALL", Number(t.long_call ?? 0), Number(t.long_call_delta ?? 0.03)),
          ];
        }

        return {
          id: String(t.trade_id ?? `T-${idx + 1}`),
          strategy,
          entryEt: "-",
          spot: 0,
          legs,
          initialCredit: Number(t.initial_credit ?? 0),
          currentDebit: Number(t.current_debit ?? 0),
          plPct: Number(t.profit_pct ?? 0),
          popPct: Number(t.pop_delta ?? 0),
          status: String(t.status) === "exit_pending" ? "EXIT_PENDING" : "OPEN",
          nextReason: String(t.next_exit_reason ?? ""),
        };
      });
  } catch {
    return [];
  }
}

function forceClosed(payload: DashboardPayload): DashboardPayload {
  return {
    ...payload,
    candidates: payload.candidates.map((c) => ({
      ...c,
      ready: false,
      reason: c.blockedReason || "Market closed.",
    })),
    alerts: [],
  };
}

function ensureSnapshotHeaderShape(payload: DashboardPayload): DashboardPayload {
  const currentTargets = (payload.symbolValidation?.targets ?? {}) as Record<
    string,
    { expiration: string | null; symbols?: string[] }
  >;
  const normalizedTargets: Record<string, { expiration: string | null; symbols?: string[] }> = {
    "2": currentTargets["2"] ?? { expiration: null, symbols: [] },
    "7": currentTargets["7"] ?? { expiration: null, symbols: [] },
    "14": currentTargets["14"] ?? { expiration: null, symbols: [] },
    "30": currentTargets["30"] ?? { expiration: null, symbols: [] },
    "45": currentTargets["45"] ?? { expiration: null, symbols: [] },
  };

  return {
    ...payload,
    dataFeeds: {
      underlying_price: {
        timestampIso: payload.dataFeeds?.underlying_price?.timestampIso ?? null,
        source: payload.dataFeeds?.underlying_price?.source ?? payload.market?.source ?? "unknown",
      },
      option_chain: {
        timestampIso: payload.dataFeeds?.option_chain?.timestampIso ?? null,
        source: payload.dataFeeds?.option_chain?.source ?? payload.market?.source ?? "unknown",
      },
      greeks: {
        timestampIso: payload.dataFeeds?.greeks?.timestampIso ?? null,
        source: payload.dataFeeds?.greeks?.source ?? payload.market?.source ?? "unknown",
      },
    },
    symbolValidation: {
      dte0: payload.symbolValidation?.dte0 ?? [],
      dte2: payload.symbolValidation?.dte2 ?? [],
      bwb: payload.symbolValidation?.bwb ?? [],
      targets: normalizedTargets,
      chain: {
        underlyingSymbol: payload.symbolValidation?.chain?.underlyingSymbol ?? "SPX",
        chainExpiryMin: payload.symbolValidation?.chain?.chainExpiryMin ?? null,
        chainExpiryMax: payload.symbolValidation?.chain?.chainExpiryMax ?? null,
        expirationsPresent: payload.symbolValidation?.chain?.expirationsPresent ?? [],
      },
      checks: {
        spot_reasonable: payload.symbolValidation?.checks?.spot_reasonable ?? false,
        chain_has_target_expirations: payload.symbolValidation?.checks?.chain_has_target_expirations ?? false,
        greeks_match_chain: payload.symbolValidation?.checks?.greeks_match_chain ?? false,
        chain_age_ok: payload.symbolValidation?.checks?.chain_age_ok ?? false,
        spot_age_ok: payload.symbolValidation?.checks?.spot_age_ok ?? false,
        greeks_age_ok: payload.symbolValidation?.checks?.greeks_age_ok ?? false,
      },
    },
  };
}

function allRequiredPass(
  rows: Array<{ status: "pass" | "fail" | "blocked" | "na"; required?: boolean }> | undefined,
): boolean {
  if (!rows || rows.length === 0) return false;
  return rows.every((row) => (row.required ?? true ? row.status === "pass" : true));
}

function enforceStrictCandidate(candidate: DashboardPayload["candidates"][number]): DashboardPayload["candidates"][number] {
  const checklist = candidate.checklist;
  if (!checklist) {
    return {
      ...candidate,
      ready: false,
      blockedReason: candidate.blockedReason || "Checklist missing - blocking trade.",
      reason: candidate.blockedReason || "Checklist missing - blocking trade.",
    };
  }

  const strategyPass = allRequiredPass(checklist.strategy);
  // Global/regime are informational notices for credit sleeves in this mode.
  // Strategy rows remain strict blockers.
  const strictReady = Boolean(candidate.ready && strategyPass);

  if (strictReady) return candidate;

  const firstFail = [...checklist.strategy].find(
    (row) => (row.required ?? true) && row.status !== "pass",
  );
  const blockedReason =
    firstFail != null
      ? `${firstFail.name}: ${firstFail.detail || "failed"}`
      : (candidate.blockedReason || "Checklist incomplete - blocking trade.");

  return {
    ...candidate,
    ready: false,
    blockedReason,
    reason: blockedReason,
  };
}

function normalizeChecklistRow(input: unknown): {
  id?: string;
  label?: string;
  name: string;
  status: "pass" | "fail" | "blocked" | "na";
  detail: string;
  reason?: string;
  observed?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  requires?: string[];
  dataAgeMs?: Record<string, number | null>;
  required: boolean;
} {
  const row = (input ?? {}) as Record<string, unknown>;
  const rawStatus = String(row.status ?? "fail").toLowerCase();
  const status: "pass" | "fail" | "blocked" | "na" =
    rawStatus === "pass" || rawStatus === "na" || rawStatus === "blocked"
      ? (rawStatus as "pass" | "na" | "blocked")
      : "fail";
  const required = row.required === false ? false : true;
  return {
    id: typeof row.id === "string" ? row.id : undefined,
    label: typeof row.label === "string" ? row.label : undefined,
    name: String(row.name ?? "Unnamed criterion"),
    status,
    detail: String(row.detail ?? ""),
    reason: typeof row.reason === "string" ? row.reason : undefined,
    observed: typeof row.observed === "object" && row.observed != null ? (row.observed as Record<string, unknown>) : undefined,
    thresholds: typeof row.thresholds === "object" && row.thresholds != null ? (row.thresholds as Record<string, unknown>) : undefined,
    requires: Array.isArray(row.requires) ? row.requires.map((v) => String(v)) : undefined,
    dataAgeMs: typeof row.dataAgeMs === "object" && row.dataAgeMs != null
      ? Object.fromEntries(
          Object.entries(row.dataAgeMs as Record<string, unknown>).map(([k, v]) => {
            const n = Number(v);
            return [k, Number.isFinite(n) ? n : null];
          }),
        )
      : undefined,
    required,
  };
}

function parseDaysToExpiry(expiryRaw: unknown): number | undefined {
  const expiry = String(expiryRaw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return undefined;
  const expMs = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(expMs)) return undefined;
  const now = new Date();
  const nowEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const nowMs = Date.parse(`${nowEt}T00:00:00Z`);
  if (!Number.isFinite(nowMs)) return undefined;
  const days = Math.round((expMs - nowMs) / 86_400_000);
  return Number.isFinite(days) ? days : undefined;
}

function buildTwoDteCandidate(twoDte: DashboardPayload["twoDte"] | undefined): DashboardPayload["candidates"][number] | null {
  if (!twoDte) return null;
  const recommendation = (twoDte.recommendation ?? null) as Record<string, unknown> | null;
  const checklistRows = Array.isArray(twoDte.checklist)
    ? twoDte.checklist.map((row) => normalizeChecklistRow(row))
    : [];
  const strategyRows =
    checklistRows.length > 0
      ? checklistRows
      : [
          {
            name: "2-DTE recommendation available",
            status: "fail" as const,
            detail: "No checklist available.",
            required: true,
          },
        ];
  const width = Number(recommendation?.width ?? 0);
  const credit = Number(recommendation?.credit ?? 0);
  const maxRisk = Number(recommendation?.max_loss_points ?? 0);
  const shortDelta = Number(recommendation?.short_delta ?? 0);
  const shortTheta = Number(recommendation?.short_theta ?? Number.NaN);
  const shortGamma = Number(recommendation?.short_gamma ?? Number.NaN);
  const shortVega = Number(recommendation?.short_vega ?? Number.NaN);
  const netDelta = Number(recommendation?.net_delta ?? Number.NaN);
  const netTheta = Number(recommendation?.net_theta ?? Number.NaN);
  const netGamma = Number(recommendation?.net_gamma ?? Number.NaN);
  const netVega = Number(recommendation?.net_vega ?? Number.NaN);
  const popPct = Number.isFinite(shortDelta) ? Math.max(0, Math.min(1, 1 - Math.abs(shortDelta))) : 0;
  const daysToExpiry = parseDaysToExpiry(recommendation?.expiry);
  const rawLegs = Array.isArray(recommendation?.legs) ? recommendation.legs : [];
  const legs = rawLegs
    .map((leg) => {
      const row = leg as Record<string, unknown>;
      const action = String(row.action ?? "").toUpperCase();
      const type = String((row.type ?? row.right) ?? "").toUpperCase();
      const strike = Number(row.strike ?? 0);
      const delta = Number(row.delta ?? 0);
      const premiumRaw = row.premium == null ? null : Number(row.premium);
      const impliedVolRaw = row.impliedVol == null ? null : Number(row.impliedVol);
      const qtyRaw = Number(row.qty ?? 1);
      const symbolRaw = String(row.symbol ?? "").trim();
      if (!Number.isFinite(strike) || !Number.isFinite(delta)) return null;
      if (action !== "BUY" && action !== "SELL") return null;
      if (type !== "PUT" && type !== "CALL") return null;
      return {
        action: action as "BUY" | "SELL",
        type: type as "PUT" | "CALL",
        strike,
        delta,
        premium: Number.isFinite(premiumRaw) ? premiumRaw : null,
        qty: Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1,
        impliedVol: Number.isFinite(impliedVolRaw) ? impliedVolRaw : null,
        symbol: symbolRaw || undefined,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const recommendationReady = Boolean(recommendation && legs.length >= 2);
  const candidateId = String(recommendation?.candidate_id ?? "").trim() || undefined;

  const configProfile = String(twoDte.metrics?.configProfile ?? "2-DTE");
  const baseReason = String(twoDte.reason ?? "2-DTE criteria pending.");
  const reasonText = `${configProfile}: ${baseReason}`;

  return {
    candidateId,
    strategy: "2-DTE Credit Spread",
    ready: Boolean(twoDte.ready && recommendationReady),
    width: Number.isFinite(width) ? width : 0,
    credit: Number.isFinite(credit) ? credit : 0,
    premium: Number.isFinite(credit) ? credit : 0,
    maxRisk: Number.isFinite(maxRisk) ? maxRisk : 0,
    popPct,
    reason: reasonText,
    blockedReason: reasonText,
    legs,
    daysToExpiry,
    greeks: {
      delta: Number.isFinite(netDelta) ? netDelta : Number.isFinite(shortDelta) ? shortDelta : undefined,
      theta: Number.isFinite(netTheta) ? netTheta : Number.isFinite(shortTheta) ? shortTheta : undefined,
      gamma: Number.isFinite(netGamma) ? netGamma : Number.isFinite(shortGamma) ? shortGamma : undefined,
      vega: Number.isFinite(netVega) ? netVega : Number.isFinite(shortVega) ? shortVega : undefined,
      iv: Number.isFinite(Number(twoDte.metrics?.iv)) ? Number(twoDte.metrics?.iv) : undefined,
    },
    checklist: {
      global: [
        {
          name: "Global gates",
          status: "na",
          detail: "2-DTE uses dedicated checklist criteria.",
          required: false,
        },
      ],
      regime: [
        {
          name: "Regime gate",
          status: "na",
          detail: "2-DTE setup is criteria-driven and regime-agnostic.",
          required: false,
        },
      ],
      strategy: strategyRows,
    },
    criteria: strategyRows.map((row) => ({
      name: row.name,
      passed: row.status === "pass",
      detail: row.detail,
    })),
  };
}

function buildTargetDteCandidate(
  target: NonNullable<DashboardPayload["multiDte"]>["targets"][number],
): DashboardPayload["candidates"][number] | null {
  const strategy = (target.strategy_label || `${target.target_dte}-DTE Credit Spread`) as Strategy;
  const recommendation = (target.recommendation ?? null) as Record<string, unknown> | null;
  const checklistRows = Array.isArray(target.checklist) ? target.checklist.map((row) => normalizeChecklistRow(row)) : [];
  const strategyRows =
    checklistRows.length > 0
      ? checklistRows
      : [
          {
            name: `${target.target_dte}-DTE recommendation available`,
            status: "fail" as const,
            detail: "No checklist available.",
            required: true,
          },
        ];

  const width = Number(recommendation?.width ?? 0);
  const credit = Number(recommendation?.credit ?? 0);
  const maxRiskPoints = Number(recommendation?.max_loss_points ?? 0);
  const shortDelta = Number(recommendation?.short_delta ?? Number.NaN);
  const shortTheta = Number(recommendation?.short_theta ?? Number.NaN);
  const shortGamma = Number(recommendation?.short_gamma ?? Number.NaN);
  const shortVega = Number(recommendation?.short_vega ?? Number.NaN);
  const netDelta = Number(recommendation?.net_delta ?? Number.NaN);
  const netTheta = Number(recommendation?.net_theta ?? Number.NaN);
  const netGamma = Number(recommendation?.net_gamma ?? Number.NaN);
  const netVega = Number(recommendation?.net_vega ?? Number.NaN);
  const popPct = Number.isFinite(shortDelta) ? Math.max(0, Math.min(1, 1 - Math.abs(shortDelta))) : 0;
  const daysToExpiry = Number.isFinite(Number(target.selected_dte))
    ? Number(target.selected_dte)
    : parseDaysToExpiry(recommendation?.expiry ?? target.expiration);

  const rawLegs = Array.isArray(recommendation?.legs) ? recommendation.legs : [];
  const legs = rawLegs
    .map((leg) => {
      const row = leg as Record<string, unknown>;
      const action = String(row.action ?? "").toUpperCase();
      const type = String((row.type ?? row.right) ?? "").toUpperCase();
      const strike = Number(row.strike ?? 0);
      const delta = Number(row.delta ?? 0);
      const premiumRaw = row.premium == null ? null : Number(row.premium);
      const impliedVolRaw = row.impliedVol == null ? null : Number(row.impliedVol);
      const qtyRaw = Number(row.qty ?? 1);
      const symbolRaw = String(row.symbol ?? "").trim();
      if (!Number.isFinite(strike) || !Number.isFinite(delta)) return null;
      if (action !== "BUY" && action !== "SELL") return null;
      if (type !== "PUT" && type !== "CALL") return null;
      return {
        action: action as "BUY" | "SELL",
        type: type as "PUT" | "CALL",
        strike,
        delta,
        premium: Number.isFinite(premiumRaw) ? premiumRaw : null,
        qty: Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1,
        impliedVol: Number.isFinite(impliedVolRaw) ? impliedVolRaw : null,
        symbol: symbolRaw || undefined,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const recommendationReady = Boolean(recommendation && legs.length >= 2);
  const candidateId = String(recommendation?.candidate_id ?? "").trim() || undefined;
  const selectedDteText = Number.isFinite(Number(target.selected_dte))
    ? `${Number(target.selected_dte)} DTE selected (target ${target.target_dte})`
    : `Target ${target.target_dte} DTE`;

  const configProfile = String(target.metrics?.configProfile ?? `${target.target_dte}-DTE`);
  const baseReason = String(target.reason || `${target.target_dte}-DTE criteria pending.`);
  const reasonText = `${configProfile}: ${baseReason}`;

  return {
    candidateId,
    strategy,
    ready: Boolean(target.ready && recommendationReady),
    width: Number.isFinite(width) ? width : 0,
    credit: Number.isFinite(credit) ? credit : 0,
    premium: Number.isFinite(credit) ? credit : 0,
    maxRisk: Number.isFinite(maxRiskPoints) ? maxRiskPoints : 0,
    popPct,
    reason: reasonText,
    blockedReason: reasonText,
    legs,
    daysToExpiry: daysToExpiry ?? undefined,
    greeks: {
      delta: Number.isFinite(netDelta) ? netDelta : Number.isFinite(shortDelta) ? shortDelta : undefined,
      theta: Number.isFinite(netTheta) ? netTheta : Number.isFinite(shortTheta) ? shortTheta : undefined,
      gamma: Number.isFinite(netGamma) ? netGamma : Number.isFinite(shortGamma) ? shortGamma : undefined,
      vega: Number.isFinite(netVega) ? netVega : Number.isFinite(shortVega) ? shortVega : undefined,
      iv: Number.isFinite(Number(target.metrics?.iv)) ? Number(target.metrics?.iv) : undefined,
    },
    checklist: {
      global: [
        {
          name: "Global gates",
          status: "na",
          detail: selectedDteText,
          required: false,
        },
      ],
      regime: [
        {
          name: "Regime gate",
          status: "na",
          detail: "Credit spread setup is criteria-driven and regime-agnostic.",
          required: false,
        },
      ],
      strategy: strategyRows,
    },
    criteria: strategyRows.map((row) => ({
      name: row.name,
      passed: row.status === "pass",
      detail: row.detail,
    })),
  };
}

function buildBwbCandidate(bwb: DashboardPayload["bwb"] | undefined): DashboardPayload["candidates"][number] | null {
  if (!bwb) return null;
  const recommendation = (bwb.recommendation ?? null) as Record<string, unknown> | null;
  const openPosition = (bwb.openPosition ?? null) as Record<string, unknown> | null;
  const checklistRows = Array.isArray(bwb.checklist)
    ? bwb.checklist.map((row) => normalizeChecklistRow(row))
    : [];
  const strategyRows =
    checklistRows.length > 0
      ? checklistRows
      : [
          {
            name: "BWB recommendation available",
            status: "fail" as const,
            detail: "No checklist available.",
            required: true,
          },
        ];

  const widthRaw = Number(recommendation?.wide_wing_width ?? openPosition?.wide_wing_width ?? 0);
  const creditRaw = Number(recommendation?.credit ?? openPosition?.entry_credit ?? 0);
  const maxRiskRaw = Number(recommendation?.max_risk_points ?? openPosition?.max_risk_points ?? 0);
  const shortDeltaRaw = Number(recommendation?.short_delta ?? openPosition?.short_delta ?? 0);
  const popPct = Number.isFinite(shortDeltaRaw) ? Math.max(0, Math.min(1, 1 - Math.abs(shortDeltaRaw))) : 0;
  const daysToExpiry = parseDaysToExpiry(recommendation?.expiry ?? openPosition?.expiry);

  const rawLegs = Array.isArray(recommendation?.legs)
    ? recommendation.legs
    : Array.isArray(openPosition?.legs)
      ? openPosition?.legs
      : [];
  const legs = rawLegs
    .map((leg) => {
      const row = leg as Record<string, unknown>;
      const action = String(row.action ?? "").toUpperCase();
      const right = String((row.type ?? row.right) ?? "PUT").toUpperCase();
      const strike = Number(row.strike ?? 0);
      const delta = row.delta == null ? Number.NaN : Number(row.delta);
      const qtyRaw = Number(row.qty ?? 1);
      const premiumRaw = row.premium == null ? Number.NaN : Number(row.premium);
      const impliedVolRaw = row.impliedVol == null ? Number.NaN : Number(row.impliedVol);
      const symbolRaw = String(row.symbol ?? "").trim();
      if (!Number.isFinite(strike)) return null;
      if (action !== "BUY" && action !== "SELL") return null;
      if (right !== "PUT" && right !== "CALL") return null;
      return {
        action: action as "BUY" | "SELL",
        type: right as "PUT" | "CALL",
        strike,
        delta: Number.isFinite(delta) ? delta : 0,
        premium: Number.isFinite(premiumRaw) ? premiumRaw : null,
        qty: Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1,
        impliedVol: Number.isFinite(impliedVolRaw) ? impliedVolRaw : null,
        symbol: symbolRaw || undefined,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const recommendationReady = Boolean(recommendation && legs.length >= 3);

  return {
    strategy: "Broken-Wing Put Butterfly",
    ready: Boolean(bwb.ready && recommendationReady),
    width: Number.isFinite(widthRaw) ? widthRaw : 0,
    credit: Number.isFinite(creditRaw) ? creditRaw : 0,
    premium: Number.isFinite(creditRaw) ? creditRaw : 0,
    maxRisk: Number.isFinite(maxRiskRaw) ? maxRiskRaw : 0,
    popPct,
    reason: String(bwb.reason ?? "BWB criteria pending."),
    blockedReason: String(bwb.reason ?? "BWB criteria pending."),
    legs,
    daysToExpiry,
    greeks: {
      delta: Number.isFinite(shortDeltaRaw) ? shortDeltaRaw : undefined,
      iv: Number.isFinite(Number(bwb.metrics?.iv_rank)) ? Number(bwb.metrics?.iv_rank) / 100 : undefined,
    },
    checklist: {
      global: [
        {
          name: "Global gates",
          status: "na",
          detail: "BWB uses dedicated 21-DTE checklist criteria.",
          required: false,
        },
      ],
      regime: [
        {
          name: "Regime gate",
          status: "na",
          detail: "BWB setup is criteria-driven and regime-agnostic.",
          required: false,
        },
      ],
      strategy: strategyRows,
    },
    criteria: strategyRows.map((row) => ({
      name: row.name,
      passed: row.status === "pass",
      detail: row.detail,
    })),
  };
}

function withTwoDteCandidate(payload: DashboardPayload): DashboardPayload {
  const candidate = buildTwoDteCandidate(payload.twoDte);
  if (!candidate) return payload;
  const strictCandidate = enforceStrictCandidate(candidate);
  const candidates = [
    strictCandidate,
    ...payload.candidates.filter((row) => row.strategy !== "2-DTE Credit Spread"),
  ];
  const eligibility = payload.strategyEligibility ?? [];
  const nextEligibility = [
    {
      strategy: "2-DTE Credit Spread" as const,
      status: strictCandidate.ready ? ("pass" as const) : ("fail" as const),
      reason: strictCandidate.ready
        ? "2-DTE criteria passed."
        : strictCandidate.blockedReason || payload.twoDte?.reason || "2-DTE criteria not met.",
    },
    ...eligibility.filter((row) => row.strategy !== "2-DTE Credit Spread"),
  ];

  return {
    ...payload,
    candidates,
    strategyEligibility: nextEligibility,
  };
}

function withMultiDteCandidates(payload: DashboardPayload): DashboardPayload {
  const targets = Array.isArray(payload.multiDte?.targets) ? payload.multiDte?.targets : [];
  const targetCandidates = targets
    .map((row) => buildTargetDteCandidate(row))
    .filter((row): row is NonNullable<typeof row> => row != null)
    .map((candidate) => enforceStrictCandidate(candidate));

  const twoDteFallback = buildTwoDteCandidate(payload.twoDte);
  if (twoDteFallback && !targetCandidates.some((row) => row.strategy === "2-DTE Credit Spread")) {
    targetCandidates.unshift(enforceStrictCandidate(twoDteFallback));
  }
  if (targetCandidates.length === 0) {
    return withTwoDteCandidate(payload);
  }

  const targetStrategies = new Set(
    targetCandidates.map((candidate) => candidate.strategy).filter((strategy): strategy is Strategy => Boolean(strategy)),
  );

  const nextCandidates = [
    ...targetCandidates,
    ...payload.candidates.filter((row) => !targetStrategies.has(row.strategy)),
  ];

  const nextEligibilityBase = (payload.strategyEligibility ?? []).filter((row) => !targetStrategies.has(row.strategy));
  const nextEligibility = [
    ...targetCandidates.map((candidate) => ({
      strategy: candidate.strategy,
      status: candidate.ready ? ("pass" as const) : ("fail" as const),
      reason: candidate.ready ? `${candidate.strategy} criteria passed.` : candidate.blockedReason || `${candidate.strategy} criteria not met.`,
    })),
    ...nextEligibilityBase,
  ];

  return {
    ...payload,
    candidates: nextCandidates,
    strategyEligibility: nextEligibility,
  };
}

function withBwbCandidate(payload: DashboardPayload): DashboardPayload {
  const candidate = buildBwbCandidate(payload.bwb);
  if (!candidate) return payload;
  const strictCandidate = enforceStrictCandidate(candidate);
  const candidates = [
    ...payload.candidates.filter((row) => row.strategy !== "Broken-Wing Put Butterfly"),
    strictCandidate,
  ];
  const eligibility = payload.strategyEligibility ?? [];
  const nextEligibility = [
    ...eligibility.filter((row) => row.strategy !== "Broken-Wing Put Butterfly"),
    {
      strategy: "Broken-Wing Put Butterfly" as const,
      status: strictCandidate.ready ? ("pass" as const) : ("fail" as const),
      reason: strictCandidate.ready
        ? "BWB criteria passed."
        : strictCandidate.blockedReason || payload.bwb?.reason || "BWB criteria not met.",
    },
  ];

  return {
    ...payload,
    candidates,
    strategyEligibility: nextEligibility,
  };
}

function applyLongerTimeframeMode(payload: DashboardPayload): DashboardPayload {
  if (!LONGER_TIMEFRAME_ONLY_ENABLED) {
    return {
      ...payload,
      strategyMode: {
        longerTimeframesOnly: false,
        pausedStrategies: [],
        allowedStrategies: STRATEGY_KEYS.slice() as Strategy[],
        reason: "All sleeves enabled.",
      },
    };
  }

  const allowed = new Set<Strategy>(LONGER_TIMEFRAME_STRATEGIES);
  const pausedStrategies = (STRATEGY_KEYS.filter((strategy) => !allowed.has(strategy)) ?? []) as Strategy[];
  const pauseReason = "Paused: 0DTE sleeves on hold (focusing on 2-DTE+).";

  const nextEligibility = (payload.strategyEligibility ?? []).map((row) => {
    if (!pausedStrategies.includes(row.strategy)) return row;
    return {
      ...row,
      status: "fail" as const,
      reason: pauseReason,
    };
  });

  return {
    ...payload,
    candidates: payload.candidates.filter((row) => allowed.has(row.strategy)),
    strategyEligibility: nextEligibility,
    alerts: payload.alerts.filter((alert) => allowed.has(alert.strategy)),
    strategyMode: {
      longerTimeframesOnly: true,
      pausedStrategies,
      allowedStrategies: LONGER_TIMEFRAME_STRATEGIES,
      reason: pauseReason,
    },
  };
}

function isRiskSleeveLabel(text: string): boolean {
  return /\b(sleeve|drawdown|open risk|max open risk|max risk|risk lock|weekly\/daily loss lock|daily lock|weekly lock|capacity|liquidity|bid\/ask|slippage-adjusted credit|slippage adjusted credit|credit_adj)\b/i.test(
    text,
  );
}

function stripRiskSleeveChecks(payload: DashboardPayload): DashboardPayload {
  const pruneRows = <T extends { name: string; detail?: string }>(rows: T[] | undefined): T[] =>
    (rows ?? []).filter((row) => !isRiskSleeveLabel(`${row.name} ${row.detail ?? ""}`));

  const nextCandidates = (payload.candidates ?? []).map((candidate) => ({
    ...candidate,
    checklist: candidate.checklist
      ? {
          global: pruneRows(candidate.checklist.global),
          regime: pruneRows(candidate.checklist.regime),
          strategy: pruneRows(candidate.checklist.strategy),
        }
      : candidate.checklist,
    criteria: (candidate.criteria ?? []).filter((row) => !isRiskSleeveLabel(`${row.name} ${row.detail ?? ""}`)),
  }));

  return {
    ...payload,
    globalChecklist: pruneRows(payload.globalChecklist),
    candidates: nextCandidates,
    twoDte: payload.twoDte
      ? {
          ...payload.twoDte,
          checklist: pruneRows(payload.twoDte.checklist),
        }
      : payload.twoDte,
    bwb: payload.bwb
      ? {
          ...payload.bwb,
          checklist: pruneRows(payload.bwb.checklist),
        }
      : payload.bwb,
  };
}

function todayEtKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function buildBwbEntryAlert(
  payload: DashboardPayload,
  recommendation: Record<string, unknown>,
  reason: string,
): AlertItem {
  const shortStrike = Number(recommendation.short_put_strike ?? 0);
  const longStrike = Number(recommendation.long_put_strike ?? 0);
  const farStrike = Number(recommendation.far_long_put_strike ?? 0);
  const expiry = String(recommendation.expiry ?? "-");
  const id = `ENTRY-BWB-${todayEtKey()}-${expiry}-${Math.round(shortStrike)}-${Math.round(longStrike)}-${Math.round(farStrike)}`;
  const legsRaw = Array.isArray(recommendation.legs) ? recommendation.legs : [];
  const legs = legsRaw
    .map((leg) => {
      const row = leg as Record<string, unknown>;
      const action = String(row.action ?? "").toUpperCase();
      const right = String((row.type ?? row.right) ?? "").toUpperCase();
      const strike = Number(row.strike ?? 0);
      const delta = Number(row.delta ?? 0);
      const qty = Number(row.qty ?? 1);
      if (action !== "BUY" && action !== "SELL") return null;
      if (right !== "PUT" && right !== "CALL") return null;
      if (!Number.isFinite(strike) || !Number.isFinite(delta)) return null;
      return {
        action: action as "BUY" | "SELL",
        type: right as "PUT" | "CALL",
        strike,
        delta,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  return {
    id,
    type: "ENTRY",
    strategy: "Broken-Wing Put Butterfly",
    timeEt: payload.generatedAtEt,
    spot: Number(payload.metrics.spx ?? 0),
    legs,
    credit: Number(recommendation.credit ?? 0),
    debit: null,
    plPct: null,
    popPct: null,
    reason,
    severity: "good",
    checklistSummary: String(payload.bwb?.reason ?? "BWB criteria passed."),
  };
}

function buildBwbExitAlert(
  payload: DashboardPayload,
  position: BwbPosition,
  currentDebit: number | null,
  reason: string,
): AlertItem {
  const id = `EXIT-BWB-${todayEtKey()}-${position.id}-${reason.slice(0, 32)}`;
  const legs = position.legs.map((row) => ({
    action: row.action,
    type: row.right,
    strike: row.strike,
    delta: Number(row.delta ?? 0),
    qty: row.qty,
  }));
  const plPct =
    currentDebit == null || !Number.isFinite(position.entry_credit) || position.entry_credit === 0
      ? null
      : (position.entry_credit - currentDebit) / position.entry_credit;
  return {
    id,
    type: "EXIT",
    strategy: "Broken-Wing Put Butterfly",
    timeEt: payload.generatedAtEt,
    spot: Number(payload.metrics.spx ?? 0),
    legs,
    credit: position.entry_credit,
    debit: currentDebit,
    plPct,
    popPct: null,
    reason,
    severity: reason.toLowerCase().includes("profit") ? "good" : "caution",
    checklistSummary: "BWB monitor exit trigger.",
  };
}

function processBwbAutomation(payload: DashboardPayload): DashboardPayload {
  const bwb = (payload.bwb ?? null) as
    | null
    | {
        ready?: boolean;
        reason?: string;
        recommendation?: Record<string, unknown> | null;
        monitor?: Record<string, unknown>;
        settings?: Record<string, unknown>;
      };
  if (!bwb) return payload;

  const state = loadBwbState();
  const paperCfg = paperTradingConfig();
  const nowIso = new Date().toISOString();
  const alerts = [...payload.alerts];
  const settings = loadBwbSettings();

  // ENTRY: hidden sleeve, auto-queue when ready and no open BWB.
  if (!state.position && bwb.ready && bwb.recommendation && payload.market.isOpen) {
    const mins = minutesSince(state.lastEntryAttemptIso);
    if (mins == null || mins >= 5) {
      state.lastEntryAttemptIso = nowIso;
      const position = buildBwbPositionFromRecommendation(bwb.recommendation);
      if (position) {
        let message = "BWB setup detected.";
        let placed = false;
        if (paperCfg.enabled && paperCfg.ready) {
          const placeResult = submitPaperPrimaryOrder({
            strategy: "Broken-Wing Put Butterfly",
            orderSide: "CREDIT",
            limitPrice: position.entry_credit,
            legs: mapBwbOpenLegs(position),
            accountNumber: paperCfg.accountNumber || undefined,
            dryRun: paperCfg.dryRun,
            symbolBucket: "bwb",
          });
          placed = placeResult.ok;
          message = placeResult.ok
            ? `BWB paper order submitted${paperCfg.dryRun ? " (dry-run)" : ""}.`
            : `BWB paper submit failed: ${placeResult.message}`;
        } else {
          message = `BWB ready but paper execution unavailable: ${paperCfg.detail}`;
        }

        if (placed) {
          state.position = position;
          appendBwbLog({
            ts_iso: nowIso,
            event: "ENTRY",
            strategy: "Broken-Wing Put Butterfly",
            position_id: position.id,
            expiry: position.expiry,
            long_put_strike: position.long_put_strike,
            short_put_strike: position.short_put_strike,
            far_long_put_strike: position.far_long_put_strike,
            entry_credit: position.entry_credit,
            max_risk_points: position.max_risk_points,
            max_risk_dollars: position.max_risk_dollars,
            reason: bwb.reason ?? "BWB criteria passed",
          });
        }

        alerts.unshift(buildBwbEntryAlert(payload, bwb.recommendation, message));
      }
    }
  }

  // EXIT + greek monitor for open BWB.
  if (state.position) {
    const monitor = (bwb.monitor ?? {}) as Record<string, unknown>;
    const greekAlert = Boolean(monitor.greek_alert);
    const greekReason = String(monitor.greek_reason ?? "").trim();
    const dayKey = todayEtKey();
    if (greekAlert && dayKey !== state.lastGreekAlertDay) {
      state.lastGreekAlertDay = dayKey;
      alerts.unshift({
        id: `WARN-BWB-GREEKS-${dayKey}-${state.position.id}`,
        type: "EXIT",
        strategy: "Broken-Wing Put Butterfly",
        timeEt: payload.generatedAtEt,
        spot: Number(payload.metrics.spx ?? 0),
        legs: state.position.legs.map((row) => ({
          action: row.action,
          type: row.right,
          strike: row.strike,
          delta: Number(row.delta ?? 0),
          qty: row.qty,
        })),
        credit: state.position.entry_credit,
        debit: Number.isFinite(Number(monitor.current_debit)) ? Number(monitor.current_debit) : null,
        plPct: null,
        popPct: null,
        reason: greekReason || "BWB greek risk threshold breached.",
        severity: "caution",
        checklistSummary: "Daily greek monitor warning.",
      });
    }

    const shouldExit = Boolean(monitor.should_exit);
    if (shouldExit && payload.market.isOpen) {
      const mins = minutesSince(state.lastExitAttemptIso);
      if (mins == null || mins >= 2) {
        state.lastExitAttemptIso = nowIso;
        const exitReason = String(monitor.exit_reason ?? "BWB exit trigger");
        const currentDebit = Number.isFinite(Number(monitor.current_debit)) ? Number(monitor.current_debit) : null;
        let closeMessage = "BWB exit trigger.";
        let closed = false;
        if (paperCfg.enabled && paperCfg.ready) {
          const limitPrice =
            currentDebit != null && currentDebit > 0 ? currentDebit : Math.max(0.05, state.position.entry_credit * 0.5);
          const closeResult = submitPaperPrimaryOrder({
            strategy: "Broken-Wing Put Butterfly",
            orderSide: "DEBIT",
            limitPrice,
            legs: mapBwbCloseLegs(state.position),
            accountNumber: paperCfg.accountNumber || undefined,
            dryRun: paperCfg.dryRun,
            symbolBucket: "bwb",
          });
          closed = closeResult.ok;
          closeMessage = closeResult.ok
            ? `BWB exit submitted${paperCfg.dryRun ? " (dry-run)" : ""}: ${exitReason}`
            : `BWB exit submit failed: ${closeResult.message}`;
        } else {
          closeMessage = `BWB exit trigger but paper execution unavailable: ${paperCfg.detail}`;
        }

        alerts.unshift(buildBwbExitAlert(payload, state.position, currentDebit, closeMessage));

        if (closed) {
          const closedPosition = state.position;
          if (!closedPosition) {
            state.position = null;
          } else {
            appendBwbLog({
              ts_iso: nowIso,
              event: "EXIT",
              strategy: "Broken-Wing Put Butterfly",
              position_id: closedPosition.id,
              expiry: closedPosition.expiry,
              entry_credit: closedPosition.entry_credit,
              exit_debit: currentDebit,
              reason: exitReason,
              monitor: monitor,
            });
            state.position = null;

            const adjustmentSignal = Boolean(monitor.adjustment_signal);
            const canAdjust =
              adjustmentSignal &&
              settings.allow_adjustments &&
              settings.adjustment_mode === "ROLL" &&
              bwb.ready &&
              bwb.recommendation &&
              paperCfg.enabled &&
              paperCfg.ready;
            if (canAdjust) {
              const minsFromAdjust = minutesSince(state.lastAdjustmentIso);
              if (minsFromAdjust == null || minsFromAdjust >= 5) {
                const rollRecommendation = bwb.recommendation;
                if (!rollRecommendation) {
                  // no-op
                } else {
                  const rollPos = buildBwbPositionFromRecommendation(rollRecommendation);
                  if (rollPos && rollPos.expiry !== closedPosition.expiry) {
                  const rollResult = submitPaperPrimaryOrder({
                    strategy: "Broken-Wing Put Butterfly",
                    orderSide: "CREDIT",
                    limitPrice: rollPos.entry_credit,
                    legs: mapBwbOpenLegs(rollPos),
                    accountNumber: paperCfg.accountNumber || undefined,
                    dryRun: paperCfg.dryRun,
                    symbolBucket: "bwb",
                  });
                  state.lastAdjustmentIso = nowIso;
                  if (rollResult.ok) {
                    state.position = rollPos;
                    appendBwbLog({
                      ts_iso: nowIso,
                      event: "ADJUSTMENT_ROLL",
                      strategy: "Broken-Wing Put Butterfly",
                      from_position_id: closedPosition.id,
                      to_position_id: rollPos.id,
                      from_expiry: closedPosition.expiry,
                      to_expiry: rollPos.expiry,
                      entry_credit: rollPos.entry_credit,
                      reason: "Auto-roll after stop trigger",
                    });
                    alerts.unshift(
                      buildBwbEntryAlert(
                        payload,
                        rollRecommendation,
                        `BWB auto-roll submitted${paperCfg.dryRun ? " (dry-run)" : ""}.`,
                      ),
                    );
                  } else {
                    alerts.unshift({
                      id: `WARN-BWB-ROLL-${todayEtKey()}-${closedPosition.id}`,
                      type: "EXIT",
                      strategy: "Broken-Wing Put Butterfly",
                      timeEt: payload.generatedAtEt,
                      spot: Number(payload.metrics.spx ?? 0),
                      legs: [],
                      credit: null,
                      debit: null,
                      plPct: null,
                      popPct: null,
                      reason: `BWB auto-roll failed: ${rollResult.message}`,
                      severity: "risk",
                      checklistSummary: "Adjustment mode ROLL",
                    });
                  }
                }
                }
              }
            } else if (adjustmentSignal && settings.allow_adjustments && settings.adjustment_mode === "CONVERT_VERTICAL") {
              alerts.unshift({
                id: `WARN-BWB-CONVERT-${todayEtKey()}-${closedPosition.id}`,
                type: "EXIT",
                strategy: "Broken-Wing Put Butterfly",
                timeEt: payload.generatedAtEt,
                spot: Number(payload.metrics.spx ?? 0),
                legs: [],
                credit: null,
                debit: null,
                plPct: null,
                popPct: null,
                reason: "BWB adjustment mode CONVERT_VERTICAL requested (manual conversion required).",
                severity: "caution",
                checklistSummary: "Auto-convert is not enabled in this build.",
              });
            }
          }
        }
      }
    }
  }

  saveBwbState(state);
  const baseBwb = payload.bwb;
  return {
    ...payload,
    alerts,
    bwb: {
      ready: Boolean(baseBwb?.ready),
      reason: String(baseBwb?.reason ?? "BWB unavailable."),
      checklist: Array.isArray(baseBwb?.checklist) ? baseBwb.checklist : [],
      recommendation: baseBwb?.recommendation ?? null,
      metrics: baseBwb?.metrics,
      openPosition: state.position,
      monitor: baseBwb?.monitor,
      settings: (baseBwb?.settings ?? settings) as Record<string, number | boolean | string>,
    },
  };
}

function etDateKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

type GateNoticeIssue = {
  strategy: Strategy;
  gate: "global" | "regime";
  name: string;
  detail: string;
};

function collectNonBlockingGateIssues(payload: DashboardPayload): GateNoticeIssue[] {
  const issues: GateNoticeIssue[] = [];
  for (const candidate of payload.candidates ?? []) {
    if (!candidate.ready || !candidate.checklist) continue;
    for (const row of candidate.checklist.global ?? []) {
      if ((row.required ?? true) && row.status !== "pass") {
        issues.push({
          strategy: candidate.strategy,
          gate: "global",
          name: row.name,
          detail: row.detail || "not passing",
        });
        break;
      }
    }
    for (const row of candidate.checklist.regime ?? []) {
      if ((row.required ?? true) && row.status !== "pass") {
        issues.push({
          strategy: candidate.strategy,
          gate: "regime",
          name: row.name,
          detail: row.detail || "not passing",
        });
        break;
      }
    }
  }
  return issues;
}

function applyNonBlockingGateIssueNotices(payload: DashboardPayload): DashboardPayload {
  const issues = collectNonBlockingGateIssues(payload);
  if (issues.length === 0) return payload;
  const top = issues[0];
  const notice = `Gate notice (${top.strategy}): ${top.gate} - ${top.name}: ${top.detail}`;
  const warnings = Array.from(new Set([notice, ...(payload.warnings ?? [])])).slice(0, 3);
  return {
    ...payload,
    warnings,
  };
}

function isReadyCreditSpreadCandidate(candidate: DashboardPayload["candidates"][number]): boolean {
  if (!candidate.ready) return false;
  if (/debit|butterfly|condor|fly/i.test(candidate.strategy)) return false;
  const puts = candidate.legs.filter((leg) => leg.type === "PUT");
  const calls = candidate.legs.filter((leg) => leg.type === "CALL");
  const isVertical = (puts.length === 2 && calls.length === 0) || (calls.length === 2 && puts.length === 0);
  if (!isVertical) return false;
  const premium = Number(candidate.adjustedPremium ?? candidate.premium ?? candidate.credit ?? 0);
  return Number.isFinite(premium) && premium > 0;
}

function classifySpreadTypeFromLegs(legs: OptionLeg[]): { spreadType: string; shortStrike: number; longStrike: number } | null {
  const shortPut = legs.find((leg) => leg.action === "SELL" && leg.type === "PUT");
  const longPut = legs.find((leg) => leg.action === "BUY" && leg.type === "PUT");
  if (shortPut && longPut) {
    return { spreadType: "Bull Put Credit Spread", shortStrike: shortPut.strike, longStrike: longPut.strike };
  }
  const shortCall = legs.find((leg) => leg.action === "SELL" && leg.type === "CALL");
  const longCall = legs.find((leg) => leg.action === "BUY" && leg.type === "CALL");
  if (shortCall && longCall) {
    return { spreadType: "Bear Call Credit Spread", shortStrike: shortCall.strike, longStrike: longCall.strike };
  }
  return null;
}

function resolveDteMetaForCandidate(
  payload: DashboardPayload,
  candidate: DashboardPayload["candidates"][number],
): { targetDte: number | null; selectedDte: number | null; expiry: string | null; spreadType: string } {
  const spread = classifySpreadTypeFromLegs(candidate.legs);
  const fallbackSpreadType = spread?.spreadType ?? String(candidate.strategy);

  if (candidate.strategy === "2-DTE Credit Spread") {
    const rec = (payload.twoDte?.recommendation ?? null) as Record<string, unknown> | null;
    const expiry = rec ? String(rec.expiry ?? "") : "";
    const selected = Number.isFinite(Number(rec?.selected_dte)) ? Number(rec?.selected_dte) : Number(candidate.daysToExpiry ?? 0);
    return {
      targetDte: 2,
      selectedDte: selected > 0 ? selected : null,
      expiry: /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null,
      spreadType: String(rec?.type ?? fallbackSpreadType),
    };
  }

  const target = (payload.multiDte?.targets ?? []).find((row) => row.strategy_label === candidate.strategy);
  const rec = (target?.recommendation ?? null) as Record<string, unknown> | null;
  const expiry = String(rec?.expiry ?? target?.expiration ?? "");
  const targetDte = Number.isFinite(Number(target?.target_dte)) ? Number(target?.target_dte) : null;
  const selected = Number.isFinite(Number(target?.selected_dte))
    ? Number(target?.selected_dte)
    : Number.isFinite(Number(candidate.daysToExpiry))
      ? Number(candidate.daysToExpiry)
      : null;

  return {
    targetDte,
    selectedDte: selected != null && selected > 0 ? selected : null,
    expiry: /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null,
    spreadType: String(rec?.type ?? fallbackSpreadType),
  };
}

function buildCreditSpreadReadyAlerts(payload: DashboardPayload): AlertItem[] {
  const dateKey = etDateKey();
  const out: AlertItem[] = [];

  for (const candidate of payload.candidates ?? []) {
    if (!isReadyCreditSpreadCandidate(candidate)) continue;
    const spread = classifySpreadTypeFromLegs(candidate.legs);
    if (!spread) continue;
    const meta = resolveDteMetaForCandidate(payload, candidate);
    const shortDelta = candidate.legs.find((leg) => leg.action === "SELL")?.delta;
    const popPct = Number.isFinite(Number(shortDelta)) ? Math.max(0, Math.min(1, 1 - Math.abs(Number(shortDelta)))) : null;
    const expiryPart = meta.expiry ?? "NA";
    const id = `ENTRY-${candidate.strategy.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_\-]/g, "")}-${dateKey}-${expiryPart}-${Math.round(spread.shortStrike)}-${Math.round(spread.longStrike)}`;
    const credit = Number(candidate.adjustedPremium ?? candidate.premium ?? candidate.credit ?? 0);

    out.push({
      id,
      type: "ENTRY",
      strategy: candidate.strategy,
      timeEt: payload.generatedAtEt,
      spot: Number(payload.metrics?.spx ?? 0),
      legs: candidate.legs,
      credit: Number.isFinite(credit) ? credit : null,
      debit: null,
      plPct: null,
      popPct,
      spreadType: meta.spreadType,
      expiry: meta.expiry,
      targetDte: meta.targetDte,
      selectedDte: meta.selectedDte,
      reason: `${meta.spreadType} criteria passed.`,
      severity: "good",
      checklistSummary:
        candidate.reason ||
        `Target DTE ${meta.targetDte ?? "-"} | Selected DTE ${meta.selectedDte ?? "-"} | Exp ${meta.expiry ?? "-"}`,
    });
  }

  return out;
}

function mergeAlerts(base: AlertItem[], additions: AlertItem[]): AlertItem[] {
  const map = new Map<string, AlertItem>();
  for (const alert of [...additions, ...base]) {
    if (!map.has(alert.id)) {
      map.set(alert.id, alert);
    }
  }
  return Array.from(map.values());
}

function loadTelegramState(): TelegramDedupeState {
  try {
    if (!existsSync(TELEGRAM_STATE_PATH)) return { sent_ids: [] };
    const parsed = JSON.parse(readFileSync(TELEGRAM_STATE_PATH, "utf8")) as TelegramDedupeState;
    if (!Array.isArray(parsed.sent_ids)) return { sent_ids: [] };
    return { sent_ids: parsed.sent_ids.slice(-500) };
  } catch {
    return { sent_ids: [] };
  }
}

function saveTelegramState(state: TelegramDedupeState) {
  try {
    writeFileSync(TELEGRAM_STATE_PATH, JSON.stringify({ sent_ids: state.sent_ids.slice(-500) }, null, 2));
  } catch {
    // ignore write failures
  }
}

function formatLegLine(legDef: OptionLeg): string {
  const action = legDef.action === "SELL" ? "Sell" : "Buy";
  const sign = legDef.delta >= 0 ? "+" : "";
  const qty = Number.isFinite(Number(legDef.qty)) && Number(legDef.qty) > 0 ? Math.round(Number(legDef.qty)) : 1;
  return `${action} ${qty} ${legDef.type} ${Math.round(legDef.strike)} (Δ ${sign}${legDef.delta.toFixed(2)})`;
}

function formatTelegramAlert(alert: AlertItem): string {
  const header = alert.type === "ENTRY" ? "SPX 0DTE ENTRY SIGNAL" : "SPX 0DTE EXIT SIGNAL";
  const legs = alert.legs.map(formatLegLine).join("\n");
  const pl = alert.plPct == null ? "-" : `${Math.round(alert.plPct * 100)}%`;
  const pop = alert.popPct == null ? "-" : `${Math.round(alert.popPct * 100)}%`;
  const targetDte = alert.targetDte == null ? "-" : `${alert.targetDte}`;
  const selectedDte = alert.selectedDte == null ? "-" : `${alert.selectedDte}`;
  const expiry = alert.expiry ?? "-";
  const spreadType = alert.spreadType ?? alert.strategy;

  return [
    header,
    `Strategy: ${alert.strategy}`,
    `Spread Type: ${spreadType}`,
    `Time: ${alert.timeEt} ET`,
    `Spot: ${alert.spot.toFixed(2)}`,
    `DTE: target ${targetDte} / selected ${selectedDte}`,
    `Expiry: ${expiry}`,
    "LEGS:",
    legs,
    `Credit: ${alert.credit == null ? "-" : alert.credit.toFixed(2)}`,
    `Debit: ${alert.debit == null ? "-" : alert.debit.toFixed(2)}`,
    `P/L: ${pl}`,
    `POP: ${pop}`,
    `Reason: ${alert.reason}`,
    `Checklist: ${alert.checklistSummary ?? "All strict required checks passed."}`,
  ].join("\n");
}

async function maybeSendTelegramAlerts(alerts: AlertItem[], enabled: boolean) {
  if (!enabled || alerts.length === 0) return;

  const token = telegramToken();
  const chatId = telegramChatId();
  if (!token || !chatId) return;

  const state = loadTelegramState();
  const sent = new Set(state.sent_ids);
  const beforeSize = sent.size;
  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

  for (const alert of alerts) {
    if (sent.has(alert.id)) continue;

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatTelegramAlert(alert),
        }),
      });

      if (res.ok) {
        sent.add(alert.id);
        recordAlertSentEvent({
          strategy: alert.strategy,
          candidate_id: null,
          dte_bucket: alert.selectedDte ?? alert.targetDte ?? null,
          alert_id: alert.id,
          reason: alert.reason,
        });
      }
    } catch {
      // keep polling loop resilient
    }
  }

  if (sent.size !== beforeSize) {
    saveTelegramState({ sent_ids: Array.from(sent) });
  }
}

async function sendTelegramMessage(text: string): Promise<{ ok: boolean; status: number; message: string }> {
  const token = telegramToken();
  const chatId = telegramChatId();
  if (!token || !chatId) {
    return { ok: false, status: 400, message: "Telegram not configured." };
  }

  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      return { ok: false, status: response.status, message: "Telegram API request failed." };
    }
    return { ok: true, status: 200, message: "Telegram test sent." };
  } catch {
    return { ok: false, status: 500, message: "Telegram send failed." };
  }
}

function loadSystemAlertState(): SystemAlertState {
  try {
    if (!existsSync(SYSTEM_ALERT_STATE_PATH)) return {};
    const parsed = JSON.parse(readFileSync(SYSTEM_ALERT_STATE_PATH, "utf8")) as SystemAlertState;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSystemAlertState(state: SystemAlertState): void {
  try {
    mkdirSync(path.dirname(SYSTEM_ALERT_STATE_PATH), { recursive: true });
    writeFileSync(SYSTEM_ALERT_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // best effort only
  }
}

function parseIsoMs(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeSystemIssueKey(text: string): string {
  return String(text ?? "")
    .trim()
    .replace(/\(\s*\d+ms\s*>\s*\d+ms\s*\)/gi, "(stale)")
    .replace(/age=\s*\d+ms/gi, "age=n/a")
    .replace(/\b\d+ms\b/gi, "Xms")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function maybeSendSystemHealthAlert(payload: DashboardPayload, enabled: boolean): Promise<void> {
  if (!enabled) return;
  const stale = payload.staleData ?? { active: false, detail: "" };
  const contract = payload.dataContract;
  const degraded = payload.market.isOpen && contract?.status === "degraded";
  if (!stale && !degraded) return;

  const state = loadSystemAlertState();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const cooldownSec = Math.max(60, Number(process.env.SPX0DTE_SYSTEM_ALERT_COOLDOWN_SEC ?? 300));
  const prevMs = parseIsoMs(state.lastStaleSentAtIso);
  const inCooldown = prevMs != null && nowMs - prevMs < cooldownSec * 1000;
  const detail = String(stale.detail ?? "").trim();
  const detailKey = normalizeSystemIssueKey(detail);
  const detailChanged = detailKey !== String(state.lastStaleDetail ?? "");

  if (stale.active && (!inCooldown || detailChanged || state.staleActivePreviously === false)) {
    const staleAction = STRICT_LIVE_BLOCKS
      ? "Action: Entry alerts blocked until live/fresh data resumes."
      : "Action: Warning only (STRICT_LIVE_BLOCKS=false). Triggers remain enabled.";
    const lines = [
      "⚠️ SPX0DTE DATA LATENCY ALERT",
      `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
      `Source: ${payload.market.source}`,
      `Reason: ${detail || "Data stale"}`,
      staleAction,
    ];
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent.ok) {
      state.lastStaleSentAtIso = nowIso;
      state.lastStaleDetail = detailKey;
      state.staleActivePreviously = true;
      saveSystemAlertState(state);
    }
    return;
  }

  if (!stale.active && state.staleActivePreviously) {
    const staleClearedText = STRICT_LIVE_BLOCKS
      ? "Data freshness restored. Entry checks re-enabled."
      : "Data freshness restored. Warning state cleared.";
    const lines = [
      "✅ SPX0DTE DATA RECOVERY",
      `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
      `Source: ${payload.market.source}`,
      staleClearedText,
    ];
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent.ok) {
      state.staleActivePreviously = false;
      state.lastStaleDetail = "";
      state.lastStaleSentAtIso = nowIso;
      saveSystemAlertState(state);
    }
    return;
  }

  state.staleActivePreviously = stale.active;

  const degradedIssue = degraded ? String(contract?.issues?.[0] ?? "Data contract degraded.") : "";
  const degradedIssueKey = normalizeSystemIssueKey(degradedIssue);
  const degradedIssueChanged = degradedIssueKey !== String(state.lastDegradedIssueKey ?? "");
  const prevDegradedMs = parseIsoMs(state.lastDegradedSentAtIso);
  const degradedInCooldown = prevDegradedMs != null && nowMs - prevDegradedMs < cooldownSec * 1000;

  if (degraded && (!degradedInCooldown || degradedIssueChanged || state.degradedActivePreviously === false)) {
    const degradedAction = STRICT_LIVE_BLOCKS
      ? "Action: Triggers paused until required feeds are fresh."
      : "Action: Warning only (STRICT_LIVE_BLOCKS=false). Triggers remain enabled.";
    const lines = [
      "⚠️ SPX0DTE DEGRADED MODE",
      `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
      `Source: ${payload.market.source}`,
      `Issue: ${degradedIssue}`,
      degradedAction,
    ];
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent.ok) {
      state.lastDegradedSentAtIso = nowIso;
      state.lastDegradedIssueKey = degradedIssueKey;
      state.degradedActivePreviously = true;
      saveSystemAlertState(state);
    }
    return;
  }

  if (!degraded && state.degradedActivePreviously) {
    const clearedText = STRICT_LIVE_BLOCKS
      ? "Data contract healthy. Triggers resumed."
      : "Data contract healthy. Warning state cleared.";
    const lines = [
      "✅ SPX0DTE DEGRADED MODE CLEARED",
      `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
      clearedText,
    ];
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent.ok) {
      state.degradedActivePreviously = false;
      state.lastDegradedIssueKey = "";
      state.lastDegradedSentAtIso = nowIso;
      saveSystemAlertState(state);
    }
    return;
  }

  state.degradedActivePreviously = degraded;
  saveSystemAlertState(state);
}

async function maybeSendGateNoticeAlert(payload: DashboardPayload, enabled: boolean): Promise<void> {
  if (!enabled || !payload.market.isOpen) return;
  const issues = collectNonBlockingGateIssues(payload);
  const state = loadSystemAlertState();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const cooldownSec = Math.max(60, Number(process.env.SPX0DTE_GATE_NOTICE_COOLDOWN_SEC ?? 300));
  const prevMs = parseIsoMs(state.lastGateNoticeSentAtIso);
  const inCooldown = prevMs != null && nowMs - prevMs < cooldownSec * 1000;

  if (issues.length > 0) {
    const issue = issues[0];
    const issueKey = `${issue.strategy}|${issue.gate}|${issue.name}|${issue.detail}`;
    const issueChanged = issueKey !== String(state.lastGateNoticeKey ?? "");
    if (!inCooldown || issueChanged || state.gateNoticeActivePreviously === false) {
      const lines = [
        "⚠️ SPX0DTE GATE NOTICE (NON-BLOCKING)",
        `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
        `Strategy: ${issue.strategy}`,
        `Gate: ${issue.gate.toUpperCase()}`,
        `Issue: ${issue.name} - ${issue.detail}`,
        "Action: Strategy checks can still trigger alerts; review this notice.",
      ];
      const sent = await sendTelegramMessage(lines.join("\n"));
      if (sent.ok) {
        state.lastGateNoticeSentAtIso = nowIso;
        state.lastGateNoticeKey = issueKey;
        state.gateNoticeActivePreviously = true;
        saveSystemAlertState(state);
      }
    }
    return;
  }

  if (state.gateNoticeActivePreviously) {
    const lines = [
      "✅ SPX0DTE GATE NOTICE CLEARED",
      `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
      "No active global/regime gate notices on ready candidates.",
    ];
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent.ok) {
      state.lastGateNoticeSentAtIso = nowIso;
      state.lastGateNoticeKey = "";
      state.gateNoticeActivePreviously = false;
      saveSystemAlertState(state);
    }
  }
}

function detectMacroBlockState(payload: DashboardPayload): {
  macroActive: boolean;
  macroDetail: string;
} {
  const globalRows = payload.globalChecklist ?? [];
  const macroRow = globalRows.find((row) => /macro event/i.test(row.name));
  const macroActive = Boolean(macroRow && macroRow.status !== "pass");
  const macroDetail = String(macroRow?.detail ?? "Macro event window active.");
  return { macroActive, macroDetail };
}

async function maybeSendMacroBlockAlert(payload: DashboardPayload, enabled: boolean): Promise<void> {
  if (!enabled || !payload.market.isOpen) return;
  const state = loadSystemAlertState();
  const nowIso = new Date().toISOString();

  const macro = detectMacroBlockState(payload);
  const macroKey = `${macro.macroActive}|${normalizeSystemIssueKey(macro.macroDetail)}`;
  const macroChanged = macroKey !== String(state.lastMacroBlockKey ?? "");
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowIso));
  const macroDailyKey = `${etDate}|${normalizeSystemIssueKey(macro.macroDetail)}`;
  const alreadySentToday = macroDailyKey === String(state.lastMacroNoticeDailyKey ?? "");

  // Macro notices are informational-only; emit once per active window.
  if (macro.macroActive && !alreadySentToday && (macroChanged || state.macroBlockActivePreviously !== true)) {
    const lines = [
      "⚠️ SPX0DTE MACRO EVENT NOTICE",
      `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
      `Macro: ${macro.macroDetail}`,
      "Mode: informational only (entries are not blocked by macro events).",
      "Action: review caution and manage risk/discretion manually.",
    ];
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent.ok) {
      state.lastMacroBlockSentAtIso = nowIso;
      state.lastMacroBlockKey = macroKey;
      state.macroBlockActivePreviously = true;
      state.lastMacroNoticeDailyKey = macroDailyKey;
      saveSystemAlertState(state);
    }
    return;
  }

  if (!macro.macroActive && state.macroBlockActivePreviously) {
    const lines = [
      "✅ SPX0DTE MACRO WINDOW CLEARED",
      `Time: ${payload.generatedAtEt} ET / ${payload.generatedAtParis} Paris`,
      "Macro blocking window ended.",
    ];
    const sent = await sendTelegramMessage(lines.join("\n"));
    if (sent.ok) {
      state.lastMacroBlockSentAtIso = nowIso;
      state.lastMacroBlockKey = "";
      state.macroBlockActivePreviously = false;
      saveSystemAlertState(state);
    }
    return;
  }

  state.macroBlockActivePreviously = macro.macroActive;
  saveSystemAlertState(state);
}

export async function GET(request: Request) {
  const ctx = buildReqCtx(request, "GET");
  debugLog(ctx, "request_start");
  const marketOpen = isMarketOpenEt();
  const marketClosedOverride = !marketOpen && SIMULATION_MODE;
  const telegramEnabled = process.env.SPX0DTE_ENABLE_TELEGRAM === "true";
  const openTrades = readTradeStateOpenTrades();

  let payload: DashboardPayload;
  if (!marketOpen) {
    if (marketClosedOverride) {
      const liveOrDelayed = readPythonSnapshot();
      const fallback = buildUnavailablePayload("Market closed. Override enabled but no delayed/historical snapshot available.");
      const base = liveOrDelayed ?? fallback;
      const overrideWarning = "Market closed - using HISTORICAL/DELAYED data. Not for live trading.";
      payload = {
        ...base,
        market: {
          ...base.market,
          isOpen: false,
          hoursEt: MARKET_HOURS_ET,
          source: liveOrDelayed ? base.market.source : "market-closed",
          telegramEnabled,
        },
        openTrades,
        warnings: Array.from(new Set([...(base.warnings ?? []), overrideWarning])).map(compactWarning).slice(0, 2),
      };
    } else {
      const closed = buildUnavailablePayload("Market closed.");
      payload = {
        ...forceClosed(closed),
        market: {
          ...closed.market,
          isOpen: false,
          hoursEt: MARKET_HOURS_ET,
          source: "market-closed",
          telegramEnabled,
        },
        openTrades,
        warnings: [],
      };
    }
  } else {
    const live = readPythonSnapshot();
    const base = live ?? buildUnavailablePayload("Live data unavailable. Check tastytrade credentials.");
    payload = {
      ...base,
      market: {
        ...base.market,
        isOpen: true,
        hoursEt: MARKET_HOURS_ET,
        telegramEnabled,
      },
      alerts: base.alerts,
      openTrades,
      warnings: (base.warnings ?? []).map(compactWarning).slice(0, 1),
    };
  }

  payload = attachSleeve(payload);
  payload = attachStartupHealth(payload);
  payload = {
    ...payload,
    upcomingMacroEvents: loadUpcomingMacroEvents(),
    macroCalendarStatus: loadMacroCalendarStatus(),
  };
  const twoDteSettings = loadTwoDteSettings();
  const multiDteSettings = loadMultiDteSettings();
  const twoDteOrders = loadTwoDteOrders();
  const paperCfg = paperTradingConfig();
  payload = {
    ...payload,
    multiDteSettings,
    twoDte: {
      ready: Boolean(payload.twoDte?.ready),
      reason: payload.twoDte?.reason ?? "2-DTE sleeve waiting for setup.",
      checklist: payload.twoDte?.checklist ?? [],
      recommendation: payload.twoDte?.recommendation ?? null,
      metrics: payload.twoDte?.metrics ?? {},
      settings: { ...twoDteSettings, ...(payload.twoDte?.settings ?? {}) },
      openTrades:
        Array.isArray(payload.twoDte?.openTrades) && payload.twoDte.openTrades.length > 0
          ? payload.twoDte.openTrades
          : twoDteOrders,
      executionMode: {
        paperEnabled: paperCfg.enabled,
        paperReady: paperCfg.ready,
        paperDryRun: paperCfg.dryRun,
        detail: paperCfg.detail,
      },
    },
  };

  payload = withMultiDteCandidates(payload);
  const candidateSync = upsertCandidatesFromDashboard(payload);
  const markSync = updateOpenTradeMarksFromDashboard(payload);
  if (BWB_ENABLED) {
    payload = processBwbAutomation(payload);
    payload = withBwbCandidate(payload);
  } else {
    payload = {
      ...payload,
      candidates: payload.candidates.filter((row) => row.strategy !== "Broken-Wing Put Butterfly"),
      strategyEligibility: (payload.strategyEligibility ?? []).filter((row) => row.strategy !== "Broken-Wing Put Butterfly"),
      alerts: payload.alerts.filter((row) => row.strategy !== "Broken-Wing Put Butterfly"),
    };
  }
  payload = applyLongerTimeframeMode(payload);
  payload = applyDataContract(payload);
  payload = applyStaleDataKillSwitch(payload);
  payload = applyExecutionModel(payload);
  payload = stripRiskSleeveChecks(payload);
  payload = {
    ...payload,
    candidates: payload.candidates.map(enforceStrictCandidate),
  };
  payload = applyNonBlockingGateIssueNotices(payload);

  const readyStrategies = new Set(payload.candidates.filter((c) => c.ready).map((c) => c.strategy));
  payload = {
    ...payload,
    alerts: payload.alerts.filter((alert) => alert.type !== "ENTRY" || readyStrategies.has(alert.strategy)),
  };

  const creditSpreadAlerts = buildCreditSpreadReadyAlerts(payload);
  if (creditSpreadAlerts.length > 0) {
    payload = {
      ...payload,
      alerts: mergeAlerts(payload.alerts, creditSpreadAlerts),
    };
  }

  payload = {
    ...payload,
    alerts: applyAlertAckSuppression(payload.alerts),
  };
  payload = applyAlertPolicy(payload);
  payload = applyEntryDebounce(payload);
  payload = withEvaluationTick(payload);
  payload = withOpenRiskHeatmap(payload);
  payload = buildAnalyticsScorecard(payload);
  payload = {
    ...payload,
    preflight: buildPreflight(payload),
    tradeMemory: {
      candidateSync,
      markSync,
    },
  };
  payload = withDataModeAndAges(payload, marketClosedOverride);
  payload = applySnapshotHeaderIntegrityGuards(payload, ctx);
  payload = ensureSnapshotHeaderShape(payload);
  const decision = evaluateDecision(buildDecisionInput(payload));
  payload = {
    ...payload,
    decision,
    warnings: Array.from(
      new Set([
        ...(payload.warnings ?? []),
        ...(decision.warnings
          .filter((row) => row.code === "SIMULATION_ACTIVE" || row.code === "ALERTS_SUPPRESSED_SIMULATION")
          .map((row) => row.message)),
      ]),
    ),
  };
  debugLog(ctx, "decision_run", {
    run_id: decision.debug.runId,
    status: decision.status,
    data_mode: decision.debug.dataMode,
    session: decision.debug.session,
    ranked_count: decision.ranked.length,
  });
  persistLastChartSeries(payload);
  savePreflight(payload.preflight);
  appendSnapshotLog(payload);
  saveProviderHealthState(payload);
  const canSendOperationalAlerts = telegramEnabled && (marketOpen || (marketClosedOverride && ALLOW_SIM_ALERTS));
  await maybeSendSystemHealthAlert(payload, canSendOperationalAlerts && ENABLE_SYSTEM_HEALTH_ALERTS);
  await maybeSendGateNoticeAlert(payload, canSendOperationalAlerts && ENABLE_GATE_NOTICE_ALERTS);
  await maybeSendMacroBlockAlert(payload, canSendOperationalAlerts && ENABLE_MACRO_ALERTS);

  await maybeSendTelegramAlerts(payload.alerts, canSendOperationalAlerts);

  const durationMs = Date.now() - ctx.startedAtMs;
  const responsePayload = ensureSnapshotHeaderShape(payload);
  debugLog(ctx, "request_end", {
    status: 200,
    duration_ms: durationMs,
    market_source: responsePayload.market?.source ?? "unknown",
    candidate_count: responsePayload.candidates.length,
    alert_count: responsePayload.alerts.length,
  });
  return NextResponse.json(responsePayload, {
    status: 200,
    headers: {
      "x-request-id": ctx.requestId,
      "x-eval-duration-ms": String(durationMs),
    },
  });
}

export async function POST(request: Request) {
  const ctx = buildReqCtx(request, "POST");
  debugLog(ctx, "request_start");
  let action = "";
  let rawBody: Record<string, unknown> = {};
  try {
    const body = (await request.json()) as Record<string, unknown>;
    rawBody = body;
    action = String(body.action ?? "");
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid request body." }, { status: 400 });
  }

  debugLog(ctx, "post_action", { action });

  if (action === "ack_alert") {
    const result = acknowledgeAlert(rawBody.alert);
    return NextResponse.json({ ok: result.ok, message: result.message }, { status: result.ok ? 200 : 400 });
  }

  if (action === "clear_alert_acks") {
    saveAlertAckState({ entries: [] });
    return NextResponse.json({ ok: true, message: "Alert acknowledgements cleared." }, { status: 200 });
  }

  if (action === "replay_summary") {
    const rawLimit = Number(rawBody.limit ?? 300);
    const limit = Number.isFinite(rawLimit) ? Math.max(50, Math.min(2000, Math.round(rawLimit))) : 300;
    const summary = buildReplaySummary(limit);
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  }

  if (action === "replay_walk_forward") {
    const rawLimit = Number(rawBody.limit ?? 800);
    const rawWindow = Number(rawBody.windowSize ?? 180);
    const rawStep = Number(rawBody.stepSize ?? 60);
    const limit = Number.isFinite(rawLimit) ? Math.max(100, Math.min(5_000, Math.round(rawLimit))) : 800;
    const windowSize = Number.isFinite(rawWindow) ? Math.max(30, Math.min(1_000, Math.round(rawWindow))) : 180;
    const stepSize = Number.isFinite(rawStep) ? Math.max(10, Math.min(500, Math.round(rawStep))) : 60;
    const summary = buildWalkForwardReplay(limit, windowSize, stepSize);
    return NextResponse.json({ ok: true, summary }, { status: 200 });
  }

  if (action === "run_historical_backtest") {
    const yearsRaw = Number(rawBody.years ?? 10);
    const years = Number.isFinite(yearsRaw) ? Math.max(2, Math.min(50, Math.round(yearsRaw))) : 10;
    const sleeveSettings = loadSleeveSettings();
    const sleeveCapitalRaw = Number(rawBody.sleeveCapital ?? sleeveSettings.sleeveCapital);
    const sleeveCapital = Number.isFinite(sleeveCapitalRaw) ? Math.max(1000, sleeveCapitalRaw) : sleeveSettings.sleeveCapital;
    const run = runHistoricalBacktest({ years, sleeveCapital });
    return NextResponse.json(
      {
        ok: run.ok,
        message: run.message,
        result: run.result ?? null,
      },
      { status: run.ok ? 200 : 400 },
    );
  }

  if (action === "run_preflight") {
    const marketOpen = isMarketOpenEt();
    let payload: DashboardPayload = marketOpen
      ? ({
          ...(readPythonSnapshot() ?? buildUnavailablePayload("Live data unavailable. Check tastytrade credentials.")),
        } as DashboardPayload)
      : SIMULATION_MODE
        ? ({
            ...(readPythonSnapshot() ??
              buildUnavailablePayload("Market closed. Override enabled but no delayed/historical snapshot available.")),
          } as DashboardPayload)
        : buildUnavailablePayload("Market closed.");
    if (!marketOpen) {
      payload = {
        ...payload,
        market: {
          ...payload.market,
          isOpen: false,
          hoursEt: MARKET_HOURS_ET,
          source: payload.market?.source ?? "market-closed",
        },
      };
    }
    payload = attachSleeve(payload);
    payload = attachStartupHealth(payload);
    payload = applyStaleDataKillSwitch(payload);
    payload = withOpenRiskHeatmap(payload);
    payload = withDataModeAndAges(payload, !marketOpen && SIMULATION_MODE);
    const preflight = buildPreflight(payload);
    savePreflight(preflight);
    return NextResponse.json({ ok: true, preflight }, { status: 200 });
  }

  if (action === "update_execution_model") {
    const next = sanitizeExecutionModelSettings(rawBody);
    try {
      saveExecutionModelSettings(next);
      return NextResponse.json({ ok: true, message: "Execution model saved.", settings: next }, { status: 200 });
    } catch {
      return NextResponse.json({ ok: false, message: "Unable to save execution model." }, { status: 500 });
    }
  }

  if (action === "update_alert_policy") {
    const next = sanitizeAlertPolicySettings(rawBody);
    try {
      saveAlertPolicySettings(next);
      return NextResponse.json({ ok: true, message: "Alert policy saved.", settings: next }, { status: 200 });
    } catch {
      return NextResponse.json({ ok: false, message: "Unable to save alert policy." }, { status: 500 });
    }
  }

  if (action === "update_sleeve_settings") {
    const next = sanitizeSleeveSettings({
      sleeveCapital: rawBody.sleeveCapital,
      totalAccount: rawBody.totalAccount,
      maxDrawdownPct: rawBody.maxDrawdownPct,
      dailyRealizedPnl: rawBody.dailyRealizedPnl,
      weeklyRealizedPnl: rawBody.weeklyRealizedPnl,
      dailyLock: rawBody.dailyLock,
      weeklyLock: rawBody.weeklyLock,
    });
    try {
      saveSleeveSettings(next);
      return NextResponse.json({ ok: true, message: "Sleeve settings saved.", sleeveSettings: next }, { status: 200 });
    } catch {
      return NextResponse.json({ ok: false, message: "Unable to save sleeve settings." }, { status: 500 });
    }
  }

  if (action === "update_2dte_settings") {
    const next = sanitizeTwoDteSettings(rawBody);
    try {
      saveTwoDteSettings(next);
      return NextResponse.json({ ok: true, message: "2-DTE settings saved.", settings: next }, { status: 200 });
    } catch {
      return NextResponse.json({ ok: false, message: "Unable to save 2-DTE settings." }, { status: 500 });
    }
  }

  if (action === "save_settings") {
    const settings = (rawBody.settings ?? {}) as Record<string, unknown>;
    const multiDteRaw = (settings.multiDte ?? settings) as Record<string, unknown>;
    const next = sanitizeMultiDteSettings(multiDteRaw);
    try {
      saveMultiDteSettings(next);
      return NextResponse.json({ ok: true, message: "Settings saved.", multiDteSettings: next }, { status: 200 });
    } catch {
      return NextResponse.json({ ok: false, message: "Unable to save settings." }, { status: 500 });
    }
  }

  if (action === "update_bwb_settings") {
    const next = sanitizeBwbSettings(rawBody);
    try {
      saveBwbSettings(next);
      return NextResponse.json({ ok: true, message: "BWB settings saved.", settings: next }, { status: 200 });
    } catch {
      return NextResponse.json({ ok: false, message: "Unable to save BWB settings." }, { status: 500 });
    }
  }

  if (action === "place_2dte_trade") {
    const recommendation = rawBody.recommendation as Record<string, unknown> | undefined;
    if (!recommendation || typeof recommendation !== "object") {
      return NextResponse.json({ ok: false, message: "Missing recommendation payload." }, { status: 400 });
    }
    const shortStrike = Number(recommendation.short_strike);
    const longStrike = Number(recommendation.long_strike);
    const credit = Number(recommendation.adjusted_credit ?? recommendation.credit);
    const width = Number(recommendation.width);
    if (!Number.isFinite(shortStrike) || !Number.isFinite(longStrike) || !Number.isFinite(credit) || !Number.isFinite(width)) {
      return NextResponse.json({ ok: false, message: "Invalid recommendation fields." }, { status: 400 });
    }
    const paperCfg = paperTradingConfig();
    if (!paperCfg.enabled) {
      return NextResponse.json({ ok: false, message: "Paper trading is disabled. Enable SPX0DTE_PAPER_TRADING=true." }, { status: 400 });
    }
    if (!paperCfg.ready) {
      return NextResponse.json({ ok: false, message: paperCfg.detail }, { status: 400 });
    }

    const now = new Date();
    const orderId = `2DTE-${now.getTime()}`;
    const recType = String(recommendation.type ?? "2-DTE Credit Spread");
    const right = String(recommendation.right ?? "").toUpperCase();
    const settings = loadTwoDteSettings();
    const order: TwoDteOrder = {
      id: orderId,
      placed_at_iso: now.toISOString(),
      status: "OPEN",
      strategy: recType,
      right,
      expiry: String(recommendation.expiry ?? ""),
      short_strike: shortStrike,
      long_strike: longStrike,
      width,
      entry_credit: credit,
      stop_debit: Number(recommendation.stop_debit ?? credit * settings.stop_multiple),
      profit_take_debit: Number(recommendation.profit_take_debit ?? settings.profit_take_debit),
      use_delta_stop: Boolean(recommendation.use_delta_stop ?? settings.use_delta_stop),
      delta_stop: Number(recommendation.delta_stop ?? settings.delta_stop),
      max_loss_dollars: Number(recommendation.max_loss_dollars ?? (width - credit) * 100),
      notes: "Queued from dashboard Place Trade action.",
      legs: recommendation.legs ?? [],
    };
    const shortSymbol = String(recommendation.short_symbol ?? "");
    const longSymbol = String(recommendation.long_symbol ?? "");
    let paperResult: { ok: boolean; message: string; raw?: Record<string, unknown> };
    if (!shortSymbol || !longSymbol) {
      paperResult = { ok: false, message: "Missing option symbols for paper submit." };
    } else {
      paperResult = submitPaperTwoDteOrder({
        shortSymbol,
        longSymbol,
        entryCredit: credit,
        stopDebit: Number(order.stop_debit),
        profitTakeDebit: Number(order.profit_take_debit),
        accountNumber: paperCfg.accountNumber || undefined,
        dryRun: paperCfg.dryRun,
      });
    }
    order.paper_mode = true;
    order.paper_result = paperResult?.raw ?? { ok: paperResult?.ok ?? false, message: paperResult?.message ?? "" };
    order.paper_message = paperResult?.message ?? "";
    order.status = paperResult?.ok ? "OPEN" : "PAPER_FAILED";
    const orders = loadTwoDteOrders();
    orders.unshift(order);
    saveTwoDteOrders(orders.slice(0, 200));
    const msg = paperResult
      ? paperResult.ok
        ? `2-DTE paper trade submitted${paperCfg.dryRun ? " (dry-run)" : ""}.`
        : `2-DTE queued, paper submit failed: ${paperResult.message}`
      : "2-DTE trade queued.";
    const candidateId = String(recommendation.candidate_id ?? "").trim();
    const tracked =
      paperResult?.ok && candidateId
        ? acceptCandidateAsTrade({
            candidate_id: candidateId,
            quantity: Number(rawBody.quantity ?? 1),
            filled_credit: Number.isFinite(credit) ? credit : undefined,
            fees_estimate: Number(rawBody.fees_estimate ?? 0),
          })
        : null;
    return NextResponse.json(
      {
        ok: true,
        message: tracked?.ok ? `${msg} Candidate linked to blotter trade.` : msg,
        order,
        trackedTrade: tracked?.row ?? null,
      },
      { status: 200 },
    );
  }

  if (action === "place_multidte_trade") {
    const candidate = rawBody.candidate as Record<string, unknown> | undefined;
    const dte = Number(rawBody.dte ?? 0);
    if (!candidate || typeof candidate !== "object") {
      return NextResponse.json({ ok: false, message: "Missing candidate payload." }, { status: 400 });
    }
    if (!Number.isFinite(dte) || dte <= 0) {
      return NextResponse.json({ ok: false, message: "Missing/invalid DTE value." }, { status: 400 });
    }
    if (dte === 2) {
      return NextResponse.json(
        { ok: false, message: "Use action=place_2dte_trade for 2-DTE paper routing." },
        { status: 400 },
      );
    }

    const strategy = String(candidate.strategy ?? `${Math.round(dte)}-DTE Credit Spread`).trim();
    const ready = Boolean(candidate.ready);
    if (!ready) {
      return NextResponse.json({ ok: false, message: "Strategy is blocked; paper order not sent." }, { status: 400 });
    }

    const premium = Number(candidate.adjustedPremium ?? candidate.credit ?? 0);
    if (!Number.isFinite(premium) || premium <= 0) {
      return NextResponse.json({ ok: false, message: "Missing/invalid premium for paper order." }, { status: 400 });
    }

    const legsRaw = Array.isArray(candidate.legs) ? candidate.legs : [];
    const legs = legsRaw
      .map((leg) => {
        const row = leg as Record<string, unknown>;
        const symbol = String(row.symbol ?? "").trim();
        const actionRaw = String(row.action ?? "").toUpperCase();
        const qty = Number(row.qty ?? 1);
        if (!symbol || !Number.isFinite(qty) || qty <= 0) return null;
        if (actionRaw === "BUY") return { symbol, action: "BUY_TO_OPEN" as const, qty: Math.round(qty) };
        if (actionRaw === "SELL") return { symbol, action: "SELL_TO_OPEN" as const, qty: Math.round(qty) };
        return null;
      })
      .filter((v): v is { symbol: string; action: "BUY_TO_OPEN" | "SELL_TO_OPEN"; qty: number } => Boolean(v));
    if (legs.length === 0 || legs.length !== legsRaw.length) {
      return NextResponse.json({ ok: false, message: "Missing option symbols for one or more strategy legs." }, { status: 400 });
    }

    const paperCfg = paperTradingConfig();
    if (!paperCfg.enabled) {
      return NextResponse.json({ ok: false, message: "Paper trading is disabled. Enable SPX0DTE_PAPER_TRADING=true." }, { status: 400 });
    }
    if (!paperCfg.ready) {
      return NextResponse.json({ ok: false, message: paperCfg.detail }, { status: 400 });
    }

    const result = submitPaperPrimaryOrder({
      strategy,
      orderSide: "CREDIT",
      limitPrice: premium,
      legs,
      accountNumber: paperCfg.accountNumber || undefined,
      dryRun: paperCfg.dryRun,
      symbolBucket: "dte2",
    });
    const message = result.ok
      ? `${strategy} paper order submitted${paperCfg.dryRun ? " (dry-run)" : ""}.`
      : `${strategy} paper submit failed: ${result.message}`;
    const candidateId = String(candidate.candidateId ?? candidate.candidate_id ?? "").trim();
    const tracked =
      result.ok && candidateId
        ? acceptCandidateAsTrade({
            candidate_id: candidateId,
            quantity: Number(rawBody.quantity ?? 1),
            filled_credit: Number.isFinite(premium) ? premium : undefined,
            fees_estimate: Number(rawBody.fees_estimate ?? 0),
          })
        : null;
    return NextResponse.json(
      {
        ok: result.ok,
        message: tracked?.ok ? `${message} Candidate linked to blotter trade.` : message,
        result: result.raw ?? null,
        trackedTrade: tracked?.row ?? null,
      },
      { status: result.ok ? 200 : 500 },
    );
  }

  if (action === "place_primary_trade") {
    const candidate = rawBody.candidate as Record<string, unknown> | undefined;
    if (!candidate || typeof candidate !== "object") {
      return NextResponse.json({ ok: false, message: "Missing candidate payload." }, { status: 400 });
    }
    const strategy = String(candidate.strategy ?? "").trim();
    if (!strategy) {
      return NextResponse.json({ ok: false, message: "Missing strategy." }, { status: 400 });
    }
    const ready = Boolean(candidate.ready);
    if (!ready) {
      return NextResponse.json({ ok: false, message: "Strategy is blocked; paper order not sent." }, { status: 400 });
    }

    const premium = Number(candidate.adjustedPremium ?? candidate.credit ?? 0);
    if (!Number.isFinite(premium) || premium <= 0) {
      return NextResponse.json({ ok: false, message: "Missing/invalid premium for paper order." }, { status: 400 });
    }
    const orderSide = strategy === "Convex Debit Spread" ? "DEBIT" : "CREDIT";

    const legsRaw = Array.isArray(candidate.legs) ? candidate.legs : [];
    const legs = legsRaw
      .map((leg) => {
        const row = leg as Record<string, unknown>;
        const symbol = String(row.symbol ?? "").trim();
        const actionRaw = String(row.action ?? "").toUpperCase();
        const qty = Number(row.qty ?? 1);
        if (!symbol || !Number.isFinite(qty) || qty <= 0) return null;
        if (actionRaw === "BUY") return { symbol, action: "BUY_TO_OPEN" as const, qty: Math.round(qty) };
        if (actionRaw === "SELL") return { symbol, action: "SELL_TO_OPEN" as const, qty: Math.round(qty) };
        return null;
      })
      .filter((v): v is { symbol: string; action: "BUY_TO_OPEN" | "SELL_TO_OPEN"; qty: number } => Boolean(v));

    if (legs.length === 0 || legs.length !== legsRaw.length) {
      return NextResponse.json({ ok: false, message: "Missing option symbols for one or more strategy legs." }, { status: 400 });
    }

    const paperCfg = paperTradingConfig();
    if (!paperCfg.enabled) {
      return NextResponse.json({ ok: false, message: "Paper trading is disabled. Enable SPX0DTE_PAPER_TRADING=true." }, { status: 400 });
    }
    if (!paperCfg.ready) {
      return NextResponse.json({ ok: false, message: paperCfg.detail }, { status: 400 });
    }

    const result = submitPaperPrimaryOrder({
      strategy,
      orderSide,
      limitPrice: premium,
      legs,
      accountNumber: paperCfg.accountNumber || undefined,
      dryRun: paperCfg.dryRun,
      symbolBucket: strategy === "Broken-Wing Put Butterfly" ? "bwb" : "dte0",
    });

    const message = result.ok
      ? `${strategy} paper order submitted${paperCfg.dryRun ? " (dry-run)" : ""}.`
      : `${strategy} paper submit failed: ${result.message}`;
    const candidateId = String(candidate.candidateId ?? candidate.candidate_id ?? "").trim();
    const tracked =
      result.ok && candidateId
        ? acceptCandidateAsTrade({
            candidate_id: candidateId,
            quantity: Number(rawBody.quantity ?? 1),
            filled_credit: Number.isFinite(premium) ? premium : undefined,
            fees_estimate: Number(rawBody.fees_estimate ?? 0),
          })
        : null;
    return NextResponse.json(
      {
        ok: result.ok,
        message: tracked?.ok ? `${message} Candidate linked to blotter trade.` : message,
        result: result.raw ?? null,
        trackedTrade: tracked?.row ?? null,
      },
      { status: result.ok ? 200 : 500 },
    );
  }

  if (action === "close_2dte_trade") {
    const id = String(rawBody.id ?? "");
    if (!id) {
      return NextResponse.json({ ok: false, message: "Missing trade id." }, { status: 400 });
    }
    const orders = loadTwoDteOrders();
    const updated = orders.map((o) => {
      if (String(o.id ?? "") !== id) return o;
      return { ...o, status: "CLOSED", closed_at_iso: new Date().toISOString(), exit_reason: "Manual close from dashboard" };
    });
    saveTwoDteOrders(updated);
    return NextResponse.json({ ok: true, message: "2-DTE trade closed." }, { status: 200 });
  }

  if (action !== "telegram_test") {
    debugLog(ctx, "request_end", { status: 400, action, reason: "unsupported_action", duration_ms: Date.now() - ctx.startedAtMs });
    return NextResponse.json(
      { ok: false, message: "Unsupported action." },
      { status: 400, headers: { "x-request-id": ctx.requestId } },
    );
  }

  const now = new Date();
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);
  const paris = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now);

  const message = [
    "SPX 0DTE TELEGRAM TEST",
    `Time ET: ${et}`,
    `Time Paris: ${paris}`,
    "Status: manual connectivity check",
  ].join("\n");

  const result = await sendTelegramMessage(message);
  debugLog(ctx, "request_end", {
    status: result.status,
    action,
    telegram_ok: result.ok,
    duration_ms: Date.now() - ctx.startedAtMs,
  });
  return NextResponse.json(
    { ok: result.ok, message: result.message },
    { status: result.status, headers: { "x-request-id": ctx.requestId } },
  );
}
