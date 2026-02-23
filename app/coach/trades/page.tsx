"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useCoachData } from "@/lib/coach-data";
import { deleteCoachPlan, loadCoachPlans, type CoachPlan } from "@/lib/coach-store";
import type { Position } from "@/lib/journal";

type Tab = "imported" | "plans";

function money(n?: number) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function labelPosition(p: Position) {
  return `${p.underlying} ${p.expiry} ${p.right} ${p.strike}`;
}

function statusLabel(status?: string) {
  if (!status) return "—";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export default function CoachTradesPage() {
  const router = useRouter();
  const [tabParam, setTabParam] = useState<string>("");
  const [tab, setTab] = useState<Tab>(tabParam === "plans" ? "plans" : "imported");
  const [status, setStatus] = useState<string>("ALL");
  const [query, setQuery] = useState<string>("");
  const [plans, setPlans] = useState<CoachPlan[]>([]);
  const { positions } = useCoachData();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const param = new URLSearchParams(window.location.search).get("tab") ?? "";
    setTabParam(param);
  }, []);

  useEffect(() => {
    if (tabParam === "plans") setTab("plans");
    else setTab("imported");
  }, [tabParam]);

  useEffect(() => {
    if (tab === "plans") setPlans(loadCoachPlans());
  }, [tab]);

  const filteredPositions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return positions.filter((p) => {
      if (status !== "ALL" && p.status !== status) return false;
      if (!q) return true;
      return labelPosition(p).toLowerCase().includes(q);
    });
  }, [positions, query, status]);

  const handleTabChange = (next: Tab) => {
    setTab(next);
    router.replace(`/coach/trades${next === "plans" ? "?tab=plans" : ""}`);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Trades</div>
            <div className="text-xs text-slate-400">
              Imported trades are read from your existing Options Log data.
            </div>
          </div>
          <div className="flex gap-2 text-xs">
            <button
              className={`rounded-lg border px-3 py-1 ${tab === "imported" ? "border-teal-500/60 bg-teal-500/10 text-teal-200" : "border-slate-800 text-slate-300"}`}
              onClick={() => handleTabChange("imported")}
            >
              Imported
            </button>
            <button
              className={`rounded-lg border px-3 py-1 ${tab === "plans" ? "border-teal-500/60 bg-teal-500/10 text-teal-200" : "border-slate-800 text-slate-300"}`}
              onClick={() => handleTabChange("plans")}
            >
              Plans
            </button>
          </div>
        </div>
      </div>

      {tab === "imported" ? (
        <>
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
            <div className="grid gap-3 sm:grid-cols-3">
              <input
                placeholder="Search symbol or strategy"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
              />
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
              >
                <option value="ALL">All statuses</option>
                <option value="OPEN">Open</option>
                <option value="CLOSED">Closed</option>
                <option value="INCOMPLETE">Incomplete</option>
              </select>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 text-slate-100">
            <div className="grid grid-cols-[1.4fr_.7fr_.7fr_.7fr_.6fr_.5fr] gap-2 border-b border-slate-800 bg-slate-900/80 px-4 py-3 text-xs text-slate-300">
              <div>Trade</div>
              <div>Status</div>
              <div>Opened</div>
              <div>Closed</div>
              <div>Qty</div>
              <div className="text-right">P/L</div>
            </div>
            {filteredPositions.length ? (
              filteredPositions.map((p) => {
                const pnlValue = p.status === "CLOSED" ? p.realizedPL : p.premiumCollected;
                return (
                  <a
                    key={p.key}
                    href={`/coach/trades/${encodeURIComponent(p.key)}`}
                    className="grid grid-cols-[1.4fr_.7fr_.7fr_.7fr_.6fr_.5fr] gap-2 border-b border-slate-800 px-4 py-3 text-sm hover:bg-slate-900/60"
                  >
                    <div>
                      <div className="font-medium">{labelPosition(p)}</div>
                      <div className="text-xs text-slate-400">{p.side} {p.right}</div>
                    </div>
                    <div className="capitalize text-slate-200">{statusLabel(p.status)}</div>
                    <div className="text-xs text-slate-300">{p.openedOn ?? "—"}</div>
                    <div className="text-xs text-slate-300">{p.closedOn ?? "—"}</div>
                    <div className="text-xs text-slate-300">{p.status === "CLOSED" ? p.qtyClosed : p.qtyOpened}</div>
                    <div className={`text-right ${typeof pnlValue === "number" && pnlValue >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                      {money(pnlValue)}
                    </div>
                  </a>
                );
              })
            ) : (
              <div className="px-4 py-6 text-sm text-slate-300">No imported trades match your filters.</div>
            )}
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
            <div className="text-sm font-semibold">Planned trades</div>
            <div className="text-xs text-slate-400">These are saved locally from the trade plan wizard.</div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/70 text-slate-100">
            <div className="grid grid-cols-[1.2fr_.8fr_.7fr_.7fr_.6fr] gap-2 border-b border-slate-800 bg-slate-900/80 px-4 py-3 text-xs text-slate-300">
              <div>Symbol</div>
              <div>Status</div>
              <div>Planned</div>
              <div>Entered</div>
              <div className="text-right">Actions</div>
            </div>
            {plans.length ? (
              plans.map((plan) => (
                <div
                  key={plan.id}
                  className="grid grid-cols-[1.2fr_.8fr_.7fr_.7fr_.6fr] gap-2 border-b border-slate-800 px-4 py-3 text-sm"
                >
                  <div className="font-medium">{plan.symbol}</div>
                  <div className="capitalize text-slate-200">{statusLabel(plan.status)}</div>
                  <div className="text-xs text-slate-300">{plan.plannedEntryDate}</div>
                  <div className="text-xs text-slate-300">{plan.enteredAt ?? "—"}</div>
                  <div className="text-right">
                    <button
                      className="text-xs text-rose-300 hover:text-rose-200"
                      onClick={() => {
                        deleteCoachPlan(plan.id);
                        setPlans(loadCoachPlans());
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="px-4 py-6 text-sm text-slate-300">No plans saved yet.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
