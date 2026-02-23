"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { generateCoachTips } from "@/lib/coach-tips";
import { useCoachData } from "@/lib/coach-data";
import { DEFAULT_COACH_RULES, loadCoachRules } from "@/lib/coach-store";

function money(n: number) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number) {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function startOfWeek(date: Date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfWeek(date: Date) {
  const d = startOfWeek(date);
  d.setDate(d.getDate() + 6);
  d.setHours(23, 59, 59, 999);
  return d;
}

export default function WeeklyReviewPage() {
  const { closedPositions, equityEvents, coachTrades } = useCoachData();
  const router = useRouter();
  const [rules, setRules] = useState(DEFAULT_COACH_RULES);
  const [weekParam, setWeekParam] = useState<string>("");
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const param = new URLSearchParams(window.location.search).get("week") ?? "";
    setWeekParam(param);
  }, []);

  useEffect(() => {
    if (weekParam) setWeekStart(startOfWeek(new Date(weekParam)));
  }, [weekParam]);

  useEffect(() => {
    setRules(loadCoachRules());
  }, []);

  const weekEnd = useMemo(() => endOfWeek(weekStart), [weekStart]);

  const closedThisWeek = useMemo(() => {
    const optionEvents = closedPositions
      .filter((p) => {
        const closedOn = String(p.closedOn ?? "");
        if (!closedOn) return false;
        const closedAt = new Date(`${closedOn}T00:00:00Z`);
        return closedAt >= weekStart && closedAt <= weekEnd;
      })
      .map((p) => ({ amount: Number(p.realizedPL ?? 0) }));

    const equityEventsWeek = equityEvents
      .filter((e) => {
        const closedAt = new Date(`${String(e.date)}T00:00:00Z`);
        return closedAt >= weekStart && closedAt <= weekEnd;
      })
      .map((e) => ({ amount: Number(e.amount ?? 0) }));

    return [...optionEvents, ...equityEventsWeek];
  }, [closedPositions, equityEvents, weekStart, weekEnd]);

  const wins = closedThisWeek.filter((p) => p.amount > 0);
  const losses = closedThisWeek.filter((p) => p.amount < 0);
  const winRate = closedThisWeek.length ? (wins.length / closedThisWeek.length) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((a, p) => a + p.amount, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, p) => a + p.amount, 0)) / losses.length : 0;
  const expectancy = closedThisWeek.length ? (winRate / 100) * avgWin - ((100 - winRate) / 100) * avgLoss : 0;
  const netPnl = closedThisWeek.reduce((a, p) => a + p.amount, 0);

  const tips = useMemo(() => generateCoachTips(coachTrades, rules).slice(0, 7), [coachTrades, rules]);

  const weekOptions = useMemo(() => {
    return Array.from({ length: 8 }).map((_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - i * 7);
      return startOfWeek(d);
    });
  }, []);

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Weekly Review</div>
            <div className="text-xs text-slate-400">
              {weekStart.toISOString().slice(0, 10)} → {weekEnd.toISOString().slice(0, 10)}
            </div>
          </div>
          <select
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            value={weekStart.toISOString().slice(0, 10)}
            onChange={(e) => {
              const next = e.target.value;
              setWeekParam(next);
              router.replace(`/coach/weekly-review?week=${next}`);
            }}
          >
            {weekOptions.map((w) => (
              <option key={w.toISOString()} value={w.toISOString().slice(0, 10)}>
                Week of {w.toISOString().slice(0, 10)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total trades" value={`${closedThisWeek.length}`} />
        <Stat label="Net P/L" value={money(netPnl)} />
        <Stat label="Win rate" value={pct(winRate)} />
        <Stat label="Expectancy" value={money(expectancy)} />
        <Stat label="Avg win" value={money(avgWin)} />
        <Stat label="Avg loss" value={money(-avgLoss)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Emotional distribution</div>
          <div className="mt-3 text-sm text-slate-300">
            Emotional data is not captured in imported trades yet.
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Top mistakes</div>
          <div className="mt-3 text-sm text-slate-300">
            Mistake tags will appear once trade journaling is enabled.
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Coach tips</div>
          <div className="mt-3 space-y-2 text-xs text-slate-300">
            {tips.length ? (
              tips.map((t, i) => (
                <div key={i} className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
                  <div className="font-medium text-slate-100">{t.title}</div>
                  <div className="text-slate-400">{t.action}</div>
                </div>
              ))
            ) : (
              <div className="text-slate-400">No tips available.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-slate-100">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}
