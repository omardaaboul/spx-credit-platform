import type { ChecklistItem, DashboardPayload, Strategy } from "@/lib/spx0dte";

export type DataKey =
  | "underlying_price"
  | "option_chain"
  | "greeks"
  | "intraday_candles"
  | "vwap"
  | "atr_1m_5"
  | "realized_range_15m"
  | "expected_move"
  | "regime";

type FeedSpec = {
  label: string;
  maxAgeMs: number;
};

type RawFeed = {
  value?: unknown;
  timestampIso?: string | null;
  source?: string;
  error?: string | null;
};

export type ValidatedFeed = {
  key: DataKey;
  label: string;
  maxAgeMs: number;
  source: string;
  value?: unknown;
  timestampIso: string | null;
  ageMs: number | null;
  isValid: boolean;
  error?: string;
};

export type DataContractResult = {
  status: "healthy" | "degraded" | "inactive";
  checkedAtIso: string;
  issues: string[];
  feeds: Record<DataKey, ValidatedFeed>;
};

const FEED_SPECS: Record<DataKey, FeedSpec> = {
  underlying_price: { label: "SPX underlying", maxAgeMs: 15_000 },
  option_chain: { label: "Option chain", maxAgeMs: 20_000 },
  greeks: { label: "Greeks", maxAgeMs: 20_000 },
  intraday_candles: { label: "Intraday candles", maxAgeMs: 90_000 },
  vwap: { label: "VWAP", maxAgeMs: 90_000 },
  atr_1m_5: { label: "ATR(1m,5)", maxAgeMs: 90_000 },
  realized_range_15m: { label: "15m realized range", maxAgeMs: 180_000 },
  expected_move: { label: "Expected move (EM/EMR)", maxAgeMs: 300_000 },
  regime: { label: "Regime classification", maxAgeMs: 30_000 },
};

const VALID_REGIMES = new Set(["COMPRESSION", "CHOP", "TREND_UP", "TREND_DOWN", "EXPANSION"]);

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function feedValueValid(key: DataKey, value: unknown): boolean {
  switch (key) {
    case "underlying_price":
      return isFiniteNumber(value) && value > 0;
    case "option_chain":
    case "greeks":
    case "intraday_candles":
      return isFiniteNumber(value) && value >= 1;
    case "vwap":
    case "expected_move":
      return isFiniteNumber(value) && value > 0;
    case "atr_1m_5":
    case "realized_range_15m":
      return isFiniteNumber(value) && value >= 0;
    case "regime":
      return typeof value === "string" && VALID_REGIMES.has(String(value));
    default:
      return false;
  }
}

function formatAge(ageMs: number | null): string {
  return ageMs == null ? "n/a" : `${Math.max(0, Math.round(ageMs))}ms`;
}

function buildInputs(payload: DashboardPayload): Record<DataKey, RawFeed> {
  const raw = (payload.dataFeeds ?? {}) as Record<string, RawFeed>;
  const get = (key: DataKey): RawFeed => raw[key] ?? {};
  return {
    underlying_price: get("underlying_price"),
    option_chain: get("option_chain"),
    greeks: get("greeks"),
    intraday_candles: get("intraday_candles"),
    vwap: get("vwap"),
    atr_1m_5: get("atr_1m_5"),
    realized_range_15m: get("realized_range_15m"),
    expected_move: get("expected_move"),
    regime: get("regime"),
  };
}

export function evaluateDataContract(
  payload: DashboardPayload,
  nowMs: number = Date.now(),
  options?: { allowClosedEvaluation?: boolean },
): DataContractResult {
  const checkedAtIso = new Date(nowMs).toISOString();
  const allowClosedEvaluation = options?.allowClosedEvaluation === true;
  if (!payload.market.isOpen && !allowClosedEvaluation) {
    const feeds = Object.fromEntries(
      (Object.keys(FEED_SPECS) as DataKey[]).map((key) => {
        const spec = FEED_SPECS[key];
        const item: ValidatedFeed = {
          key,
          label: spec.label,
          maxAgeMs: spec.maxAgeMs,
          source: "inactive",
          value: null,
          timestampIso: null,
          ageMs: null,
          isValid: false,
          error: "Market closed.",
        };
        return [key, item];
      }),
    ) as Record<DataKey, ValidatedFeed>;
    return { status: "inactive", checkedAtIso, issues: [], feeds };
  }

  const inputs = buildInputs(payload);
  const feeds = {} as Record<DataKey, ValidatedFeed>;
  const issues: string[] = [];

  for (const key of Object.keys(FEED_SPECS) as DataKey[]) {
    const spec = FEED_SPECS[key];
    const input = inputs[key] ?? {};
    const source = String(input.source ?? "unknown");
    const timestampIso = input.timestampIso ?? null;
    const tsMs = parseIsoMs(timestampIso);
    const ageMs = tsMs == null ? null : Math.max(0, nowMs - tsMs);
    const stale = ageMs == null || ageMs > spec.maxAgeMs;
    const hasValue = feedValueValid(key, input.value);
    const hasError = Boolean(input.error && String(input.error).trim());

    let error: string | undefined;
    if (hasError) {
      error = String(input.error);
    } else if (tsMs == null) {
      error = "Missing timestamp.";
    } else if (!hasValue) {
      error = "Missing/invalid value.";
    } else if (stale) {
      error = `Stale (${formatAge(ageMs)} > ${spec.maxAgeMs}ms).`;
    }

    const isValid = !error;
    feeds[key] = {
      key,
      label: spec.label,
      maxAgeMs: spec.maxAgeMs,
      source,
      value: input.value,
      timestampIso,
      ageMs,
      isValid,
      error,
    };
    if (!isValid) {
      issues.push(`${spec.label}: ${error ?? "invalid"} source=${source}, age=${formatAge(ageMs)}.`);
    }
  }

  return {
    status: issues.length === 0 ? "healthy" : "degraded",
    checkedAtIso,
    issues,
    feeds,
  };
}

