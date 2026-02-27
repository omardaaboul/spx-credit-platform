import type { CandidateCard, ChecklistItem, ChecklistStatus, DashboardPayload, Strategy } from "@/lib/spx0dte";

export type ReadinessState = "pass" | "fail" | "blocked" | "degraded" | "na";

export type ReadinessSection = {
  key: string;
  title: string;
  rows: ChecklistItem[];
  strategy?: Strategy;
};

export type ReadinessGate = {
  key: "system" | "global" | "regime" | "liquidity" | "volatility";
  label: string;
  state: ReadinessState;
  reason: string;
  counts: {
    pass: number;
    fail: number;
    blocked: number;
    required: number;
  };
  sectionKey?: string;
};

export type SleeveReadiness = {
  key: string;
  strategy: Strategy;
  state: ReadinessState;
  candidateExists: boolean;
  ready: boolean;
  reason: string;
  metrics: Array<{ label: string; value: string }>;
  counts: {
    pass: number;
    fail: number;
    blocked: number;
    required: number;
  };
  sectionKey: string;
};

export type DiagnosticsSection = {
  key: string;
  title: string;
  strategy?: Strategy;
  state: ReadinessState;
  rows: ChecklistItem[];
  counts: {
    pass: number;
    fail: number;
    blocked: number;
    required: number;
    total: number;
  };
};

export type ReadinessSummary = {
  marketStatus: "open" | "closed";
  dataFreshness: "live" | "stale" | "missing";
  systemState: ReadinessState;
  systemReason: string;
  gates: ReadinessGate[];
  sleeves: SleeveReadiness[];
  banners: Array<{ level: "info" | "warning" | "critical"; text: string }>;
  diagnosticsSections: DiagnosticsSection[];
};

