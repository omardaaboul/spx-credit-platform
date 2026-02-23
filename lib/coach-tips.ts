import type { CoachEmotionalState, CoachExitReason, CoachPlanStatus } from "@/lib/coach-store";

export type CoachTrade = {
  setupId?: string | null;
  status?: CoachPlanStatus | string | null;
  pnlAmount?: number | null;
  followedPlan?: boolean | null;
  emotionalState?: CoachEmotionalState | string | null;
  exitReason?: CoachExitReason | string | null;
  notes?: string | null;
  enteredAt?: Date | string | null;
  plannedEntryDate?: Date | string | null;
  maxRiskPercent?: number | null;
};

export type CoachRules = {
  riskPerTradePercentDefault: number;
  maxTradesPerDay: number;
  maxDailyLossPercent?: number;
};

export type CoachTip = {
  title: string;
  rationale: string;
  metricTrigger: string;
  action: string;
};

type GenerateOptions = {
  sampleSize?: number;
  maxTips?: number;
};

const EMOTIONAL_FLAGS = new Set(["fomo", "revenge", "angry"]);

function toDate(value?: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function tradeDate(trade: CoachTrade) {
  return toDate(trade.enteredAt) ?? toDate(trade.plannedEntryDate);
}

function money(value: number) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number) {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value.toFixed(2)}%`;
}

function toDayKey(value?: Date | string | null) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

function normalizeNote(value?: string | null) {
  return (value ?? "").toLowerCase();
}

export function generateCoachTips(
  trades: CoachTrade[],
  rules: CoachRules,
  options: GenerateOptions = {},
) {
  const sampleSize = options.sampleSize ?? 20;
  const maxTips = options.maxTips ?? 7;
  const riskDefault = Number.isFinite(rules.riskPerTradePercentDefault) ? rules.riskPerTradePercentDefault : 1;
  const maxTradesPerDay = Math.max(1, Math.round(rules.maxTradesPerDay || 1));

  const recentTrades = [...trades]
    .sort((a, b) => {
      const timeA = tradeDate(a)?.getTime() ?? 0;
      const timeB = tradeDate(b)?.getTime() ?? 0;
      return timeB - timeA;
    })
    .slice(0, sampleSize);

  if (!recentTrades.length) return [];

  const closedTrades = recentTrades.filter(
    (trade) => trade.status === "closed" && typeof trade.pnlAmount === "number",
  );

  const wins = closedTrades.filter((trade) => (trade.pnlAmount ?? 0) > 0);
  const losses = closedTrades.filter((trade) => (trade.pnlAmount ?? 0) < 0);
  const winRate = closedTrades.length ? (wins.length / closedTrades.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((sum, trade) => sum + (trade.pnlAmount ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length
    ? Math.abs(losses.reduce((sum, trade) => sum + (trade.pnlAmount ?? 0), 0) / losses.length)
    : 0;

  const adherenceTrades = closedTrades.filter((trade) => typeof trade.followedPlan === "boolean");
  const adherenceRate = adherenceTrades.length
    ? (adherenceTrades.filter((trade) => trade.followedPlan).length / adherenceTrades.length) * 100
    : 0;

  const emotionalTrades = recentTrades.filter((trade) => {
    if (!trade.emotionalState) return false;
    return EMOTIONAL_FLAGS.has(String(trade.emotionalState).toLowerCase());
  });

  const setupIds = new Set(
    recentTrades
      .map((trade) => trade.setupId)
      .filter((id): id is string => Boolean(id)),
  );

  const fearExits = closedTrades.filter((trade) => {
    if (trade.exitReason !== "discretionary") return false;
    const note = normalizeNote(trade.notes);
    return note.includes("fear") || note.includes("scared") || note.includes("nervous");
  });

  const dailyCounts = new Map<string, number>();
  for (const trade of recentTrades) {
    const dayKey = toDayKey(trade.enteredAt ?? trade.plannedEntryDate);
    if (!dayKey) continue;
    dailyCounts.set(dayKey, (dailyCounts.get(dayKey) ?? 0) + 1);
  }

  const daysWithTrades = dailyCounts.size;
  const daysHitMax = Array.from(dailyCounts.values()).filter((count) => count >= maxTradesPerDay).length;

  const riskOverrides = recentTrades.filter(
    (trade) => typeof trade.maxRiskPercent === "number" && trade.maxRiskPercent > riskDefault,
  );

  const tips: CoachTip[] = [];

  if (adherenceTrades.length >= 5 && adherenceRate < 70) {
    tips.push({
      title: "Process before P/L",
      rationale: `Only ${pct(adherenceRate)} of recent trades were marked as followed plan.`,
      metricTrigger: `Plan adherence ${pct(adherenceRate)} < 70% (${adherenceTrades.length} trades).`,
      action: "Reduce size and only take A+ setups until adherence is above 70% for two weeks.",
    });
  }

  if (closedTrades.length >= 5 && winRate < 55 && avgLoss > avgWin) {
    tips.push({
      title: "Risk needs tightening",
      rationale: "Your losers are outweighing winners while the win rate is below target.",
      metricTrigger: `Win rate ${pct(winRate)} with avg loss ${money(avgLoss)} > avg win ${money(avgWin)}.`,
      action: "Tighten risk: use defined-risk spreads or cut losers sooner for the next 10 trades.",
    });
  }

  if (recentTrades.length >= 5 && emotionalTrades.length / recentTrades.length >= 0.2) {
    tips.push({
      title: "Cooldown after emotional trades",
      rationale: "Emotional trades tend to compound losses and cloud decision-making.",
      metricTrigger: `Emotional trades ${emotionalTrades.length}/${recentTrades.length} in recent sample.`,
      action: "Add a cooldown rule: stop trading for the day after 1 emotional trade.",
    });
  }

  if (recentTrades.length >= 8 && setupIds.size > 3) {
    tips.push({
      title: "Simplify your setup list",
      rationale: "Too many setups can dilute pattern recognition and edge.",
      metricTrigger: `Used ${setupIds.size} setups in last ${recentTrades.length} trades.`,
      action: "Limit to 1-3 active setups for the next two weeks.",
    });
  }

  if (fearExits.length >= 2) {
    tips.push({
      title: "Define exits to reduce fear",
      rationale: "Fear-based discretionary exits often signal a missing profit plan.",
      metricTrigger: `Discretionary exits with fear notes: ${fearExits.length}.`,
      action: "Pre-define profit-taking rules and consider scaling out at targets.",
    });
  }

  if (daysWithTrades >= 3 && daysHitMax / daysWithTrades >= 0.4) {
    tips.push({
      title: "Overtrading risk",
      rationale: "Hitting your daily limit often signals rushed decision-making.",
      metricTrigger: `Max trades hit on ${daysHitMax}/${daysWithTrades} trading days.`,
      action: "Reduce max trades/day by 1 for two weeks and track focus quality.",
    });
  }

  if (recentTrades.length >= 5 && riskOverrides.length / recentTrades.length >= 0.3) {
    tips.push({
      title: "Stop raising risk",
      rationale: "Increasing risk without consistency can amplify drawdowns.",
      metricTrigger: `Risk above default in ${riskOverrides.length}/${recentTrades.length} trades (default ${riskDefault}%).`,
      action: "Stop increasing risk until you log 4 green weeks in a row.",
    });
  }

  return tips.slice(0, maxTips);
}
