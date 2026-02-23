export type DashboardRange = "MTD" | "YTD" | "L12M" | "ALL";

export const DASHBOARD_RANGES: DashboardRange[] = ["MTD", "YTD", "L12M", "ALL"];

const LS_DEFAULT_CAPITAL = "optionslog_default_capital";
const LS_CAPITAL_BY_MONTH = "optionslog_capital_by_month";
const LS_GOAL_RETURN_PCT = "optionslog_goal_return_pct";
const LS_DASHBOARD_RANGE = "optionslog_dashboard_range";

function safeParseNumber(s: string) {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function loadDefaultCapital() {
  try {
    const v = localStorage.getItem(LS_DEFAULT_CAPITAL);
    return v ? safeParseNumber(v) : 0;
  } catch {
    return 0;
  }
}

export function saveDefaultCapital(v: number) {
  try {
    localStorage.setItem(LS_DEFAULT_CAPITAL, String(v));
  } catch {}
}

export function loadCapitalByMonth(): Record<string, number> {
  try {
    const v = localStorage.getItem(LS_CAPITAL_BY_MONTH);
    if (!v) return {};
    const obj = JSON.parse(v);
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(obj ?? {})) {
      const n = safeParseNumber(String(val));
      if (k && Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCapitalByMonth(obj: Record<string, number>) {
  try {
    localStorage.setItem(LS_CAPITAL_BY_MONTH, JSON.stringify(obj));
  } catch {}
}

export function loadGoalReturnPct(defaultValue: number) {
  try {
    const v = localStorage.getItem(LS_GOAL_RETURN_PCT);
    if (!v) return defaultValue;
    const n = safeParseNumber(v);
    return Number.isFinite(n) ? n : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function saveGoalReturnPct(v: number) {
  try {
    localStorage.setItem(LS_GOAL_RETURN_PCT, String(v));
  } catch {}
}

export function loadDashboardRange(defaultValue: DashboardRange) {
  try {
    const v = localStorage.getItem(LS_DASHBOARD_RANGE);
    if (!v) return defaultValue;
    return DASHBOARD_RANGES.includes(v as DashboardRange) ? (v as DashboardRange) : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function saveDashboardRange(v: DashboardRange) {
  try {
    localStorage.setItem(LS_DASHBOARD_RANGE, v);
  } catch {}
}
