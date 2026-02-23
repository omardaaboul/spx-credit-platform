"use client";

import { useEffect, useMemo, useState } from "react";
import { db, Cashflow, Trade } from "@/lib/db";
import { buildPositionsFromTransactions, monthKey } from "@/lib/journal";
import { classifyPosition, displayStrategy } from "@/lib/strategy";
import {
  DASHBOARD_RANGES,
  DashboardRange,
  loadCapitalByMonth,
  loadDashboardRange,
  loadDefaultCapital,
  loadGoalReturnPct,
} from "@/lib/settings";
import { computeEquityRealized } from "@/lib/equity";

type Range = DashboardRange;

function money(n: number) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function pct(n: number) {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}
function labelMonth(k: string) {
  const [y, m] = k.split("-");
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[Math.max(0, Number(m) - 1)]} ${y}`;
}

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function inRange(isoMonth: string, range: Range) {
  if (!isoMonth) return false;
  if (range === "ALL") return true;

  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const thisMonth = `${y}-${String(m).padStart(2, "0")}`;

  if (range === "MTD") return isoMonth === thisMonth;
  if (range === "YTD") return isoMonth.startsWith(String(y));

  // L12M: this month + previous 11
  const [yy, mm] = isoMonth.split("-").map(Number);
  if (!yy || !mm) return false;

  const d = new Date(Date.UTC(yy, mm - 1, 1));
  const start = new Date(Date.UTC(y, m - 1, 1));
  start.setUTCMonth(start.getUTCMonth() - 11);
  const end = new Date(Date.UTC(y, m - 1, 1));
  end.setUTCMonth(end.getUTCMonth() + 1);
  return d >= start && d < end;
}

function estimateCapitalAtRisk(p: any) {
  if (p.kind === "SPREAD") {
    return typeof p.maxLoss === "number" ? p.maxLoss : undefined;
  }
  if (p.side === "SHORT" && p.right === "P") {
    return p.strike * 100;
  }
  return undefined;
}

function monthLabel(isoMonth?: string) {
  if (!isoMonth) return "";
  const [y, m] = isoMonth.split("-");
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${names[Math.max(0, Number(m) - 1)]} ${y}`;
}

function rangeLabel(months: { key: string }[]) {
  if (!months.length) return "";
  const sorted = [...months].sort((a, b) => a.key.localeCompare(b.key));
  const start = monthLabel(sorted[0]?.key);
  const end = monthLabel(sorted[sorted.length - 1]?.key);
  return start && end ? `${start} – ${end}` : "";
}

