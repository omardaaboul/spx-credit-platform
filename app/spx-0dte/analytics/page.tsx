"use client";

import Panel from "@/app/components/spx0dte/Panel";
import SpxLayoutFrame from "@/app/components/spx0dte/SpxLayoutFrame";
import StatusBar from "@/app/components/spx0dte/StatusBar";
import { useSpxDashboardData } from "@/app/components/spx0dte/useSpxDashboardData";
import { useSpxTheme } from "@/app/components/spx0dte/useSpxTheme";

export default function SpxAnalyticsPage() {
  const { theme, setTheme } = useSpxTheme();
  const { data, loadError } = useSpxDashboardData({ pollMs: 10_000 });

  const weekPnl = data?.sleeveSettings?.weeklyRealizedPnl ?? 0;
  const dayPnl = data?.sleeveSettings?.dailyRealizedPnl ?? 0;
  const scorecard = data?.analyticsScorecard;

  return (
    <SpxLayoutFrame
      theme={theme}
      title="SPX Trade Center · Analytics"
      unreadAlerts={data?.alerts?.length ?? 0}
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
        alertCount={data?.alerts?.length ?? 0}
        onOpenAlerts={() => undefined}
      />

      {loadError && <Panel className="border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{loadError}</Panel>}

      <Panel className="p-3">
        <h2 className="text-sm font-semibold text-[var(--spx-text)]">Performance Snapshot</h2>
        {!scorecard ? (
          <p className="mt-2 text-sm text-[var(--spx-muted)]">Analytics data not available yet.</p>
        ) : (
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
              <p className="text-xs text-[var(--spx-muted)]">Sample Size</p>
              <p className="mt-1 text-lg font-semibold text-[var(--spx-text)]">{scorecard.sampleSize}</p>
            </div>
            <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
              <p className="text-xs text-[var(--spx-muted)]">Strategies Tracked</p>
              <p className="mt-1 text-lg font-semibold text-[var(--spx-text)]">{scorecard.byStrategy.length}</p>
            </div>

            <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
              <p className="mb-2 text-xs text-[var(--spx-muted)]">By Strategy</p>
              <ul className="space-y-1 text-xs">
                {scorecard.byStrategy.slice(0, 6).map((row) => (
                  <li key={row.strategy} className="flex items-center justify-between text-[var(--spx-text)]">
                    <span>{row.strategy}</span>
                    <span>{row.winRatePct.toFixed(1)}% WR</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
              <p className="mb-2 text-xs text-[var(--spx-muted)]">By Regime</p>
              <ul className="space-y-1 text-xs">
                {scorecard.byRegime.slice(0, 6).map((row) => (
                  <li key={row.regime} className="flex items-center justify-between text-[var(--spx-text)]">
                    <span>{row.regime}</span>
                    <span>{row.expectancyPct.toFixed(2)}% Exp</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Panel>
    </SpxLayoutFrame>
  );
}