function criterionId(section: "global" | "regime" | "strategy", strategy: Strategy | undefined, label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const strat = strategy ? strategy.toLowerCase().replace(/[^a-z0-9]+/g, "-") : "all";
  return `${section}.${strat}.${base}`;
}

function inferRequires(
  row: ChecklistItem,
  section: "global" | "regime" | "strategy",
): DataKey[] {
  const name = String(row.name ?? "").toLowerCase();
  const requires = new Set<DataKey>();
  const add = (...keys: DataKey[]) => keys.forEach((k) => requires.add(k));

  // Control gates can still fail without data dependencies (time/macro/risk locks).
  if (/regime|strategy allowed in this regime|regime confidence/.test(name) || section === "regime") {
    add("regime");
  }
  if (/trend|slope|mtf/.test(name)) {
    add("regime", "intraday_candles");
  }
  if (/spot/.test(name)) add("underlying_price");
  if (/vwap/.test(name)) add("vwap", "underlying_price");
  if (/atr/.test(name)) add("atr_1m_5");
  if (/15m|realized range|high\/low/.test(name)) add("realized_range_15m");
  if (/emr|expected move|full-day em/.test(name)) add("expected_move");

  // Liquidity depends on chain quotes, not greek availability.
  if (/liquidity/.test(name)) add("option_chain");

  // Option structure and pricing checks.
  if (/candidate exists|strike|width|wings|expiration|breakout|credit|debit|slippage|iv rank|implied vol/.test(name)) {
    add("option_chain");
  }

  // Delta/POP checks require greeks and chain context.
  if (/delta|pop/.test(name)) add("option_chain", "greeks");

  // Candle-driven indicators.
  if (/30m data depth|measured move|ema|macd|overbought|oversold|support|resistance/.test(name)) {
    add("intraday_candles");
  }

  if (/volatility expansion/.test(name)) add("regime", "expected_move");

  return Array.from(requires);
}

function isGenericMissing(detail: string | undefined): boolean {
  if (!detail) return false;
  const text = detail.toLowerCase();
  return (
    text.includes("data missing") ||
    text.includes("missing or threshold") ||
    text.includes("unavailable") ||
    text.includes("insufficient data")
  );
}

export function applyDataContractToRows(
  rows: ChecklistItem[],
  section: "global" | "regime" | "strategy",
  strategy: Strategy | undefined,
  contract: DataContractResult,
): ChecklistItem[] {
  return rows.map((row) => {
    const requires = inferRequires(row, section);
    const dataAgeMs = Object.fromEntries(requires.map((k) => [k, contract.feeds[k]?.ageMs ?? null]));
    const rowId = criterionId(section, strategy, row.name);
    const base: ChecklistItem = {
      ...row,
      id: rowId,
      label: row.name,
      requires,
      dataAgeMs,
      observed: row.observed ?? (row.detail ? { text: row.detail } : {}),
      thresholds: row.thresholds ?? {},
    };

    if ((row.required ?? true) === false || row.status === "na") {
      return {
        ...base,
        reason: row.reason ?? row.detail ?? "Not applicable.",
      };
    }

    if (contract.status === "degraded" && requires.length > 0) {
      const blockedFeed = requires
        .map((k) => contract.feeds[k])
        .find((feed) => !feed?.isValid);
      if (blockedFeed) {
        const age = blockedFeed.ageMs == null ? "n/a" : `${Math.round(blockedFeed.ageMs)}ms`;
        const reason = `stale/missing feed: ${blockedFeed.key} (age=${age}, max=${blockedFeed.maxAgeMs}ms, source=${blockedFeed.source})`;
        return {
          ...base,
          status: "blocked",
          detail: reason,
          reason,
        };
      }
    }

    if (row.status === "fail" && isGenericMissing(row.detail)) {
      const reason = row.reason ?? "Threshold failed with fresh data.";
      return {
        ...base,
        status: "fail",
        detail: reason,
        reason,
      };
    }

    return {
      ...base,
      reason: row.reason ?? row.detail ?? (row.status === "pass" ? "Criteria met." : "Criteria failed."),
    };
  });
}