function daysInMonth(isoMonth: string) {
  const [y, m] = isoMonth.split("-").map(Number);
  if (!y || !m) return 0;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function firstWeekday(isoMonth: string) {
  const [y, m] = isoMonth.split("-").map(Number);
  if (!y || !m) return 0;
  return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
}

export default function DashboardPage() {
  const [tx, setTx] = useState<Trade[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [range, setRange] = useState<Range>("L12M");
  const [goalReturnPct, setGoalReturnPct] = useState<number>(2);
  const [calendarMonth, setCalendarMonth] = useState<string>("");
  const [yearFilter, setYearFilter] = useState<string>("ALL");

  const [defaultCapital, setDefaultCapital] = useState<number>(190000);
  const [capitalByMonth, setCapitalByMonth] = useState<Record<string, number>>({});

  useEffect(() => {
    const dc = loadDefaultCapital();
    const initial = dc > 0 ? dc : 190000;
    setDefaultCapital(initial);
    setCapitalByMonth(loadCapitalByMonth());
    setGoalReturnPct(loadGoalReturnPct(2));
    setRange(loadDashboardRange("L12M"));
  }, []);

  useEffect(() => {
    (async () => {
      const all = await db.trades.toArray();
      setTx(all);
      const cf = await db.cashflows.toArray();
      setCashflows(cf);
    })();
  }, []);

  const positions = useMemo(() => buildPositionsFromTransactions(tx as any), [tx]);

  // ✅ KEY FIX: use realizedEvents so partial closes count in the correct month
  const realizedEvents = useMemo(() => {
    return (positions as any[])
      .flatMap((p: any) =>
        (p.realizedEvents ?? []).map((e: any) => ({
          date: String(e.date || ""),
          month: monthKey(String(e.date || "")),
          amount: Number(e.amount ?? 0),
          ticker: String(p.underlying || p.ticker || "").toUpperCase(),
        }))
      )
      .filter((e: any) => e.date && Number.isFinite(e.amount));
  }, [positions]);

  const realizedInRange = useMemo(() => {
    return realizedEvents.filter((e: any) => inRange(e.month, range));
  }, [realizedEvents, range]);

  const realizedInRangeFiltered = useMemo(() => {
    if (yearFilter === "ALL") return realizedInRange;
    return realizedInRange.filter((e: any) => String(e.date || "").startsWith(yearFilter));
  }, [realizedInRange, yearFilter]);

  const cashflowByMonth = useMemo(() => {
    const map = new Map<string, { equity: number; income: number; transfers: number }>();
    for (const c of cashflows) {
      const k = String(c.month || "");
      if (!k || !inRange(k, range)) continue;
      const row = map.get(k) ?? { equity: 0, income: 0, transfers: 0 };
      if (c.category === "DIVIDEND" || c.category === "INTEREST" || c.category === "LENDING") {
        row.income += Number(c.amount ?? 0);
      }
      if (c.category === "TRANSFER" || c.category === "SWEEP") {
        row.transfers += Number(c.amount ?? 0);
      }
      map.set(k, row);
    }
    return map;
  }, [cashflows, range]);

  const equityRealized = useMemo(() => computeEquityRealized(cashflows), [cashflows]);

  const strategyByMonth = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const p of positions as any[]) {
      const strat = classifyPosition(p);
      const events = p.realizedEvents ?? [];
      for (const e of events) {
        const k = monthKey(String(e.date || ""));
        if (!k) continue;
        const bucket = map.get(k) ?? new Map<string, number>();
        bucket.set(strat, Number(((bucket.get(strat) ?? 0) + Number(e.amount ?? 0)).toFixed(2)));
        map.set(k, bucket);
      }
    }
    return map;
  }, [positions]);

  const monthly = useMemo(() => {
    const map = new Map<string, { options: number; equity: number; income: number; transfers: number }>();

    for (const [k, v] of cashflowByMonth.entries()) {
      map.set(k, { options: 0, equity: v.equity, income: v.income, transfers: v.transfers });
    }

    // Option realized by event month (partial closes included)
    for (const e of realizedEvents as any[]) {
      const k = e.month;
      if (!k) continue;
      if (!inRange(k, range)) continue;
      const row = map.get(k) ?? { options: 0, equity: 0, income: 0, transfers: 0 };
      row.options += Number(e.amount ?? 0);
      map.set(k, row);
    }

    for (const [k, v] of equityRealized.byMonth.entries()) {
      if (!inRange(k, range)) continue;
      const row = map.get(k) ?? { options: 0, equity: 0, income: 0, transfers: 0 };
      row.equity += v;
      map.set(k, row);
    }

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => {
        const cap = capitalByMonth[k] ?? defaultCapital;
        const total = v.options + v.equity + v.income;
        const capitalAdj = cap + v.transfers;
        const ret = capitalAdj > 0 ? (total / capitalAdj) * 100 : NaN;
        return {
          key: k,
          month: labelMonth(k),
          options: Number(v.options.toFixed(2)),
          equity: Number(v.equity.toFixed(2)),
          income: Number(v.income.toFixed(2)),
          transfers: Number(v.transfers.toFixed(2)),
          total: Number(total.toFixed(2)),
          capital: cap,
          capitalAdj: Number.isFinite(capitalAdj) ? Number(capitalAdj.toFixed(2)) : cap,
          retPct: Number.isFinite(ret) ? Number(ret.toFixed(2)) : NaN,
          goalMet: Number.isFinite(ret) ? ret >= goalReturnPct : false,
          value: Number(total.toFixed(2)),
        };
      });
  }, [cashflowByMonth, realizedEvents, equityRealized.byMonth, range, capitalByMonth, defaultCapital, goalReturnPct]);

  const monthlyFiltered = useMemo(() => {
    if (yearFilter === "ALL") return monthly;
    return monthly.filter((m) => String(m.key || "").startsWith(yearFilter));
  }, [monthly, yearFilter]);

  const monthInsights = useMemo(() => {
    const incomeByMonth = new Map<string, number>();
    const transfersByMonth = new Map<string, number>();
    for (const c of cashflows) {
      const k = String(c.month || "");
      if (!k) continue;
      if (c.category === "DIVIDEND" || c.category === "INTEREST" || c.category === "LENDING") {
        incomeByMonth.set(k, Number(((incomeByMonth.get(k) ?? 0) + Number(c.amount ?? 0)).toFixed(2)));
      }
      if (c.category === "TRANSFER" || c.category === "SWEEP") {
        transfersByMonth.set(k, Number(((transfersByMonth.get(k) ?? 0) + Number(c.amount ?? 0)).toFixed(2)));
      }
    }

    return monthlyFiltered.map((m) => {
      const optionsEvents = realizedEvents.filter((e: any) => e.month === m.key);
      const wins = optionsEvents.filter((e: any) => (e.amount ?? 0) > 0);
      const losses = optionsEvents.filter((e: any) => (e.amount ?? 0) < 0);
      const byTicker = new Map<string, number>();
      for (const e of optionsEvents as any[]) {
        const t = String(e.ticker || "").toUpperCase();
        if (!t) continue;
        byTicker.set(t, Number(((byTicker.get(t) ?? 0) + Number(e.amount ?? 0)).toFixed(2)));
      }
      const sortedTickers = Array.from(byTicker.entries()).sort((a, b) => b[1] - a[1]);
      const topWinner = sortedTickers[0];
      const topLoser = [...sortedTickers].reverse()[0];
      const winRate = optionsEvents.length ? (wins.length / optionsEvents.length) * 100 : 0;
      const avgWin = wins.length ? wins.reduce((a: number, e: any) => a + (e.amount ?? 0), 0) / wins.length : 0;
      const avgLoss = losses.length
        ? Math.abs(losses.reduce((a: number, e: any) => a + (e.amount ?? 0), 0)) / losses.length
        : 0;
      const biggestLoss = losses.length
        ? Math.abs(Math.min(...losses.map((e: any) => Number(e.amount ?? 0))))
        : 0;

      const stratMap = strategyByMonth.get(m.key);
      const stratEntries = stratMap ? Array.from(stratMap.entries()) : [];
      const sortedStrats = stratEntries.sort((a, b) => b[1] - a[1]);
      const topStrategy = sortedStrats[0];
      const worstStrategy = sortedStrats.length ? sortedStrats[sortedStrats.length - 1] : undefined;
      const topStrategyLabelRaw = topStrategy ? displayStrategy(topStrategy[0] as any) : undefined;
      const worstStrategyLabelRaw = worstStrategy ? displayStrategy(worstStrategy[0] as any) : undefined;
      const topStrategyLabel = topStrategyLabelRaw === "Unknown" ? undefined : topStrategyLabelRaw;
      const worstStrategyLabel = worstStrategyLabelRaw === "Unknown" ? undefined : worstStrategyLabelRaw;

      const equity = equityRealized.byMonth.get(m.key) ?? 0;
      const income = incomeByMonth.get(m.key) ?? 0;
      const total = Number((m.options + equity + income).toFixed(2));
      const retPct = m.capitalAdj > 0 ? (total / m.capitalAdj) * 100 : NaN;
      const biggestLossPct = m.capitalAdj > 0 ? (biggestLoss / m.capitalAdj) * 100 : NaN;

      const winLossQuality =
        avgLoss > 0 && avgWin > 0 ? (avgWin >= avgLoss ? "good" : "needs_work") : "low_sample";
      const goalNote = Number.isFinite(retPct)
        ? retPct >= goalReturnPct
          ? "Nice work hitting the goal."
          : "You missed the goal this month."
        : "Return data is thin this month.";
      const edgeNote = topStrategyLabel
        ? `Your edge showed up in ${topStrategyLabel}.`
        : topWinner
          ? `Your edge showed up in ${topWinner[0]}.`
          : "I did not see a clear edge this month.";
      const dragNote = topLoser && topLoser[1] < 0 ? `The drag came from ${topLoser[0]}.` : "";
      let focusNote = "";
      if (worstStrategyLabel && (worstStrategy?.[1] ?? 0) < 0) {
        focusNote = `Dial down ${worstStrategyLabel} or tighten risk there.`;
      } else if (winLossQuality === "needs_work") {
        focusNote = "Cut losers faster or trim size.";
      } else if (winRate < 50) {
        focusNote = "Be more selective with entries.";
      } else {
        focusNote = "Keep size steady and press your best setups.";
      }
      if (Number.isFinite(biggestLossPct) && biggestLossPct >= 1) {
        focusNote += ` That one loss was ${biggestLossPct.toFixed(2)}% of capital.`;
      }
      const mentorTip = `${goalNote} ${edgeNote} ${dragNote} ${focusNote}`.replace(/\s+/g, " ").trim();

      return {
        key: m.key,
        month: m.month,
        retPct: Number.isFinite(retPct) ? Number(retPct.toFixed(2)) : NaN,
        winRate: Number.isFinite(winRate) ? Number(winRate.toFixed(1)) : 0,
        winLossQuality,
        biggestLossPct: Number.isFinite(biggestLossPct) ? Number(biggestLossPct.toFixed(2)) : 0,
        biggestLoss,
        topWinner,
        topLoser,
        topStrategy,
        worstStrategy,
        topStrategyLabel,
        worstStrategyLabel,
        mentorTip,
      };
    });
  }, [monthlyFiltered, realizedEvents, equityRealized.byMonth, cashflows, strategyByMonth, goalReturnPct]);

  const rangeCoach = useMemo(() => {
    const months = [...monthInsights].sort((a, b) => a.key.localeCompare(b.key));
    if (!months.length) {
      return { lines: ["No monthly data in this range yet."], months: [] as typeof months };
    }

    const belowGoal = months.filter((m) => Number.isFinite(m.retPct) && m.retPct < goalReturnPct);
    const atGoal = months.length - belowGoal.length;
    let longestStreak = 0;
    let current = 0;
    for (const m of months) {
      if (Number.isFinite(m.retPct) && m.retPct < goalReturnPct) {
        current += 1;
        longestStreak = Math.max(longestStreak, current);
      } else {
        current = 0;
      }
    }

    const last3 = months.slice(-3);
    const prev3 = months.slice(-6, -3);
    const trendDelta =
      prev3.length && last3.length
        ? avg(last3.map((m) => m.winRate)) - avg(prev3.map((m) => m.winRate))
        : NaN;
    const trendLine = Number.isFinite(trendDelta)
      ? `Win‑rate trend: ${trendDelta >= 0 ? "+" : ""}${trendDelta.toFixed(1)} pts vs prior 3 months.`
      : "Win‑rate trend: not enough history yet.";

    const strategyCounts = new Map<string, number>();
    const tickerCounts = new Map<string, number>();
    for (const m of months) {
      if (m.worstStrategyLabel) {
        strategyCounts.set(m.worstStrategyLabel, (strategyCounts.get(m.worstStrategyLabel) ?? 0) + 1);
      }
      if (m.topLoser && m.topLoser[1] < 0) {
        tickerCounts.set(m.topLoser[0], (tickerCounts.get(m.topLoser[0]) ?? 0) + 1);
      }
    }
    const topStrategyLeak = Array.from(strategyCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    const topTickerLeak = Array.from(tickerCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    let leakLine = "Leak pattern: no repeat drag detected.";
    if (topStrategyLeak && topStrategyLeak[1] >= 2) {
      leakLine = `Leak pattern: ${topStrategyLeak[0]} underperformed in ${topStrategyLeak[1]} months.`;
    } else if (topTickerLeak && topTickerLeak[1] >= 2) {
      leakLine = `Leak pattern: ${topTickerLeak[0]} dragged ${topTickerLeak[1]} months.`;
    }

    const maxLossPct = Math.max(...months.map((m) => m.biggestLossPct || 0));
    const riskLine = maxLossPct > 0
      ? `Risk: largest single‑loss ${maxLossPct.toFixed(2)}% of capital — keep that contained.`
      : "Risk: no loss events logged.";

    const goalLine =
      longestStreak > 0
        ? `Goal rhythm: ${atGoal}/${months.length} months at/above ${goalReturnPct}% • longest below‑goal streak ${longestStreak}.`
        : `Goal rhythm: ${atGoal}/${months.length} months at/above ${goalReturnPct}%.`;

    return {
      lines: [goalLine, trendLine, leakLine, riskLine],
      months,
    };
  }, [monthInsights, goalReturnPct]);

  const stats = useMemo(() => {
    const wins = (realizedInRangeFiltered as any[]).filter((e) => (e.amount ?? 0) > 0);
    const losses = (realizedInRangeFiltered as any[]).filter((e) => (e.amount ?? 0) < 0);

    const grossWin = wins.reduce((a, e) => a + (e.amount ?? 0), 0);
    const grossLossAbs = Math.abs(losses.reduce((a, e) => a + (e.amount ?? 0), 0));

    const realized = (realizedInRangeFiltered as any[]).reduce((a, e) => a + (e.amount ?? 0), 0);

    const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : grossWin > 0 ? Infinity : 0;

    return {
      realized,
      winRate: (realizedInRangeFiltered as any[]).length
        ? (wins.length / (realizedInRangeFiltered as any[]).length) * 100
        : 0,
      profitFactor,
    };
  }, [realizedInRangeFiltered]);

  const rangeSummary = useMemo(() => {
    const total = monthlyFiltered.reduce((a, m) => a + (Number(m.total) || 0), 0);
    const capitalAdj = monthlyFiltered.reduce((a, m) => a + (Number(m.capitalAdj) || 0), 0);
    const retPct = capitalAdj > 0 ? (total / capitalAdj) * 100 : NaN;
    return {
      total: Number(total.toFixed(2)),
      capitalAdj: Number(capitalAdj.toFixed(2)),
      retPct: Number.isFinite(retPct) ? Number(retPct.toFixed(2)) : NaN,
      months: monthlyFiltered.length,
      span: rangeLabel(monthlyFiltered),
    };
  }, [monthlyFiltered]);

  const dailyTotals = useMemo(() => {
    const map = new Map<string, { amount: number; tickers: Set<string> }>();
    const add = (date: string, amount: number, ticker?: string) => {
      if (!date || !Number.isFinite(amount)) return;
      if (yearFilter !== "ALL" && !String(date).startsWith(yearFilter)) return;
      const entry = map.get(date) ?? { amount: 0, tickers: new Set<string>() };
      entry.amount = Number((entry.amount + amount).toFixed(2));
      if (ticker) entry.tickers.add(ticker);
      map.set(date, entry);
    };

    for (const e of realizedEvents as any[]) {
      add(String(e.date || ""), Number(e.amount ?? 0), String(e.ticker || "").toUpperCase() || undefined);
    }
    for (const e of equityRealized.events) {
      add(String(e.date || ""), Number(e.amount ?? 0), String(e.ticker || "").toUpperCase() || undefined);
    }
    for (const c of cashflows) {
      if (c.category === "DIVIDEND" || c.category === "INTEREST" || c.category === "LENDING") {
        add(String(c.date || ""), Number(c.amount ?? 0), String(c.ticker || "").toUpperCase() || undefined);
      }
    }

    return map;
  }, [realizedEvents, equityRealized.events, cashflows, yearFilter]);

  const calendarMonths = useMemo(() => {
    const s = new Set<string>();
    for (const d of dailyTotals.keys()) {
      if (d.length >= 7) s.add(d.slice(0, 7));
    }
    return Array.from(s.values()).sort((a, b) => b.localeCompare(a));
  }, [dailyTotals]);

  useEffect(() => {
    if (!calendarMonths.length) return;
    if (!calendarMonth || !calendarMonths.includes(calendarMonth)) {
      setCalendarMonth(calendarMonths[0]);
    }
  }, [calendarMonth, calendarMonths]);

  const byTicker = useMemo(() => {
    const map = new Map<string, { realized: number; trades: number; contracts: number; capitalUsed: number }>();
    for (const e of realizedInRangeFiltered as any[]) {
      const t = String(e.ticker || "").toUpperCase();
      if (!t) continue;
      const r = map.get(t) ?? { realized: 0, trades: 0, contracts: 0, capitalUsed: 0 };
      r.realized += Number(e.amount ?? 0);
      r.trades += 1;
      r.contracts += Number(e.qty ?? 0);
      map.set(t, r);
    }
    const closedPositions = (positions as any[]).filter((p) => {
      const m = monthKey(p.closedOn);
      if (!m || !inRange(m, range)) return false;
      if (yearFilter !== "ALL" && !String(p.closedOn || "").startsWith(yearFilter)) return false;
      return p.status === "CLOSED";
    });
    for (const p of closedPositions) {
      const t = String(p.underlying || p.ticker || "").toUpperCase();
      if (!t) continue;
      const r = map.get(t) ?? { realized: 0, trades: 0, contracts: 0, capitalUsed: 0 };
      const risk = estimateCapitalAtRisk(p);
      if (typeof risk === "number") r.capitalUsed += risk;
      map.set(t, r);
    }
    for (const e of equityRealized.events) {
      const month = String(e.month || "").slice(0, 7);
      if (!month || !inRange(month, range)) continue;
      if (yearFilter !== "ALL" && !String(e.date || "").startsWith(yearFilter)) continue;
      const t = String(e.ticker || "").toUpperCase();
      if (!t) continue;
      const r = map.get(t) ?? { realized: 0, trades: 0, contracts: 0, capitalUsed: 0 };
      r.realized += Number(e.amount ?? 0);
      r.trades += 1;
      r.contracts += Number(e.qty ?? 0);
      r.capitalUsed += Number(e.cost ?? 0);
      map.set(t, r);
    }
    return Array.from(map.entries()).map(([ticker, v]) => ({
      ticker,
      realized: Number(v.realized.toFixed(2)),
      trades: v.trades,
      contracts: Number(v.contracts.toFixed(0)),
      capitalUsed: Number(v.capitalUsed.toFixed(2)),
    }));
  }, [realizedInRangeFiltered, positions, equityRealized.events, range, yearFilter]);

  const topWinners = useMemo(
    () => [...byTicker].sort((a, b) => b.realized - a.realized).slice(0, 5),
    [byTicker]
  );
  const topLosers = useMemo(
    () => [...byTicker].sort((a, b) => a.realized - b.realized).slice(0, 5),
    [byTicker]
  );

  const availableYears = useMemo(() => {
    const s = new Set<string>();
    for (const m of monthly) {
      const y = String(m.key || "").slice(0, 4);
      if (y) s.add(y);
    }
    return Array.from(s.values()).sort((a, b) => b.localeCompare(a));
  }, [monthly]);

  return (
    <div className="dashboard-theme -mx-4 -my-6 min-h-screen space-y-6 bg-slate-950 bg-[radial-gradient(1200px_600px_at_10%_-10%,rgba(20,184,166,0.15),transparent),radial-gradient(900px_500px_at_90%_-10%,rgba(34,211,238,0.12),transparent)] px-6 py-8 text-slate-100">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Pro Dashboard</h1>
          <p className="text-sm text-slate-300">
            Monthly return uses total P/L (options + equity realized + income) • Goal = {goalReturnPct}% / month
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-2 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
            {DASHBOARD_RANGES.map((r) => (
              <button
                key={r}
                className={`rounded-lg px-3 py-2 text-sm ${range === r ? "bg-teal-500/20 text-teal-300 border border-teal-500/40" : "text-slate-200"}`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/70 px-2 py-1 text-xs text-slate-300">
            Year
            <select
              className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-xs text-slate-100"
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value)}
            >
              <option value="ALL">All</option>
              {availableYears.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-800 bg-gradient-to-r from-slate-900 via-slate-900 to-slate-950 p-6 shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs text-slate-300">
              {range} Total P/L
              {rangeSummary.span ? ` • ${rangeSummary.span}` : ""}
              {rangeSummary.months ? ` • ${rangeSummary.months} months` : ""}
            </div>
            <div className={`mt-2 text-5xl font-semibold ${(rangeSummary.total ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {rangeSummary.months ? money(rangeSummary.total) : "—"}
            </div>
            <div className="mt-2 text-sm text-slate-300">
              Range return {Number.isFinite(rangeSummary.retPct) ? pct(rangeSummary.retPct) : "—"}
            </div>
          </div>
          <div className="min-w-[200px] rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="text-xs text-slate-300">Adjusted capital</div>
            <div className="mt-1 text-lg font-semibold text-slate-100">
              {rangeSummary.months ? `$${Number(rangeSummary.capitalAdj).toFixed(0)}` : "—"}
            </div>
            <div className="mt-1 text-xs text-slate-400">
              Sum of monthly capital (adjusted by transfers)
            </div>
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Kpi
          title={
            <span className="inline-flex items-center gap-1">
              Win rate (events)
              <InfoDot text="Win rate = winning realized events ÷ total realized events in the selected range." />
            </span>
          }
          value={`${stats.winRate.toFixed(1)}%`}
        />
        <Kpi
          title={
            <span className="inline-flex items-center gap-1">
              Profit factor
              <InfoDot text="Profit factor = gross wins ÷ gross losses for realized events in the selected range." />
            </span>
          }
          value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}
        />
        <Kpi
          title={
            <span className="inline-flex items-center gap-1">
              Default capital
              <InfoDot text="Default capital is your baseline for monthly return; transfers adjust it month by month." />
            </span>
          }
          value={`$${Number(defaultCapital || 0).toFixed(0)}`}
        />
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-[0_14px_30px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-slate-100">Monthly P/L (range)</div>
          <div className="text-xs text-slate-400">{rangeSummary.span}</div>
        </div>
        {monthlyFiltered.length ? (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[...monthlyFiltered].reverse().map((m) => (
              <div key={m.key} className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
                <div className="text-xs text-slate-400">{m.month}</div>
                <div className={`text-sm font-semibold ${m.total >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                  {money(m.total)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 text-sm text-slate-400">No monthly data in this range.</div>
        )}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-[0_14px_30px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-slate-100">Coach notes</div>
          <div className="text-xs text-slate-400">Concise guidance from your last months</div>
        </div>
        <div className="mt-3 space-y-2 text-sm text-slate-200">
          {rangeCoach.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
        {rangeCoach.months.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {[...rangeCoach.months].reverse().map((m) => (
              <span
                key={m.key}
                className={`rounded-full border border-slate-800 px-2 py-1 text-xs ${Number.isFinite(m.retPct) && m.retPct >= goalReturnPct ? "text-emerald-300" : "text-amber-300"}`}
                title={m.mentorTip}
              >
                {m.month}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <Card title="Daily P/L calendar" subtitle="Options, equity realized, and income by day">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-slate-300">Month</div>
          <select
            className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100"
            value={calendarMonth}
            onChange={(e) => setCalendarMonth(e.target.value)}
          >
            {calendarMonths.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </div>

        {calendarMonth ? (
          <div className="mt-4">
            <div className="grid grid-cols-7 gap-2 text-xs text-slate-300">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="text-center">{d}</div>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-7 gap-2">
              {Array.from({ length: firstWeekday(calendarMonth) }).map((_, i) => (
                <div key={`pad-${i}`} />
              ))}
              {Array.from({ length: daysInMonth(calendarMonth) }).map((_, i) => {
                const day = i + 1;
                const date = `${calendarMonth}-${String(day).padStart(2, "0")}`;
                const entry = dailyTotals.get(date);
                const amt = entry?.amount ?? 0;
                const tickers = entry?.tickers ? Array.from(entry.tickers).join(", ") : "";
                const tone = amt > 0 ? "bg-emerald-500/10 text-emerald-300" : amt < 0 ? "bg-rose-500/10 text-rose-300" : "bg-slate-900/60 text-slate-400";
                return (
                  <div
                    key={date}
                    className={`group relative rounded-xl border border-slate-800 p-2 min-h-[64px] ${tone}`}
                  >
                    <div className="text-xs font-medium">{day}</div>
                    <div className="text-xs tabular-nums">{amt ? money(amt) : "—"}</div>
                    <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-max -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                      {tickers ? `Tickers: ${tickers}` : "No trades"}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mt-4 text-sm text-slate-300">No daily data available.</div>
        )}
      </Card>

      <Card title="Monthly performance" subtitle={`Goal: ≥ ${goalReturnPct}% return per month (Total P/L / Adjusted capital)`}>
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <div className="min-w-[780px] grid grid-cols-8 bg-slate-900/70 px-3 py-2 text-xs font-medium text-slate-200">
            <div>Month</div>
            <div className="text-right">Options</div>
            <div className="text-right">Equity</div>
            <div className="text-right">Income</div>
            <div className="text-right">Transfers</div>
            <div className="text-right">Capital (adj)</div>
            <div className="text-right">Return</div>
            <div className="text-right">Goal</div>
          </div>

          {[...monthlyFiltered].reverse().map((m) => (
            <div key={m.key} className="min-w-[780px] grid grid-cols-8 border-t border-slate-800 px-3 py-2 text-sm">
              <div className="font-medium">{m.month}</div>
              <div className={`text-right font-medium ${m.options >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {money(m.options)}
              </div>
              <div className="text-right text-slate-200">{money(m.equity)}</div>
              <div className="text-right text-slate-200">{money(m.income)}</div>
              <div className={`text-right ${m.transfers >= 0 ? "text-slate-200" : "text-amber-300"}`}>
                {money(m.transfers)}
              </div>
              <div className="text-right text-slate-200">
                {Number.isFinite(m.capitalAdj) ? `$${Number(m.capitalAdj).toFixed(0)}` : "—"}
              </div>
              <div className="text-right font-medium">{Number.isFinite(m.retPct) ? pct(m.retPct) : "—"}</div>
              <div className="text-right">
                {Number.isFinite(m.retPct) ? (
                  m.retPct >= goalReturnPct ? (
                    <span className="inline-flex rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-300">
                      On track
                    </span>
                  ) : (
                    <span className="inline-flex rounded-full bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-300">
                      Below {goalReturnPct}%
                    </span>
                  )
                ) : (
                  <span className="text-xs text-slate-300">Set capital</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-3">
        <Card title="Top winners" subtitle="Realized by ticker (events)">
          <MiniTable rows={topWinners} />
        </Card>
        <Card title="Top losers" subtitle="Realized by ticker (events)">
          <MiniTable rows={topLosers} />
        </Card>
      </div>
    </div>
  );
}

function Kpi({ title, value }: { title: React.ReactNode; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-[0_14px_30px_rgba(0,0,0,0.35)]">
      <div className="text-xs text-slate-300">{title}</div>
      <div className="text-2xl font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-[0_18px_40px_rgba(0,0,0,0.35)]">
      <div>
        <div className="font-medium text-slate-100">{title}</div>
        {subtitle ? <div className="mt-0.5 text-xs text-slate-300">{subtitle}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function InfoDot({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex h-4 w-4 items-center justify-center rounded-full border border-teal-400/60 bg-slate-950 text-[10px] text-teal-300">
      i
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-max -translate-x-1/2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] text-slate-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

function MiniTable({
  rows,
}: {
  rows: { ticker: string; realized: number; trades: number; contracts: number; capitalUsed: number }[];
}) {
  if (!rows.length) return <div className="text-sm text-slate-300">No data.</div>;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800">
      <div className="grid grid-cols-[1.2fr_.8fr_.8fr_1fr_1fr] bg-slate-900/70 px-3 py-2 text-xs font-medium text-slate-200">
        <div>Ticker</div>
        <div className="text-right">Trades</div>
        <div className="text-right">Qty</div>
        <div className="text-right">Cap used</div>
        <div className="text-right">Realized</div>
      </div>
      {rows.map((r) => (
        <div key={r.ticker} className="grid grid-cols-[1.2fr_.8fr_.8fr_1fr_1fr] border-t border-slate-800 px-3 py-2 text-sm">
          <div className="font-medium">{r.ticker}</div>
          <div className="text-right text-slate-200">{r.trades}</div>
          <div className="text-right text-slate-200">{r.contracts ? r.contracts : "—"}</div>
          <div className="text-right text-slate-200">{r.capitalUsed ? money(r.capitalUsed) : "—"}</div>
          <div className={`text-right font-medium ${r.realized >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {money(r.realized)}
          </div>
        </div>
      ))}
    </div>
  );
}
