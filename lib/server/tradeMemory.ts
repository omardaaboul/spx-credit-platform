import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DashboardPayload } from "@/lib/spx0dte";

export type CandidateStatus = "GENERATED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "INVALIDATED";
export type UserDecision = "TAKEN" | "SKIPPED" | "WATCHLIST" | null;
export type SpreadDirection = "BULL_PUT" | "BEAR_CALL";
export type TradeStatus = "OPEN" | "CLOSED" | "EXPIRED";
export type TradeEventType =
  | "CANDIDATE_CREATED"
  | "ALERT_SENT"
  | "TRADE_TAKEN"
  | "TRADE_SKIPPED"
  | "POSITION_OPENED"
  | "POSITION_MARKED"
  | "POSITION_CLOSED";

export type TradeEventRecord = {
  event_id: string;
  ts: string;
  type: TradeEventType;
  candidate_id?: string | null;
  trade_id?: string | null;
  strategy?: string | null;
  dte_bucket?: number | null;
  payload?: Record<string, unknown>;
};

export type TradeCandidateRecord = {
  candidate_id: string;
  created_at: string;
  updated_at: string;
  dte_bucket: number;
  direction: SpreadDirection;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  quoted_credit: number;
  mid_price_at_signal: number;
  spot_at_signal: number;
  atm_iv_at_signal: number;
  em_1sd_at_signal: number;
  zscore_at_signal: number;
  mmc_stretch_at_signal: number;
  indicator_snapshot: Record<string, number | string | null>;
  status: CandidateStatus;
  user_decision: UserDecision;
  notes: string | null;
};

export type TradeExecutionRecord = {
  trade_id: string;
  candidate_id: string;
  strategy: string;
  direction: SpreadDirection;
  dte_bucket: number;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  opened_at: string;
  filled_credit: number;
  quantity: number;
  fees_estimate: number;
  status: TradeStatus;
  close_price: number | null;
  closed_at: string | null;
  realized_pnl: number | null;
  max_profit: number;
  max_loss: number;
  break_even: number;
  current_mark: number | null;
  unrealized_pnl: number | null;
  pnl_percent_of_risk: number | null;
  last_updated_at: string;
};

type CandidateFilters = {
  dte?: number;
  status?: CandidateStatus;
  decision?: Exclude<UserDecision, null>;
  limit?: number;
};

type TradeFilters = {
  status?: TradeStatus;
  limit?: number;
};

type AcceptTradeInput = {
  candidate_id: string;
  quantity?: number;
  filled_credit?: number;
  fees_estimate?: number;
  notes?: string | null;
};

type RejectCandidateInput = {
  candidate_id: string;
  decision: "SKIPPED" | "WATCHLIST";
  notes?: string | null;
};

type CloseTradeInput = {
  trade_id: string;
  close_price?: number;
  notes?: string | null;
};

type TradeMutationResult<T> = {
  ok: boolean;
  message: string;
  row?: T;
};

const STORAGE_DIR = path.join(process.cwd(), "storage");

function candidatesPath(): string {
  return process.env.SPX0DTE_CANDIDATE_STORE_PATH || path.join(STORAGE_DIR, ".trade_candidates.json");
}

function tradesPath(): string {
  return process.env.SPX0DTE_TRADE_STORE_PATH || path.join(STORAGE_DIR, ".trade_executions.json");
}

