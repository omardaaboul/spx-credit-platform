"use client";

import { useEffect, useMemo, useState } from "react";
import { Cashflow, CashflowCategory, db } from "@/lib/db";
import { computeEquityRealized } from "@/lib/equity";

const CATEGORIES: CashflowCategory[] = [
  "EQUITY",
  "DIVIDEND",
  "INTEREST",
  "LENDING",
  "TRANSFER",
  "SWEEP",
  "FEE",
  "OTHER",
];

const CATEGORY_GROUPS = ["EQUITY", "INCOME", "TRANSFERS", "FEES", "OTHER"] as const;
type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

function money(n?: number) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function sumAmount(rows: Cashflow[]) {
  return rows.reduce((a, c) => a + Number(c.amount ?? 0), 0);
}

function displayTicker(c: Cashflow) {
  if (c.category === "EQUITY" || c.category === "DIVIDEND" || c.category === "LENDING") {
    return c.ticker ?? "—";
  }
  return "—";
}

export default function CashflowsPage() {
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>("ALL");
  const [selectedCategory, setSelectedCategory] = useState<CashflowCategory | "ALL">("ALL");
  const [groupFilters, setGroupFilters] = useState<CategoryGroup[]>([]);

  useEffect(() => {
    (async () => {
      const all = await db.cashflows.toArray();
      setCashflows(all);
    })();
  }, []);

  const months = useMemo(() => {
    const s = new Set<string>();
    for (const c of cashflows) {
      if (c.month) s.add(c.month);
    }
    return Array.from(s.values()).sort((a, b) => b.localeCompare(a));
  }, [cashflows]);

  const filtered = useMemo(() => {
    return cashflows.filter((c) => {
      if (selectedMonth !== "ALL" && c.month !== selectedMonth) return false;
      if (selectedCategory !== "ALL" && c.category !== selectedCategory) return false;
      if (groupFilters.length) {
        const group: CategoryGroup =
          c.category === "EQUITY"
            ? "EQUITY"
            : c.category === "DIVIDEND" || c.category === "INTEREST" || c.category === "LENDING"
              ? "INCOME"
              : c.category === "TRANSFER" || c.category === "SWEEP"
                ? "TRANSFERS"
                : c.category === "FEE"
                  ? "FEES"
                  : "OTHER";
        if (!groupFilters.includes(group)) return false;
      }
      return true;
    });
  }, [cashflows, selectedMonth, selectedCategory, groupFilters]);

  const equityRealized = useMemo(() => computeEquityRealized(cashflows), [cashflows]);

  const totals = useMemo(() => {
    const equityAllowed =
      (selectedCategory === "ALL" || selectedCategory === "EQUITY") &&
      (groupFilters.length === 0 || groupFilters.includes("EQUITY"));
    const equity = equityAllowed
      ? selectedMonth === "ALL"
        ? equityRealized.total
        : equityRealized.byMonth.get(selectedMonth) ?? 0
      : 0;
    const income = sumAmount(
      filtered.filter((c) => c.category === "DIVIDEND" || c.category === "INTEREST" || c.category === "LENDING")
    );
    const transfers = sumAmount(
      filtered.filter((c) => c.category === "TRANSFER" || c.category === "SWEEP")
    );
    const fees = sumAmount(filtered.filter((c) => c.category === "FEE"));
    const other = sumAmount(filtered.filter((c) => c.category === "OTHER"));
    return { equity, income, transfers, fees, other };
  }, [filtered, equityRealized.byMonth, equityRealized.total, selectedMonth, selectedCategory, groupFilters]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Cashflows</h1>
          <p className="text-sm text-zinc-900">
            Equity trades and income contribute to P/L. Transfers adjust capital only.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs text-zinc-900">Month</div>
          <select
            className="border rounded-lg px-3 py-2 bg-white text-sm"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
          >
            <option value="ALL">All</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <div className="text-xs text-zinc-900">Category</div>
          <select
            className="border rounded-lg px-3 py-2 bg-white text-sm"
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value as any)}
          >
            <option value="ALL">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-zinc-900">Quick filters</div>
        <button
          className={`px-3 py-1.5 rounded-full text-xs border ${
            groupFilters.length === 0 ? "bg-zinc-900 text-white border-zinc-900" : "border-zinc-200 text-zinc-900"
          }`}
          onClick={() => setGroupFilters([])}
          type="button"
        >
          All
        </button>
        {CATEGORY_GROUPS.map((g) => {
          const active = groupFilters.includes(g);
          const label =
            g === "TRANSFERS" ? "Withdrawals/Transfers" : g === "INCOME" ? "Income" : g[0] + g.slice(1).toLowerCase();
          return (
            <button
              key={g}
              className={`px-3 py-1.5 rounded-full text-xs border ${
                active ? "bg-zinc-900 text-white border-zinc-900" : "border-zinc-200 text-zinc-900"
              }`}
              onClick={() => {
                setGroupFilters((prev) =>
                  prev.includes(g) ? prev.filter((v) => v !== g) : [...prev, g]
                );
              }}
              type="button"
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <Kpi title="Equity P/L (realized)" value={money(totals.equity)} />
        <Kpi title="Income" value={money(totals.income)} />
        <Kpi title="Transfers (net)" value={money(totals.transfers)} />
        <Kpi title="Fees" value={money(totals.fees)} />
        <Kpi title="Other" value={money(totals.other)} />
      </div>

      <div className="border rounded-2xl bg-white overflow-hidden shadow-sm">
        <div className="grid grid-cols-[.9fr_.8fr_.7fr_2fr_.7fr] gap-2 px-4 py-3 text-xs text-zinc-900 border-b bg-zinc-50">
          <div>Date</div>
          <div>Category</div>
          <div>Ticker</div>
          <div>Notes</div>
          <div className="text-right">Amount</div>
        </div>

        {filtered.length === 0 ? (
          <div className="p-6 text-sm text-zinc-900">No cashflows match your filters.</div>
        ) : (
          <div>
            {filtered
              .slice()
              .sort((a, b) => String(b.date).localeCompare(String(a.date)))
              .map((c) => (
                <div
                  key={c.id}
                  className="grid grid-cols-[.9fr_.8fr_.7fr_2fr_.7fr] gap-2 px-4 py-3 text-sm border-b"
                >
                  <div>{c.date}</div>
                  <div>{c.category}</div>
                  <div>{displayTicker(c)}</div>
                  <div className="text-zinc-900 truncate">{c.notes ?? "—"}</div>
                  <div
                    className={`text-right tabular-nums ${
                      (c.amount ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"
                    }`}
                  >
                    {money(c.amount)}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <div className="border rounded-2xl p-4 bg-white shadow-sm">
      <div className="text-xs text-zinc-900">{title}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}
