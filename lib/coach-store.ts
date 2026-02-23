export type CoachRules = {
  name: string;
  riskPerTradePercentDefault: number;
  maxDailyLossPercent: number;
  maxTradesPerDay: number;
  requireChecklistBeforeEntry: boolean;
  requireMaxLossDefined: boolean;
};

export type CoachSetupType = "credit" | "debit" | "long_option" | "other";

export type CoachSetup = {
  id: string;
  name: string;
  type: CoachSetupType;
  description: string;
  entryCriteria: string;
  exitCriteria: string;
  bestMarketConditions: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CoachDirection = "bullish" | "bearish" | "neutral";
export type CoachIVContext = "low" | "medium" | "high" | "unknown";
export type CoachExitReason = "target_hit" | "stop_hit" | "time_stop" | "discretionary" | "assignment" | "other";
export type CoachEmotionalState = "calm" | "anxious" | "angry" | "tired" | "distracted" | "FOMO" | "revenge" | "other";
export type CoachPlanStatus = "planned" | "entered" | "closed" | "canceled";

export type CoachPlan = {
  id: string;
  setupId?: string | null;
  symbol: string;
  direction: CoachDirection;
  strategyDetails: string;
  plannedEntryDate: string;
  enteredAt?: string | null;
  closedAt?: string | null;
  status: CoachPlanStatus;
  accountValueAtEntry?: number | null;
  maxRiskAmount: number;
  maxRiskPercent: number;
  positionSizeContracts?: number | null;
  thesis: string;
  catalystsOrContext: string;
  ivContext: CoachIVContext;
  invalidationLevel: string;
  takeProfitPlan: string;
  stopLossPlan: string;
  timeStopPlan: string;
  confidenceScore: number;
  checklistCompleted: boolean;
  exitReason?: CoachExitReason | null;
  pnlAmount?: number | null;
  pnlPercent?: number | null;
  notes?: string | null;
  emotionalState?: CoachEmotionalState | null;
  followedPlan?: boolean | null;
  mistakes?: string | null;
  lessons?: string | null;
  createdAt: string;
  updatedAt: string;
};

const LS_COACH_RULES = "optionslog_coach_rules";
const LS_COACH_SETUPS = "optionslog_coach_setups";
const LS_COACH_PLANS = "optionslog_coach_plans";

export const DEFAULT_COACH_RULES: CoachRules = {
  name: "Default Rules",
  riskPerTradePercentDefault: 1,
  maxDailyLossPercent: 3,
  maxTradesPerDay: 3,
  requireChecklistBeforeEntry: true,
  requireMaxLossDefined: true,
};

function safeParseNumber(s: string, fallback = 0) {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function readJson<T>(key: string, fallback: T) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadCoachRules(): CoachRules {
  const raw = readJson<Partial<CoachRules>>(LS_COACH_RULES, {});
  return {
    name: raw.name ?? DEFAULT_COACH_RULES.name,
    riskPerTradePercentDefault: safeParseNumber(String(raw.riskPerTradePercentDefault ?? DEFAULT_COACH_RULES.riskPerTradePercentDefault), DEFAULT_COACH_RULES.riskPerTradePercentDefault),
    maxDailyLossPercent: safeParseNumber(String(raw.maxDailyLossPercent ?? DEFAULT_COACH_RULES.maxDailyLossPercent), DEFAULT_COACH_RULES.maxDailyLossPercent),
    maxTradesPerDay: Math.max(1, Math.round(safeParseNumber(String(raw.maxTradesPerDay ?? DEFAULT_COACH_RULES.maxTradesPerDay), DEFAULT_COACH_RULES.maxTradesPerDay))),
    requireChecklistBeforeEntry: raw.requireChecklistBeforeEntry ?? DEFAULT_COACH_RULES.requireChecklistBeforeEntry,
    requireMaxLossDefined: raw.requireMaxLossDefined ?? DEFAULT_COACH_RULES.requireMaxLossDefined,
  };
}

export function saveCoachRules(rules: CoachRules) {
  writeJson(LS_COACH_RULES, rules);
}

export function loadCoachSetups(): CoachSetup[] {
  return readJson<CoachSetup[]>(LS_COACH_SETUPS, []);
}

export function saveCoachSetups(setups: CoachSetup[]) {
  writeJson(LS_COACH_SETUPS, setups);
}

export function createCoachSetup(data: Omit<CoachSetup, "id" | "createdAt" | "updatedAt">) {
  const now = new Date().toISOString();
  return {
    ...data,
    id: createId(),
    createdAt: now,
    updatedAt: now,
  };
}

export function loadCoachPlans(): CoachPlan[] {
  return readJson<CoachPlan[]>(LS_COACH_PLANS, []);
}

export function saveCoachPlans(plans: CoachPlan[]) {
  writeJson(LS_COACH_PLANS, plans);
}

export function addCoachPlan(plan: Omit<CoachPlan, "id" | "createdAt" | "updatedAt">) {
  const plans = loadCoachPlans();
  const now = new Date().toISOString();
  const entry: CoachPlan = {
    ...plan,
    id: createId(),
    createdAt: now,
    updatedAt: now,
  };
  plans.unshift(entry);
  saveCoachPlans(plans);
  return entry.id;
}

export function updateCoachPlan(id: string, updates: Partial<CoachPlan>) {
  const plans = loadCoachPlans();
  const next = plans.map((p) => (p.id === id ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p));
  saveCoachPlans(next);
}

export function deleteCoachPlan(id: string) {
  const plans = loadCoachPlans().filter((p) => p.id !== id);
  saveCoachPlans(plans);
}
