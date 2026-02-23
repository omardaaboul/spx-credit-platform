import type { CandidateCard, DashboardPayload, OpenTrade, OptionLeg } from "@/lib/spx0dte";

export type MmcEvent = {
  dteBucket: number;
  triggeredAtMs: number;
};

export type PollingOpenTrade = {
  id?: string;
  strategy?: string;
  status?: string;
  shortStrike?: number | null;
  spot?: number | null;
  dte?: number | null;
  ivPct?: number | null;
  em1sd?: number | null;
  currentDebit?: number | null;
  initialCredit?: number | null;
  plPct?: number | null;
  legs?: OptionLeg[];
};

export type PollingCandidate = {
  strategy?: string;
  ready?: boolean;
  legs?: OptionLeg[];
};

export type PollingStateInput = {
  openTrades: PollingOpenTrade[];
  candidates: PollingCandidate[];
  mmcEvents?: MmcEvent[];
  volRegime?: "VOL_SUPPRESSED" | "VOL_NORMAL" | "VOL_EXPANDING" | "VOL_EXTREME" | "UNKNOWN";
  shockFlag?: boolean;
  nowMs?: number;
};

export type PollingMarketSnapshot = {
  spot?: number | null;
  ivPctByDte?: Record<number, number>;
  debitByTradeId?: Record<string, number>;
};

const BASELINE_BY_DTE: Record<number, number> = {
  45: 60,
  30: 60,
  14: 30,
  7: 15,
  2: 10,
};

const MMC_WINDOW_MS = 20 * 60 * 1000;

function normalizeIvPct(ivRaw: number | null | undefined): number | null {
  if (ivRaw == null || !Number.isFinite(ivRaw) || ivRaw <= 0) return null;
  // allow decimal input (0.18) and percent input (18)
  return ivRaw <= 3 ? ivRaw * 100 : ivRaw;
}

