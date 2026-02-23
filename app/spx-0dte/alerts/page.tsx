"use client";

import { useMemo, useState } from "react";
import type { AlertItem, Strategy } from "@/lib/spx0dte";
import { formatOptionLegLine, severityDotClass } from "@/lib/spx0dte";
import Panel from "@/app/components/spx0dte/Panel";
import SpxLayoutFrame from "@/app/components/spx0dte/SpxLayoutFrame";
import StatusBar from "@/app/components/spx0dte/StatusBar";
import { useSpxDashboardData } from "@/app/components/spx0dte/useSpxDashboardData";
import { useSpxTheme } from "@/app/components/spx0dte/useSpxTheme";

export default function SpxAlertsPage() {
  const { theme, setTheme } = useSpxTheme();
  const { data, setData, loadError } = useSpxDashboardData({ pollMs: 5_000 });
  const [filterType, setFilterType] = useState<"ALL" | "ENTRY" | "EXIT">("ALL");
  const [filterStrategy, setFilterStrategy] = useState<"ALL" | Strategy>("ALL");
  const [ackInFlightId, setAckInFlightId] = useState<string | null>(null);

  const alerts = useMemo(() => data?.alerts ?? [], [data?.alerts]);
  const filtered = useMemo(
    () =>
      alerts.filter((row) => {
        if (filterType !== "ALL" && row.type !== filterType) return false;
        if (filterStrategy !== "ALL" && row.strategy !== filterStrategy) return false;
        return true;
      }),
    [alerts, filterType, filterStrategy],
  );

  const weekPnl = data?.sleeveSettings?.weeklyRealizedPnl ?? 0;
  const dayPnl = data?.sleeveSettings?.dailyRealizedPnl ?? 0;
  const acknowledgeAlert = async (alert: AlertItem) => {
    try {
      setAckInFlightId(alert.id);
      const res = await fetch("/api/spx0dte", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ack_alert", alert }),
      });
      if (!res.ok) return;
      setData((prev) => (prev ? { ...prev, alerts: prev.alerts.filter((row) => row.id !== alert.id) } : prev));
    } finally {
      setAckInFlightId(null);
    }
  };

  return (
    <SpxLayoutFrame
      theme={theme}
      title="SPX Trade Center · Alerts"
      unreadAlerts={alerts.length}
      dataQualityWarning={Boolean(data?.staleData?.active || data?.dataContract?.status === "degraded")}
      rightActions={
        <button type="button" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))} className="btn h-8 px-3 text-xs">
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      }
    >
      <StatusBar
        marketOpen={Boolean(data?.market?.isOpen)}
        dataAgeSeconds={data?.staleData?.ageSeconds}
        dayPnl={dayPnl}
        weekPnl={weekPnl}
        dataContractStatus={data?.dataContract?.status}
        alertCount={alerts.length}
        onOpenAlerts={() => undefined}
      />

      {loadError && <Panel className="border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{loadError}</Panel>}

      <Panel className="space-y-3 p-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-[var(--spx-muted)]">
            Type
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as "ALL" | "ENTRY" | "EXIT")}
              className="mt-1 w-full rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1 text-sm text-[var(--spx-text)]"
            >
              <option value="ALL">All</option>
              <option value="ENTRY">Entry</option>
              <option value="EXIT">Exit</option>
            </select>
          </label>
          <label className="text-xs text-[var(--spx-muted)]">
            Strategy
            <select
              value={filterStrategy}
              onChange={(e) => setFilterStrategy(e.target.value as "ALL" | Strategy)}
              className="mt-1 w-full rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1 text-sm text-[var(--spx-text)]"
            >
              <option value="ALL">All</option>
              {[
                "Iron Condor",
                "Iron Fly",
                "Directional Spread",
                "Convex Debit Spread",
                "2-DTE Credit Spread",
              ].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>

        {filtered.length === 0 && <p className="text-sm text-[var(--spx-muted)]">No alerts match this filter.</p>}
        <div className="space-y-2">
          {filtered.map((alert) => (
            <article key={alert.id} className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
              <div className="flex items-center justify-between text-sm">
                <span className="inline-flex items-center gap-2 text-[var(--spx-text)]">
                  <span className={`h-2 w-2 rounded-full ${severityDotClass(alert.severity)}`} />
                  {alert.type} · {alert.strategy}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--spx-muted)]">{alert.timeEt} ET</span>
                  <button
                    type="button"
                    onClick={() => acknowledgeAlert(alert)}
                    disabled={ackInFlightId === alert.id}
                    className="btn btn-muted h-6 px-1.5 text-[10px]"
                  >
                    {ackInFlightId === alert.id ? "..." : "Ack"}
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-[var(--spx-muted)]">{alert.reason}</p>
              {alert.legs.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-[var(--spx-accent)]">Legs</summary>
                  <ul className="mt-1 space-y-1 text-xs text-[var(--spx-text)]">
                    {alert.legs.map((leg, idx) => (
                      <li key={`${alert.id}-${idx}`}>{formatOptionLegLine(leg)}</li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          ))}
        </div>
      </Panel>
    </SpxLayoutFrame>
  );
}