function eventsPath(): string {
  return process.env.SPX0DTE_TRADE_EVENT_LOG_PATH || path.join(STORAGE_DIR, "trade_events.jsonl");
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseIsoDate(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonArray<T>(filePath: string): T[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    return Array.isArray(raw) ? (raw as T[]) : [];
  } catch {
    return [];
  }
}

function writeJsonArray<T>(filePath: string, rows: T[]): void {
  ensureDir(filePath);
  writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

function appendTradeEvent(
  type: TradeEventType,
  fields: Omit<TradeEventRecord, "event_id" | "ts" | "type"> = {},
): TradeEventRecord {
  const row: TradeEventRecord = {
    event_id: `evt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
    ts: nowIso(),
    type,
    ...fields,
  };
  try {
    const filePath = eventsPath();
    ensureDir(filePath);
    appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // Non-fatal: event log should never break trading state persistence.
  }
  return row;
}

export function loadTradeCandidates(): TradeCandidateRecord[] {
  return readJsonArray<TradeCandidateRecord>(candidatesPath());
}

export function saveTradeCandidates(rows: TradeCandidateRecord[]): void {
  writeJsonArray(candidatesPath(), rows);
}

export function loadTradeExecutions(): TradeExecutionRecord[] {
  return readJsonArray<TradeExecutionRecord>(tradesPath());
}

export function saveTradeExecutions(rows: TradeExecutionRecord[]): void {
  writeJsonArray(tradesPath(), rows);
}

function normalizeDteBucket(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function inferDirection(typeRaw: unknown, rightRaw: unknown): SpreadDirection | null {
  const type = String(typeRaw ?? "").toUpperCase();
  if (type.includes("BULL") && type.includes("PUT")) return "BULL_PUT";
  if (type.includes("BEAR") && type.includes("CALL")) return "BEAR_CALL";
  const right = String(rightRaw ?? "").toUpperCase();
  if (right === "PUT" || right === "P") return "BULL_PUT";
  if (right === "CALL" || right === "C") return "BEAR_CALL";
  return null;
}

export function buildCandidateId(input: {
  dte_bucket: number;
  direction: SpreadDirection;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
}): string {
  const raw = [
    String(Math.round(input.dte_bucket)),
    input.direction,
    input.expiration,
    String(Math.round(input.short_strike * 100) / 100),
    String(Math.round(input.long_strike * 100) / 100),
    String(Math.round(input.width)),
  ].join("|");
  return `cand_${createHash("sha1").update(raw).digest("hex").slice(0, 16)}`;
}

function candidateFromTarget(
  payload: DashboardPayload,
  target: NonNullable<DashboardPayload["multiDte"]>["targets"][number],
  now: string,
): TradeCandidateRecord | null {
  const recommendation = (target.recommendation ?? null) as Record<string, unknown> | null;
  if (!recommendation) return null;

  const expiration = parseIsoDate(recommendation.expiry ?? target.expiration);
  const shortStrike = num(recommendation.short_strike);
  const longStrike = num(recommendation.long_strike);
  const width = num(recommendation.width);
  const credit = num(recommendation.credit);
  const direction = inferDirection(recommendation.type, recommendation.right);
  const dteBucket = normalizeDteBucket(target.target_dte);
  if (!expiration || shortStrike == null || longStrike == null || width == null || credit == null || !direction || dteBucket <= 0) {
    return null;
  }

  const metrics = (target.metrics ?? {}) as Record<string, unknown>;
  const spot = num(payload.metrics?.spx) ?? 0;
  const atmIv = num(recommendation.iv_atm ?? metrics.iv_atm ?? metrics.iv) ?? 0;
  const em1sd = num(recommendation.em_1sd ?? metrics.em_1sd) ?? 0;
  const zScore = num(metrics.zscore) ?? 0;
  const mmcStretch = num(metrics.measuredMoveCompletion ?? metrics.measured_ratio) ?? 0;

  const candidateIdRaw = String(recommendation.candidate_id ?? "").trim();
  const candidateId = candidateIdRaw || buildCandidateId({
    dte_bucket: dteBucket,
    direction,
    expiration,
    short_strike: shortStrike,
    long_strike: longStrike,
    width,
  });

  return {
    candidate_id: candidateId,
    created_at: now,
    updated_at: now,
    dte_bucket: dteBucket,
    direction,
    expiration,
    short_strike: shortStrike,
    long_strike: longStrike,
    width,
    quoted_credit: credit,
    mid_price_at_signal: credit,
    spot_at_signal: spot,
    atm_iv_at_signal: atmIv,
    em_1sd_at_signal: em1sd,
    zscore_at_signal: zScore,
    mmc_stretch_at_signal: mmcStretch,
    indicator_snapshot: {
      ema8: num(metrics.ema8),
      ema20: num(metrics.ema20),
      ema21: num(metrics.ema21),
      ema21_slope: num(metrics.ema21_slope),
      macd_hist: num(metrics.macd_hist),
      macd_hist_prev: num(metrics.macd_hist_prev),
      zscore: zScore,
      support: num(metrics.support),
      resistance: num(metrics.resistance),
      measuredMoveDetail: typeof metrics.measuredMoveDetail === "string" ? metrics.measuredMoveDetail : null,
      configProfile: typeof metrics.configProfile === "string" ? metrics.configProfile : null,
    },
    status: "GENERATED",
    user_decision: null,
    notes: null,
  };
}

export function upsertCandidatesFromDashboard(payload: DashboardPayload, now: string = nowIso()): {
  inserted: number;
  updated: number;
  invalidated: number;
  expired: number;
  activeIds: string[];
} {
  const existing = loadTradeCandidates();
  const targets = payload.multiDte?.targets ?? [];
  const incoming = targets
    .map((target) => candidateFromTarget(payload, target, now))
    .filter((row): row is TradeCandidateRecord => row !== null);

  const byId = new Map(existing.map((row) => [row.candidate_id, row]));
  let inserted = 0;
  let updated = 0;
  const activeIds = new Set<string>();

  for (const row of incoming) {
    activeIds.add(row.candidate_id);
    const current = byId.get(row.candidate_id);
    if (!current) {
      byId.set(row.candidate_id, row);
      appendTradeEvent("CANDIDATE_CREATED", {
        candidate_id: row.candidate_id,
        strategy: `${row.dte_bucket}-DTE Credit Spread`,
        dte_bucket: row.dte_bucket,
        payload: {
          direction: row.direction,
          expiration: row.expiration,
          short_strike: row.short_strike,
          long_strike: row.long_strike,
          width: row.width,
          credit: row.quoted_credit,
        },
      });
      inserted += 1;
      continue;
    }
    const keepTerminal = current.status === "ACCEPTED" || current.status === "REJECTED";
    byId.set(row.candidate_id, {
      ...current,
      ...row,
      created_at: current.created_at || row.created_at,
      status: keepTerminal ? current.status : "GENERATED",
      user_decision: keepTerminal ? current.user_decision : current.user_decision,
      notes: current.notes ?? row.notes,
      updated_at: now,
    });
    updated += 1;
  }

  const today = now.slice(0, 10);
  let invalidated = 0;
  let expired = 0;
  for (const row of byId.values()) {
    if (row.expiration < today && row.status !== "EXPIRED") {
      row.status = "EXPIRED";
      row.updated_at = now;
      expired += 1;
      continue;
    }
    if (row.status === "GENERATED" && !activeIds.has(row.candidate_id)) {
      row.status = "INVALIDATED";
      row.updated_at = now;
      invalidated += 1;
    }
  }

  const next = Array.from(byId.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  saveTradeCandidates(next);
  return { inserted, updated, invalidated, expired, activeIds: Array.from(activeIds) };
}

export function listCandidates(filters: CandidateFilters = {}): TradeCandidateRecord[] {
  let rows = loadTradeCandidates();
  if (filters.dte != null) rows = rows.filter((row) => row.dte_bucket === filters.dte);
  if (filters.status) rows = rows.filter((row) => row.status === filters.status);
  if (filters.decision) rows = rows.filter((row) => row.user_decision === filters.decision);
  const limit = Number.isFinite(filters.limit) ? Math.max(1, Number(filters.limit)) : 500;
  return rows.slice(0, limit);
}

export function listTrades(filters: TradeFilters = {}): TradeExecutionRecord[] {
  let rows = loadTradeExecutions();
  if (filters.status) rows = rows.filter((row) => row.status === filters.status);
  const limit = Number.isFinite(filters.limit) ? Math.max(1, Number(filters.limit)) : 500;
  return rows.slice(0, limit);
}

export function listTradeEvents(limit = 1_000, type?: TradeEventType): TradeEventRecord[] {
  try {
    const filePath = eventsPath();
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TradeEventRecord);
    const rows = type ? raw.filter((row) => row.type === type) : raw;
    return rows.slice(-Math.max(1, Math.min(limit, 10_000))).reverse();
  } catch {
    return [];
  }
}

export function recordAlertSentEvent(input: {
  strategy?: string | null;
  candidate_id?: string | null;
  dte_bucket?: number | null;
  alert_id?: string | null;
  reason?: string | null;
}): TradeEventRecord {
  return appendTradeEvent("ALERT_SENT", {
    strategy: input.strategy ?? null,
    candidate_id: input.candidate_id ?? null,
    dte_bucket: input.dte_bucket ?? null,
    payload: {
      alert_id: input.alert_id ?? null,
      reason: input.reason ?? null,
    },
  });
}

export function candidatesByDay(strategy?: string, dteBucket?: number): Array<{
  day: string;
  total: number;
  generated: number;
  accepted: number;
  rejected: number;
  invalidated: number;
  expired: number;
}> {
  const rows = loadTradeCandidates().filter((row) => {
    if (strategy && `${row.dte_bucket}-DTE Credit Spread` !== strategy) return false;
    if (dteBucket != null && row.dte_bucket !== dteBucket) return false;
    return true;
  });
  const byDay = new Map<string, { day: string; total: number; generated: number; accepted: number; rejected: number; invalidated: number; expired: number }>();
  for (const row of rows) {
    const day = String(row.created_at).slice(0, 10);
    const agg =
      byDay.get(day) ??
      { day, total: 0, generated: 0, accepted: 0, rejected: 0, invalidated: 0, expired: 0 };
    agg.total += 1;
    if (row.status === "GENERATED") agg.generated += 1;
    if (row.status === "ACCEPTED") agg.accepted += 1;
    if (row.status === "REJECTED") agg.rejected += 1;
    if (row.status === "INVALIDATED") agg.invalidated += 1;
    if (row.status === "EXPIRED") agg.expired += 1;
    byDay.set(day, agg);
  }
  return Array.from(byDay.values()).sort((a, b) => b.day.localeCompare(a.day));
}

export function openPositions(): TradeExecutionRecord[] {
  return listTrades({ status: "OPEN", limit: 5_000 });
}

export function pnlByCandidate(): Array<{
  candidate_id: string;
  strategy: string;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  trades: number;
}> {
  const rows = loadTradeExecutions();
  const byId = new Map<string, { candidate_id: string; strategy: string; total_realized_pnl: number; total_unrealized_pnl: number; trades: number }>();
  for (const row of rows) {
    const agg =
      byId.get(row.candidate_id) ??
      { candidate_id: row.candidate_id, strategy: row.strategy, total_realized_pnl: 0, total_unrealized_pnl: 0, trades: 0 };
    agg.trades += 1;
    agg.total_realized_pnl += Number(row.realized_pnl ?? 0);
    agg.total_unrealized_pnl += Number(row.unrealized_pnl ?? 0);
    byId.set(row.candidate_id, agg);
  }
  return Array.from(byId.values()).sort((a, b) => b.total_realized_pnl - a.total_realized_pnl);
}

export function pnlByStrategy(): Array<{
  strategy: string;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  trades: number;
}> {
  const rows = loadTradeExecutions();
  const byStrategy = new Map<string, { strategy: string; total_realized_pnl: number; total_unrealized_pnl: number; trades: number }>();
  for (const row of rows) {
    const agg =
      byStrategy.get(row.strategy) ??
      { strategy: row.strategy, total_realized_pnl: 0, total_unrealized_pnl: 0, trades: 0 };
    agg.trades += 1;
    agg.total_realized_pnl += Number(row.realized_pnl ?? 0);
    agg.total_unrealized_pnl += Number(row.unrealized_pnl ?? 0);
    byStrategy.set(row.strategy, agg);
  }
  return Array.from(byStrategy.values()).sort((a, b) => b.total_realized_pnl - a.total_realized_pnl);
}

export function acceptCandidateAsTrade(input: AcceptTradeInput): TradeMutationResult<TradeExecutionRecord> {
  const now = nowIso();
  const candidates = loadTradeCandidates();
  const trades = loadTradeExecutions();
  const candidate = candidates.find((row) => row.candidate_id === input.candidate_id);
  if (!candidate) return { ok: false, message: "Candidate not found." };

  const openExisting = trades.find((row) => row.candidate_id === candidate.candidate_id && row.status === "OPEN");
  if (openExisting) return { ok: false, message: "Trade already open for candidate.", row: openExisting };

  const qty = Math.max(1, Math.round(Number(input.quantity ?? 1)));
  const filledCredit = Number.isFinite(Number(input.filled_credit)) ? Number(input.filled_credit) : candidate.quoted_credit;
  const fees = Math.max(0, Number(input.fees_estimate ?? 0));

  const maxProfit = filledCredit * 100 * qty;
  const maxLoss = Math.max(0, (candidate.width - filledCredit) * 100 * qty);
  const breakEven =
    candidate.direction === "BULL_PUT"
      ? candidate.short_strike - filledCredit
      : candidate.short_strike + filledCredit;

  const trade: TradeExecutionRecord = {
    trade_id: `trd_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    candidate_id: candidate.candidate_id,
    strategy: `${candidate.dte_bucket}-DTE Credit Spread`,
    direction: candidate.direction,
    dte_bucket: candidate.dte_bucket,
    expiration: candidate.expiration,
    short_strike: candidate.short_strike,
    long_strike: candidate.long_strike,
    width: candidate.width,
    opened_at: now,
    filled_credit: filledCredit,
    quantity: qty,
    fees_estimate: fees,
    status: "OPEN",
    close_price: null,
    closed_at: null,
    realized_pnl: null,
    max_profit: maxProfit,
    max_loss: maxLoss,
    break_even: breakEven,
    current_mark: filledCredit,
    unrealized_pnl: -fees,
    pnl_percent_of_risk: maxLoss > 0 ? (-fees / maxLoss) * 100 : 0,
    last_updated_at: now,
  };

  trades.unshift(trade);
  saveTradeExecutions(trades.slice(0, 2_000));
  appendTradeEvent("TRADE_TAKEN", {
    candidate_id: candidate.candidate_id,
    trade_id: trade.trade_id,
    strategy: trade.strategy,
    dte_bucket: trade.dte_bucket,
    payload: {
      quantity: trade.quantity,
      filled_credit: trade.filled_credit,
      fees_estimate: trade.fees_estimate,
    },
  });
  appendTradeEvent("POSITION_OPENED", {
    candidate_id: candidate.candidate_id,
    trade_id: trade.trade_id,
    strategy: trade.strategy,
    dte_bucket: trade.dte_bucket,
    payload: {
      max_profit: trade.max_profit,
      max_loss: trade.max_loss,
      break_even: trade.break_even,
    },
  });

  const candidateIndex = candidates.findIndex((row) => row.candidate_id === candidate.candidate_id);
  if (candidateIndex >= 0) {
    candidates[candidateIndex] = {
      ...candidates[candidateIndex],
      status: "ACCEPTED",
      user_decision: "TAKEN",
      notes: input.notes ?? candidates[candidateIndex].notes,
      updated_at: now,
    };
    saveTradeCandidates(candidates);
  }

  return { ok: true, message: "Trade accepted.", row: trade };
}

export function rejectCandidate(input: RejectCandidateInput): TradeMutationResult<TradeCandidateRecord> {
  const now = nowIso();
  const candidates = loadTradeCandidates();
  const index = candidates.findIndex((row) => row.candidate_id === input.candidate_id);
  if (index < 0) return { ok: false, message: "Candidate not found." };
  const current = candidates[index];
  const nextStatus: CandidateStatus = input.decision === "WATCHLIST" ? "GENERATED" : "REJECTED";
  const next: TradeCandidateRecord = {
    ...current,
    status: nextStatus,
    user_decision: input.decision,
    notes: input.notes ?? current.notes,
    updated_at: now,
  };
  candidates[index] = next;
  saveTradeCandidates(candidates);
  appendTradeEvent("TRADE_SKIPPED", {
    candidate_id: current.candidate_id,
    strategy: `${current.dte_bucket}-DTE Credit Spread`,
    dte_bucket: current.dte_bucket,
    payload: {
      decision: input.decision,
      notes: input.notes ?? null,
    },
  });
  return { ok: true, message: "Candidate updated.", row: next };
}

export function closeTrade(input: CloseTradeInput): TradeMutationResult<TradeExecutionRecord> {
  const now = nowIso();
  const trades = loadTradeExecutions();
  const index = trades.findIndex((row) => row.trade_id === input.trade_id);
  if (index < 0) return { ok: false, message: "Trade not found." };
  const current = trades[index];
  if (current.status !== "OPEN") return { ok: false, message: "Trade is not open.", row: current };

  const closePx = Number.isFinite(Number(input.close_price))
    ? Math.max(0, Number(input.close_price))
    : Number.isFinite(Number(current.current_mark))
      ? Number(current.current_mark)
      : current.filled_credit;
  const realized = (current.filled_credit - closePx) * 100 * current.quantity - current.fees_estimate;
  const next: TradeExecutionRecord = {
    ...current,
    status: "CLOSED",
    close_price: closePx,
    closed_at: now,
    realized_pnl: realized,
    current_mark: closePx,
    unrealized_pnl: null,
    pnl_percent_of_risk: current.max_loss > 0 ? (realized / current.max_loss) * 100 : null,
    last_updated_at: now,
  };
  trades[index] = next;
  saveTradeExecutions(trades);
  appendTradeEvent("POSITION_CLOSED", {
    candidate_id: current.candidate_id,
    trade_id: current.trade_id,
    strategy: current.strategy,
    dte_bucket: current.dte_bucket,
    payload: {
      close_price: closePx,
      realized_pnl: realized,
    },
  });

  const candidates = loadTradeCandidates();
  const cIdx = candidates.findIndex((row) => row.candidate_id === current.candidate_id);
  if (cIdx >= 0) {
    candidates[cIdx] = {
      ...candidates[cIdx],
      status: realized >= 0 ? "EXPIRED" : candidates[cIdx].status,
      notes: input.notes ?? candidates[cIdx].notes,
      updated_at: now,
    };
    saveTradeCandidates(candidates);
  }
  return { ok: true, message: "Trade closed.", row: next };
}

function sameSpread(
  direction: SpreadDirection,
  expiry: string,
  shortStrike: number,
  longStrike: number,
  recommendation: Record<string, unknown> | null,
): boolean {
  if (!recommendation) return false;
  const recExpiry = parseIsoDate(recommendation.expiry);
  const recShort = num(recommendation.short_strike);
  const recLong = num(recommendation.long_strike);
  const recDirection = inferDirection(recommendation.type, recommendation.right);
  if (!recExpiry || recShort == null || recLong == null || !recDirection) return false;
  return (
    recDirection === direction &&
    recExpiry === expiry &&
    Math.abs(recShort - shortStrike) < 0.001 &&
    Math.abs(recLong - longStrike) < 0.001
  );
}

export function updateOpenTradeMarksFromDashboard(payload: DashboardPayload): { updated: number } {
  const trades = loadTradeExecutions();
  const openIndexes = trades
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.status === "OPEN");
  if (openIndexes.length === 0) return { updated: 0 };

  const now = nowIso();
  let updated = 0;
  for (const { row, idx } of openIndexes) {
    let currentMark: number | null = null;

    for (const target of payload.multiDte?.targets ?? []) {
      const rec = (target.recommendation ?? null) as Record<string, unknown> | null;
      if (!sameSpread(row.direction, row.expiration, row.short_strike, row.long_strike, rec)) continue;
      currentMark = num(rec?.credit);
      break;
    }

    if (currentMark == null && row.dte_bucket === 2) {
      const rec = (payload.twoDte?.recommendation ?? null) as Record<string, unknown> | null;
      if (sameSpread(row.direction, row.expiration, row.short_strike, row.long_strike, rec)) {
        currentMark = num(rec?.credit);
      }
    }

    if (currentMark == null) continue;

    const unrealized = (row.filled_credit - currentMark) * 100 * row.quantity - row.fees_estimate;
    trades[idx] = {
      ...row,
      current_mark: currentMark,
      unrealized_pnl: unrealized,
      pnl_percent_of_risk: row.max_loss > 0 ? (unrealized / row.max_loss) * 100 : null,
      last_updated_at: now,
    };
    appendTradeEvent("POSITION_MARKED", {
      candidate_id: row.candidate_id,
      trade_id: row.trade_id,
      strategy: row.strategy,
      dte_bucket: row.dte_bucket,
      payload: {
        current_mark: currentMark,
        unrealized_pnl: unrealized,
        pnl_percent_of_risk: row.max_loss > 0 ? (unrealized / row.max_loss) * 100 : null,
      },
    });
    updated += 1;
  }

  if (updated > 0) saveTradeExecutions(trades);
  return { updated };
}

export function upsertCandidates(records: TradeCandidateRecord[]): { inserted: number; updated: number } {
  const now = nowIso();
  const existing = loadTradeCandidates();
  const byId = new Map(existing.map((row) => [row.candidate_id, row]));
  let inserted = 0;
  let updated = 0;
  for (const rec of records) {
    const clean: TradeCandidateRecord = {
      ...rec,
      created_at: rec.created_at || now,
      updated_at: now,
    };
    if (byId.has(clean.candidate_id)) {
      byId.set(clean.candidate_id, { ...byId.get(clean.candidate_id)!, ...clean, updated_at: now });
      updated += 1;
    } else {
      byId.set(clean.candidate_id, clean);
      appendTradeEvent("CANDIDATE_CREATED", {
        candidate_id: clean.candidate_id,
        strategy: `${clean.dte_bucket}-DTE Credit Spread`,
        dte_bucket: clean.dte_bucket,
        payload: {
          direction: clean.direction,
          expiration: clean.expiration,
          short_strike: clean.short_strike,
          long_strike: clean.long_strike,
          width: clean.width,
          credit: clean.quoted_credit,
        },
      });
      inserted += 1;
    }
  }
  saveTradeCandidates(Array.from(byId.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
  return { inserted, updated };
}
