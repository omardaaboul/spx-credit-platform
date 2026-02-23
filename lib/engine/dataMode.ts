import type { DataMode, FreshnessAgesMs, FreshnessPolicySec, SessionState } from "@/lib/contracts/decision";

type ResolveDataModeInput = {
  source: string;
  session: SessionState;
  simulationMode: boolean;
  freshnessAges: FreshnessAgesMs;
  freshnessPolicy: FreshnessPolicySec;
};

const LIVE_RE = /(tastytrade-live|live)/i;
const DELAYED_RE = /(partial|delayed|cache)/i;
const HISTORICAL_RE = /(snapshot-log|historical|stooq|archive)/i;
const FIXTURE_RE = /(fixture|inactive|unavailable|market-closed)/i;

function feedIsFresh(ageMs: number | null, maxAgeS: number): boolean {
  if (ageMs == null) return false;
  return ageMs <= maxAgeS * 1000;
}

function hasFreshCoreFeeds(ages: FreshnessAgesMs, policy: FreshnessPolicySec): boolean {
  return (
    feedIsFresh(ages.spot, policy.spot_max_age_s) &&
    feedIsFresh(ages.chain, policy.chain_max_age_s) &&
    feedIsFresh(ages.greeks, policy.greeks_max_age_s)
  );
}

export function resolveDataMode(input: ResolveDataModeInput): DataMode {
  const source = String(input.source ?? "").toLowerCase();
  const freshCore = hasFreshCoreFeeds(input.freshnessAges, input.freshnessPolicy);

  if (LIVE_RE.test(source) && freshCore) return "LIVE";
  if (LIVE_RE.test(source) || DELAYED_RE.test(source)) return "DELAYED";
  if (HISTORICAL_RE.test(source)) return "HISTORICAL";
  if (FIXTURE_RE.test(source)) {
    if (input.simulationMode) return "HISTORICAL";
    return "FIXTURE";
  }
  if (input.simulationMode) return "HISTORICAL";
  if (input.session === "CLOSED") return "FIXTURE";
  return "FIXTURE";
}

export function normalizeDataMode(raw: unknown, fallback: DataMode): DataMode {
  const value = String(raw ?? "").toUpperCase();
  if (value === "LIVE" || value === "DELAYED" || value === "HISTORICAL" || value === "FIXTURE") {
    return value;
  }
  return fallback;
}
