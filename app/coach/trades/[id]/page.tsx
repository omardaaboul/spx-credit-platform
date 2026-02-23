"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { useCoachData } from "@/lib/coach-data";
import type { Position } from "@/lib/journal";

function money(n?: number) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function labelPosition(p: Position) {
  return `${p.underlying} ${p.expiry} ${p.right} ${p.strike}`;
}

export default function CoachTradeDetailPage() {
  const params = useParams();
  const id = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const decodedId = id ? decodeURIComponent(id) : "";
  const { positions } = useCoachData();

  const position = useMemo(
    () => positions.find((p) => p.key === decodedId),
    [positions, decodedId]
  );

  if (!position) {
    return <div className="text-slate-300">Trade not found.</div>;
  }

  const pnlValue = position.status === "CLOSED" ? position.realizedPL : position.premiumCollected;

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{labelPosition(position)}</div>
            <div className="text-xs text-slate-400">
              {position.side} {position.right} • {position.status}
            </div>
          </div>
          <div className={`text-sm font-semibold ${typeof pnlValue === "number" && pnlValue >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {money(pnlValue)}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Position details</div>
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            <div><span className="text-slate-400">Underlying:</span> {position.underlying}</div>
            <div><span className="text-slate-400">Expiry:</span> {position.expiry}</div>
            <div><span className="text-slate-400">Strike:</span> {position.strike}</div>
            <div><span className="text-slate-400">Opened:</span> {position.openedOn ?? "—"}</div>
            <div><span className="text-slate-400">Closed:</span> {position.closedOn ?? "—"}</div>
            <div><span className="text-slate-400">Qty opened:</span> {position.qtyOpened}</div>
            <div><span className="text-slate-400">Qty closed:</span> {position.qtyClosed}</div>
            <div><span className="text-slate-400">Qty remaining:</span> {position.qtyRemaining}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Cashflow</div>
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            <div><span className="text-slate-400">Premium collected:</span> {money(position.premiumCollected)}</div>
            <div><span className="text-slate-400">Cost to close:</span> {money(position.costToClose)}</div>
            <div><span className="text-slate-400">Realized P/L:</span> {money(position.realizedPL)}</div>
          </div>
        </div>
      </div>

      {position.realizedEvents?.length ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Realized events</div>
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            {position.realizedEvents.map((e, idx) => (
              <div key={idx}>
                {e.date}: {money(e.amount)} ({e.qty} contracts)
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
