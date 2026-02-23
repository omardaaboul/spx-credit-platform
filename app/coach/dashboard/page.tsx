"use client";

import { useEffect, useMemo, useState } from "react";
import { generateCoachTips } from "@/lib/coach-tips";
import { useCoachData } from "@/lib/coach-data";
import { DEFAULT_COACH_RULES, loadCoachRules } from "@/lib/coach-store";
import { loadCapitalByMonth, loadDefaultCapital } from "@/lib/settings";

function money(n: number) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number) {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function CoachDashboardPage() {
  const { positions, cashflows, closedPositions, realizedEvents, equityEvents, coachTrades } = useCoachData();
  const [rules, setRules] = useState(DEFAULT_COACH_RULES);
  const [defaultCapital, setDefaultCapital] = useState<number>(190000);
  const [capitalByMonth, setCapitalByMonth] = useState<Record<string, number>>({});

  useEffect(() => {
    setRules(loadCoachRules());
    const dc = loadDefaultCapital();
    setDefaultCapital(dc > 0 ? dc : 190000);
    setCapitalByMonth(loadCapitalByMonth());
  }, []);

  const closedEvents = useMemo(() => {
    const optionEvents = closedPositions
      .filter((p) => typeof p.realizedPL === "number" && p.closedOn)
      .map((p) => ({ date: String(p.closedOn), amount: Number(p.realizedPL ?? 0) }));
    const equity = equityEvents.map((e) => ({ date: String(e.date), amount: Number(e.amount ?? 0) }));
    return [...optionEvents, ...equity];
  }, [closedPositions, equityEvents]);

  const wins = useMemo(() => closedEvents.filter((p) => p.amount > 0), [closedEvents]);
  const losses = useMemo(() => closedEvents.filter((p) => p.amount < 0), [closedEvents]);
  const winRate = closedEvents.length ? (wins.length / closedEvents.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((a, p) => a + p.amount, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, p) => a + p.amount, 0)) / losses.length : 0;
  const expectancy =
    closedEvents.length ? (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss : 0;
  const avgPnl = closedEvents.length ? closedEvents.reduce((a, p) => a + p.amount, 0) / closedEvents.length : 0;

  const today = todayISO();
  const tradesToday =
    positions.filter((p) => String(p.openedOn ?? "").slice(0, 10) === today).length +
    cashflows.filter((c) => c.category === "EQUITY" && String(c.date) === today).length;
  const realizedToday = [
    ...realizedEvents.filter((e) => e.date === today),
    ...equityEvents.filter((e) => e.date === today),
  ];
  const realizedPnlToday = realizedToday.reduce((a, e) => a + e.amount, 0);
  const currentMonth = today.slice(0, 7);
  const accountValueToday = capitalByMonth[currentMonth] ?? defaultCapital;
  const maxDailyLossAmount = accountValueToday * (rules.maxDailyLossPercent / 100);

  const tips = useMemo(() => generateCoachTips(coachTrades, rules).slice(0, 7), [coachTrades, rules]);

  const guardrailWarnings = [
    tradesToday >= rules.maxTradesPerDay
      ? `Max trades reached (${tradesToday}/${rules.maxTradesPerDay}).`
      : tradesToday >= rules.maxTradesPerDay - 1
        ? `Approaching max trades (${tradesToday}/${rules.maxTradesPerDay}).`
        : "",
    maxDailyLossAmount > 0 && realizedPnlToday <= -maxDailyLossAmount
      ? `Daily loss limit hit (${money(realizedPnlToday)} / ${money(-maxDailyLossAmount)}).`
      : maxDailyLossAmount > 0 && realizedPnlToday <= -0.8 * maxDailyLossAmount
        ? `Near daily loss limit (${money(realizedPnlToday)} / ${money(-maxDailyLossAmount)}).`
        : "",
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
        <div className="text-sm font-semibold">Imported trade insights</div>
        <div className="mt-1 text-xs text-slate-400">
          Metrics and coaching tips use the trades you already imported into Options Log.
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Today’s Guardrails</div>
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            <div>
              Trades today: <span className="text-slate-100">{tradesToday}</span> / {rules.maxTradesPerDay}
            </div>
            <div>
              Realized P/L today:{" "}
              <span className={realizedPnlToday >= 0 ? "text-emerald-300" : "text-rose-300"}>
                {money(realizedPnlToday)}
              </span>
              {maxDailyLossAmount > 0 ? ` (limit ${money(-maxDailyLossAmount)})` : ""}
            </div>
          </div>
          {guardrailWarnings.length ? (
            <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              {guardrailWarnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-slate-400">Within guardrails so far.</div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100 lg:col-span-2">
          <div className="text-sm font-semibold">Quick Performance</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Win rate" value={pct(winRate)} />
            <Stat label="Avg win" value={money(avgWin)} />
            <Stat label="Avg loss" value={money(-avgLoss)} />
            <Stat label="Expectancy" value={money(expectancy)} />
            <Stat label="Avg P/L" value={money(avgPnl)} />
            <Stat label="Closed trades" value={`${closedEvents.length}`} />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100 lg:col-span-2">
          <div className="text-sm font-semibold">Coach Feedback</div>
          {tips.length ? (
            <div className="mt-3 space-y-3">
              {tips.map((tip, i) => (
                <div key={i} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                  <div className="text-sm font-medium text-slate-100">{tip.title}</div>
                  <div className="mt-1 text-xs text-slate-300">{tip.rationale}</div>
                  <div className="mt-2 text-xs text-slate-400">
                    Trigger: {tip.metricTrigger} • Action: {tip.action}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-sm text-slate-400">Add more trades to generate coaching tips.</div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Active Rules</div>
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            <div>Risk per trade: {rules.riskPerTradePercentDefault.toFixed(2)}%</div>
            <div>Max daily loss: {rules.maxDailyLossPercent.toFixed(2)}%</div>
            <div>Max trades/day: {rules.maxTradesPerDay}</div>
            <div>Checklist required: {rules.requireChecklistBeforeEntry ? "Yes" : "No"}</div>
            <div>Max loss required: {rules.requireMaxLossDefined ? "Yes" : "No"}</div>
          </div>
          <a className="mt-3 inline-flex text-xs text-teal-300 hover:text-teal-200" href="/coach/rules">
            Edit rules →
          </a>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-100">{value}</div>
    </div>
  );
}