export function parseDteFromStrategy(strategy: string | undefined): number | null {
  if (!strategy) return null;
  const match = strategy.match(/(\d+)-DTE/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function nearestDteBucket(dte: number): number {
  const buckets = [2, 7, 14, 30, 45];
  return buckets.reduce((best, cur) => (Math.abs(cur - dte) < Math.abs(best - dte) ? cur : best), buckets[0]);
}

function baselineForDte(dte: number | null): number {
  if (dte == null || !Number.isFinite(dte)) return 60;
  return BASELINE_BY_DTE[nearestDteBucket(dte)] ?? 60;
}

function extractShortStrike(trade: PollingOpenTrade): number | null {
  if (trade.shortStrike != null && Number.isFinite(trade.shortStrike)) return Number(trade.shortStrike);
  const short = trade.legs?.find((leg) => leg.action === "SELL");
  return short?.strike != null && Number.isFinite(short.strike) ? short.strike : null;
}

function computeDangerRatio(trade: PollingOpenTrade): number | null {
  const dte = trade.dte ?? parseDteFromStrategy(trade.strategy);
  const spot = trade.spot;
  const shortStrike = extractShortStrike(trade);
  if (dte == null || spot == null || shortStrike == null || !Number.isFinite(spot) || !Number.isFinite(shortStrike)) return null;

  let em1sd = trade.em1sd;
  if (em1sd == null || !Number.isFinite(em1sd) || em1sd <= 0) {
    const ivPct = normalizeIvPct(trade.ivPct);
    if (ivPct == null) return null;
    em1sd = spot * (ivPct / 100) * Math.sqrt(Math.max(1, dte) / 365);
  }
  if (!Number.isFinite(em1sd) || em1sd <= 0) return null;
  const distToShort = Math.abs(spot - shortStrike);
  return distToShort / em1sd;
}

export function computePollingInterval(input: PollingStateInput): number {
  const now = input.nowMs ?? Date.now();
  const openTrades = (input.openTrades ?? []).filter((t) => String(t.status ?? "OPEN").toUpperCase() === "OPEN");
  const candidates = input.candidates ?? [];

  if (openTrades.length === 0 && candidates.length === 0) return 120; // quiet mode

  const dtes = [
    ...openTrades
      .map((t) => (t.dte ?? parseDteFromStrategy(t.strategy)))
      .filter((d): d is number => d != null && Number.isFinite(d)),
    ...candidates
      .map((c) => parseDteFromStrategy(c.strategy))
      .filter((d): d is number => d != null && Number.isFinite(d)),
  ];

  let interval = dtes.length > 0 ? Math.min(...dtes.map((d) => baselineForDte(d))) : 60;

  // A/B open trade escalation
  if (openTrades.some((t) => {
    const dte = t.dte ?? parseDteFromStrategy(t.strategy);
    return dte != null && dte <= 7;
  })) {
    interval = Math.min(interval, 15);
  }

  if (openTrades.some((t) => {
    const dte = t.dte ?? parseDteFromStrategy(t.strategy);
    return dte != null && dte <= 2;
  })) {
    interval = Math.min(interval, 10);
  }

  // C near-risk escalation
  for (const trade of openTrades) {
    const ratio = computeDangerRatio(trade);
    if (ratio == null) continue;
    if (ratio <= 0.5) interval = Math.min(interval, 5);
    else if (ratio <= 0.75) interval = Math.min(interval, 10);
    else if (ratio <= 1.0) interval = Math.min(interval, 15);
  }

  // D MMC trigger boost
  if ((input.mmcEvents ?? []).some((evt) => now - evt.triggeredAtMs <= MMC_WINDOW_MS)) {
    interval = Math.min(interval, 15);
  }

  // Optional volatility-aware cadence
  if (input.shockFlag) {
    interval = Math.min(interval, 10);
  } else if (input.volRegime === "VOL_EXPANDING" || input.volRegime === "VOL_EXTREME") {
    interval = Math.min(interval, 15);
  } else if (
    input.volRegime === "VOL_SUPPRESSED" &&
    openTrades.length === 0 &&
    dtes.length > 0 &&
    dtes.every((d) => d >= 14)
  ) {
    interval = Math.max(interval, 45);
  }

  return Math.max(5, Math.round(interval));
}

export function getSymbolsToPoll(state: { openTrades?: PollingOpenTrade[]; candidates?: PollingCandidate[] }): string[] {
  const symbols = new Set<string>();
  for (const trade of state.openTrades ?? []) {
    for (const leg of trade.legs ?? []) {
      if (leg.symbol) symbols.add(leg.symbol);
    }
  }
  for (const candidate of state.candidates ?? []) {
    for (const leg of candidate.legs ?? []) {
      if (leg.symbol) symbols.add(leg.symbol);
    }
  }
  return Array.from(symbols);
}

export function updatePnL(openTrades: PollingOpenTrade[], marketSnapshot: PollingMarketSnapshot): PollingOpenTrade[] {
  return openTrades.map((trade) => {
    const tradeId = String(trade.id ?? "");
    const markFromSnapshot = tradeId ? marketSnapshot.debitByTradeId?.[tradeId] : undefined;
    const currentDebit = Number.isFinite(markFromSnapshot) ? Number(markFromSnapshot) : trade.currentDebit ?? null;
    const initialCredit = trade.initialCredit ?? null;
    if (currentDebit == null || initialCredit == null || !Number.isFinite(currentDebit) || !Number.isFinite(initialCredit) || initialCredit === 0) {
      return trade;
    }
    const plPct = ((initialCredit - currentDebit) / initialCredit) * 100;
    return { ...trade, currentDebit, plPct };
  });
}

export async function runPollingCycle(params: {
  fetchSnapshot: () => Promise<{ openTrades: PollingOpenTrade[]; candidates: PollingCandidate[]; marketSnapshot?: PollingMarketSnapshot }>;
  mmcEvents?: MmcEvent[];
  nowMs?: number;
}): Promise<{
  intervalSec: number;
  symbols: string[];
  openTrades: PollingOpenTrade[];
  candidates: PollingCandidate[];
}> {
  const snapshot = await params.fetchSnapshot();
  const symbols = getSymbolsToPoll(snapshot);
  const updatedTrades = updatePnL(snapshot.openTrades, snapshot.marketSnapshot ?? {});
  const intervalSec = computePollingInterval({
    openTrades: updatedTrades,
    candidates: snapshot.candidates,
    mmcEvents: params.mmcEvents ?? [],
    nowMs: params.nowMs,
  });
  return {
    intervalSec,
    symbols,
    openTrades: updatedTrades,
    candidates: snapshot.candidates,
  };
}

function mmcRowPassed(candidate: CandidateCard): boolean {
  return (candidate.checklist?.strategy ?? []).some(
    (row) => /measured move near completion/i.test(row.name) && row.status === "pass",
  );
}

export function mergeMmcEvents(params: {
  previousEvents: MmcEvent[];
  previousCandidates: CandidateCard[];
  currentCandidates: CandidateCard[];
  nowMs?: number;
}): MmcEvent[] {
  const now = params.nowMs ?? Date.now();
  const prevByStrategy = new Map(params.previousCandidates.map((c) => [c.strategy, mmcRowPassed(c)]));
  const nextEvents = [...params.previousEvents];

  for (const candidate of params.currentCandidates) {
    const nowPass = mmcRowPassed(candidate);
    const prevPass = prevByStrategy.get(candidate.strategy) ?? false;
    if (!prevPass && nowPass) {
      const dte = parseDteFromStrategy(candidate.strategy);
      nextEvents.push({ dteBucket: dte ?? 0, triggeredAtMs: now });
    }
  }

  return nextEvents.filter((evt) => now - evt.triggeredAtMs <= MMC_WINDOW_MS);
}

export function toPollingState(payload: DashboardPayload): PollingStateInput {
  const spot = Number.isFinite(payload.metrics?.spx) ? payload.metrics.spx : null;
  const ivRaw = Number.isFinite(payload.metrics?.iv) ? payload.metrics.iv : null;
  const ivPct = normalizeIvPct(ivRaw);
  const openTrades: PollingOpenTrade[] = (payload.openTrades ?? []).map((trade: OpenTrade) => ({
    id: trade.id,
    strategy: trade.strategy,
    status: trade.status,
    shortStrike: trade.legs.find((leg) => leg.action === "SELL")?.strike ?? null,
    spot,
    dte: parseDteFromStrategy(trade.strategy),
    ivPct,
    currentDebit: trade.currentDebit,
    initialCredit: trade.initialCredit,
    plPct: trade.plPct,
    legs: trade.legs,
  }));
  const candidates: PollingCandidate[] = (payload.candidates ?? []).map((candidate) => ({
    strategy: candidate.strategy,
    ready: candidate.ready,
    legs: candidate.legs,
  }));
  return {
    openTrades,
    candidates,
    volRegime: payload.decision?.vol?.regime,
    shockFlag: payload.decision?.vol?.shock?.shockFlag ?? false,
  };
}