export function strategySectionKey(strategy: Strategy): string {
  return `strategy-${strategy.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

type SummarizeInput = {
  sections: ReadinessSection[];
  candidates: CandidateCard[];
  strategyEligibility: DashboardPayload["strategyEligibility"] | undefined;
  market: DashboardPayload["market"] | undefined;
  staleData: DashboardPayload["staleData"] | undefined;
  startupHealth: DashboardPayload["startupHealth"] | undefined;
  dataContract: DashboardPayload["dataContract"] | undefined;
};

const STRATEGY_ORDER: Strategy[] = [
  "Iron Condor",
  "Iron Fly",
  "2-DTE Credit Spread",
  "Directional Spread",
  "Convex Debit Spread",
  "Broken-Wing Put Butterfly",
];

const VOL_PATTERN = /volatility|vix|atr|range|emr|expansion/i;
const LIQ_PATTERN = /liquidity|bid\/ask|spread/i;

export function summarizeChecklist(input: SummarizeInput): ReadinessSummary {
  const {
    sections,
    candidates,
    strategyEligibility,
    market,
    staleData,
    startupHealth,
    dataContract,
  } = input;

  const marketStatus: "open" | "closed" = market?.isOpen ? "open" : "closed";

  const systemIssues: string[] = [];
  if (startupHealth) {
    if (!startupHealth.telegram.ok) systemIssues.push(startupHealth.telegram.detail || "Telegram not healthy.");
    if (!startupHealth.tastySdk.ok) systemIssues.push(startupHealth.tastySdk.detail || "Tasty SDK unavailable.");
    if (!startupHealth.tastyCredentials.ok) systemIssues.push(startupHealth.tastyCredentials.detail || "Tasty credentials missing.");
  }
  if (dataContract?.status === "degraded") {
    systemIssues.push(dataContract.issues?.[0] ?? "Data contract degraded.");
  }

  const source = market?.source ?? "live-unavailable";
  const dataFreshness: "live" | "stale" | "missing" =
    source === "live-unavailable"
      ? "missing"
      : staleData?.active
        ? "stale"
        : source === "tastytrade-live" || source === "tastytrade-partial"
          ? "live"
          : "missing";

  const systemState: ReadinessState = systemIssues.length > 0 ? "degraded" : "pass";
  const systemReason = systemIssues[0] ?? "All required services healthy.";

  const sectionMap = new Map<string, ReadinessSection>();
  sections.forEach((section) => sectionMap.set(section.key, section));
  const globalRows = sectionMap.get("global")?.rows ?? [];
  const regimeRows = sectionMap.get("regime")?.rows ?? [];

  const diagnosticsSections: DiagnosticsSection[] = sections.map((section) => {
    const counts = summarizeRows(section.rows);
    return {
      key: section.key,
      title: section.title,
      strategy: section.strategy,
      state: deriveStateFromRows(section.rows),
      rows: section.rows,
      counts: { ...counts, total: section.rows.length },
    };
  });

  const globalGate = buildGate("global", "Global Gate", globalRows, "global", systemState);
  const regimeGate = buildGate("regime", "Regime Gate", regimeRows, "regime", systemState);
  const liquidityGate = buildGate(
    "liquidity",
    "Liquidity Gate",
    globalRows.filter((row) => LIQ_PATTERN.test(row.name)),
    "global",
    systemState,
  );
  const volatilityGate = buildGate(
    "volatility",
    "Volatility Gate",
    globalRows.filter((row) => VOL_PATTERN.test(row.name)),
    "global",
    systemState,
  );

  const gates: ReadinessGate[] = [
    {
      key: "system",
      label: "System Health",
      state: systemState,
      reason: shortReason(systemReason),
      counts: { pass: systemState === "pass" ? 1 : 0, fail: 0, blocked: 0, required: 1 },
    },
    globalGate,
    regimeGate,
    liquidityGate,
    volatilityGate,
  ];

  const eligibilityByStrategy = new Map((strategyEligibility ?? []).map((row) => [row.strategy, row]));

  const sleeves: SleeveReadiness[] = STRATEGY_ORDER.map((strategy) => {
    const candidate = candidates.find((c) => c.strategy === strategy);
    const sectionKey = strategySectionKey(strategy);
    const sectionRows = sectionMap.get(sectionKey)?.rows ?? candidate?.checklist?.strategy ?? [];
    const counts = summarizeRows(sectionRows);
    let state = deriveStateFromRows(sectionRows);

    const eligibility = eligibilityByStrategy.get(strategy);
    if (!sectionRows.length && eligibility?.status) {
      state = mapChecklistStatus(eligibility.status);
    }

    if (candidate?.ready) {
      state = "pass";
    }
    if (systemState === "degraded") {
      state = "degraded";
    }

    const candidateExists = Boolean(candidate && candidate.legs.length > 0);
    const reason = shortReason(resolveSleeveReason(candidate, sectionRows, eligibility?.reason));

    const metrics = buildSleeveMetrics(candidate);

    return {
      key: sectionKey,
      strategy,
      state,
      candidateExists,
      ready: Boolean(candidate?.ready),
      reason,
      metrics,
      counts,
      sectionKey,
    };
  });

  const banners = buildBanners({
    marketStatus,
    rows: diagnosticsSections.flatMap((section) => section.rows),
    systemState,
    systemReason,
  });

  return {
    marketStatus,
    dataFreshness,
    systemState,
    systemReason,
    gates,
    sleeves,
    banners,
    diagnosticsSections,
  };
}

function buildBanners(input: {
  marketStatus: "open" | "closed";
  rows: ChecklistItem[];
  systemState: ReadinessState;
  systemReason: string;
}): Array<{ level: "info" | "warning" | "critical"; text: string }> {
  const { marketStatus, rows, systemState, systemReason } = input;
  const banners: Array<{ level: "info" | "warning" | "critical"; text: string }> = [];

  if (systemState === "degraded") {
    banners.push({ level: "critical", text: `DEGRADED: ${shortReason(systemReason)}` });
  }

  const marketClosedHits = rows.filter((row) => /market closed/i.test(`${row.detail ?? ""} ${row.reason ?? ""}`)).length;
  if (marketStatus === "closed" || marketClosedHits > 0) {
    banners.push({ level: "info", text: "Market closed - evaluation paused for time-gated criteria." });
  }

  const blockedDataHits = rows.filter((row) => {
    const text = `${row.detail ?? ""} ${row.reason ?? ""}`;
    return row.status === "blocked" && /missing|stale|incomplete|unavailable/i.test(text);
  }).length;
  if (blockedDataHits > 0 && marketStatus === "open") {
    banners.push({ level: "warning", text: "Data incomplete/stale - affected criteria are blocked until feeds recover." });
  }

  return banners;
}

function buildGate(
  key: ReadinessGate["key"],
  label: string,
  rows: ChecklistItem[],
  sectionKey: string,
  systemState: ReadinessState,
): ReadinessGate {
  const counts = summarizeRows(rows);
  let state = deriveStateFromRows(rows);
  if (systemState === "degraded") {
    state = "degraded";
  }

  const failed = rows.find((row) => (row.required ?? true) && row.status !== "pass");
  const reason = shortReason(failed?.detail || failed?.reason || defaultStateReason(state));

  return {
    key,
    label,
    state,
    reason,
    counts,
    sectionKey,
  };
}

function defaultStateReason(state: ReadinessState): string {
  if (state === "pass") return "All required checks passing.";
  if (state === "blocked") return "Blocked by missing or stale required data.";
  if (state === "fail") return "One or more required checks failed.";
  if (state === "degraded") return "System health degraded; triggers paused.";
  return "No required checks available.";
}

function resolveSleeveReason(candidate: CandidateCard | undefined, rows: ChecklistItem[], eligibilityReason?: string): string {
  if (candidate?.ready) return "All required criteria passing.";
  if (candidate?.blockedReason) return candidate.blockedReason;

  const fail = rows.find((row) => (row.required ?? true) && row.status !== "pass");
  if (fail) {
    return `${fail.name}: ${fail.detail || fail.reason || statusLabel(fail.status)}`;
  }

  if (candidate?.reason) return candidate.reason;
  if (eligibilityReason) return eligibilityReason;

  return "No candidate generated.";
}

function buildSleeveMetrics(candidate?: CandidateCard): Array<{ label: string; value: string }> {
  if (!candidate) return [];
  const premiumLabel = candidate.premiumLabel ?? (candidate.strategy === "Convex Debit Spread" ? "Debit" : "Credit");
  const premium = candidate.adjustedPremium ?? candidate.credit;

  const metrics: Array<{ label: string; value: string }> = [];
  metrics.push({ label: premiumLabel, value: Number.isFinite(premium) ? premium.toFixed(2) : "-" });
  metrics.push({
    label: "POP",
    value: Number.isFinite(candidate.popPct ?? Number.NaN) ? `${(Number(candidate.popPct) * 100).toFixed(0)}%` : "-",
  });

  if (Number.isFinite(candidate.width) && candidate.width > 0) {
    metrics.push({ label: "Width", value: `${candidate.width}` });
  }

  return metrics.slice(0, 2);
}

function summarizeRows(rows: ChecklistItem[]): {
  pass: number;
  fail: number;
  blocked: number;
  required: number;
} {
  const requiredRows = rows.filter((row) => row.required !== false);
  return {
    pass: requiredRows.filter((row) => row.status === "pass").length,
    fail: requiredRows.filter((row) => row.status === "fail").length,
    blocked: requiredRows.filter((row) => row.status === "blocked").length,
    required: requiredRows.length,
  };
}

function deriveStateFromRows(rows: ChecklistItem[]): ReadinessState {
  const requiredRows = rows.filter((row) => row.required !== false);
  if (requiredRows.length === 0) return "na";
  if (requiredRows.some((row) => row.status === "blocked")) return "blocked";
  if (requiredRows.some((row) => row.status === "fail")) return "fail";
  if (requiredRows.every((row) => row.status === "pass")) return "pass";
  return "na";
}

function mapChecklistStatus(status: ChecklistStatus): ReadinessState {
  if (status === "pass") return "pass";
  if (status === "fail") return "fail";
  if (status === "blocked") return "blocked";
  return "na";
}

function statusLabel(status: ChecklistStatus): string {
  if (status === "pass") return "pass";
  if (status === "fail") return "failed";
  if (status === "blocked") return "blocked";
  return "n/a";
}

function shortReason(reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim();
  if (!clean) return "-";
  if (/market closed/i.test(clean)) return "Paused until market open.";
  if (/missing|stale|incomplete|unavailable/i.test(clean)) return "Blocked by missing/stale required data.";
  if (clean.length <= 110) return clean;
  return `${clean.slice(0, 107)}...`;
}
