"use client";

import { AlertTriangle, CheckCircle2, Clock, TrendingUp, XCircle } from "lucide-react";
import Panel from "@/app/components/spx0dte/Panel";

interface GreeksData {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  iv?: number;
  lastUpdated?: string;
}

interface DataQualityCheck {
  name: string;
  status: "pass" | "fail" | "warning" | "stale";
  message: string;
  critical: boolean;
}

interface DataQualityPanelProps {
  marketOpen?: boolean;
  marketDataAge?: number;
  greeksData?: GreeksData;
  bidAskSpread?: number;
  volumeCheck?: boolean;
  lastPriceUpdate?: string;
}

export default function DataQualityPanel({
  marketOpen = true,
  marketDataAge = 0,
  greeksData,
  bidAskSpread,
  volumeCheck = true,
  lastPriceUpdate,
}: DataQualityPanelProps) {
  const checks: DataQualityCheck[] = [
    {
      name: "Market Data Freshness",
      status: !marketOpen ? "stale" : marketDataAge < 30 ? "pass" : marketDataAge < 60 ? "warning" : "fail",
      message: !marketOpen
        ? "Inactive (market closed)"
        : marketDataAge < 30
          ? `Live (${marketDataAge}s ago)`
          : marketDataAge < 60
            ? `Delayed (${marketDataAge}s ago)`
            : `Stale (${marketDataAge}s ago)`,
      critical: true,
    },
    {
      name: "Greeks Validation",
      status: greeksData?.delta !== undefined && greeksData?.iv !== undefined ? "pass" : "warning",
      message:
        greeksData?.delta !== undefined
          ? `Delta: ${greeksData.delta.toFixed(3)}${greeksData.iv != null ? `, IV: ${(greeksData.iv * 100).toFixed(1)}%` : ""}`
          : "Greeks partial or unavailable",
      critical: true,
    },
    {
      name: "Implied Volatility",
      status: greeksData?.iv && greeksData.iv > 0 && greeksData.iv < 2 ? "pass" : "warning",
      message: greeksData?.iv ? `IV: ${(greeksData.iv * 100).toFixed(1)}%` : "IV unavailable",
      critical: false,
    },
    {
      name: "Bid-Ask Spread",
      status: bidAskSpread !== undefined && bidAskSpread < 0.5 ? "pass" : "warning",
      message: bidAskSpread !== undefined ? `Spread: $${bidAskSpread.toFixed(2)}` : "Spread unavailable",
      critical: false,
    },
    {
      name: "Volume & Liquidity",
      status: volumeCheck ? "pass" : "warning",
      message: volumeCheck ? "Adequate" : "Limited",
      critical: false,
    },
  ];

  const criticalFailures = checks.filter((c) => c.critical && c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warning" || c.status === "stale").length;

  const overallStatus = criticalFailures > 0 ? "fail" : warnings > 0 ? "warning" : "pass";

  return (
    <Panel
      className={
        overallStatus === "fail"
          ? "border-rose-500/50 bg-rose-500/5 p-3"
          : overallStatus === "warning"
            ? "border-amber-500/50 bg-amber-500/5 p-3"
            : "border-emerald-500/30 bg-emerald-500/5 p-3"
      }
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {statusIcon(overallStatus)}
            <h3 className="text-sm font-semibold text-[var(--spx-text)]">Data Quality</h3>
          </div>
          <div className="text-xs text-[var(--spx-muted)]">{lastPriceUpdate ? `Updated: ${lastPriceUpdate} ET` : "-"}</div>
        </div>

        {criticalFailures > 0 && (
          <div className="rounded-lg border border-rose-500/50 bg-rose-500/20 p-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-rose-300">
              <XCircle className="h-4 w-4" />
              <span>Critical issue detected</span>
            </div>
            <p className="mt-0.5 text-xs text-rose-300/90">Signals may be unreliable until data refreshes.</p>
          </div>
        )}

        <div className="space-y-1.5">
          {checks.map((check) => (
            <div key={check.name} className={`flex items-center justify-between rounded-lg p-2 ${check.critical && check.status === "fail" ? "bg-rose-500/10" : "bg-[var(--spx-panel)]/50"}`}>
              <div className="flex items-center gap-2">
                {statusIcon(check.status)}
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--spx-text)]">
                    {check.name}
                    {check.critical && <span className="rounded bg-rose-500/20 px-1 py-0.5 text-[10px] text-rose-300">CRITICAL</span>}
                  </div>
                  <div className="text-[11px] text-[var(--spx-muted)]">{check.message}</div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {greeksData && greeksData.delta !== undefined && (
          <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
            <div className="mb-2 flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-[var(--spx-accent)]" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--spx-muted)]">Current Greeks</span>
            </div>
            <div className="grid grid-cols-5 gap-2 text-xs">
              <GreekCell label="Delta" value={greeksData.delta.toFixed(3)} />
              <GreekCell label="Gamma" value={greeksData.gamma != null ? greeksData.gamma.toFixed(3) : "-"} />
              <GreekCell label="Theta" value={greeksData.theta != null ? greeksData.theta.toFixed(2) : "-"} />
              <GreekCell label="Vega" value={greeksData.vega != null ? greeksData.vega.toFixed(2) : "-"} />
              <GreekCell label="IV" value={greeksData.iv != null ? `${(greeksData.iv * 100).toFixed(1)}%` : "-"} />
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function statusIcon(status: "pass" | "fail" | "warning" | "stale") {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === "warning") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  if (status === "stale") return <Clock className="h-4 w-4 text-slate-400" />;
  return <XCircle className="h-4 w-4 text-rose-500" />;
}

function GreekCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[var(--spx-muted)]">{label}</div>
      <div className="font-mono font-semibold text-[var(--spx-text)]">{value}</div>
    </div>
  );
}
