import type { ReadinessSummary } from "@/lib/readiness";
import { readinessBadgeClass, readinessLabel } from "@/app/components/spx0dte/readiness/stateTone";

type StatusBarProps = {
  summary: ReadinessSummary;
  generatedAtEt?: string;
  generatedAtParis?: string;
  dataAgeSeconds?: number | null;
  alertsEnabled: boolean;
  onToggleAlerts: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  onOpenRiskSleeve: () => void;
  riskLocked: boolean;
};

export default function StatusBar({
  summary,
  generatedAtEt,
  generatedAtParis,
  dataAgeSeconds,
  alertsEnabled,
  onToggleAlerts,
  focusMode,
  onToggleFocusMode,
  onOpenRiskSleeve,
  riskLocked,
}: StatusBarProps) {
  return (
    <section className="rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[var(--spx-text)]">SPX Trade Center</p>
          <p className="text-xs text-[var(--spx-muted)]">Manual execution only</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full border px-2 py-1 ${summary.marketStatus === "open" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-[var(--spx-border)] bg-[var(--spx-panel)] text-[var(--spx-muted)]"}`}>
            Market {summary.marketStatus === "open" ? "Open" : "Closed"}
          </span>
          <span className={`rounded-full border px-2 py-1 ${summary.dataFreshness === "live" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : summary.dataFreshness === "stale" ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}>
            Data {summary.dataFreshness === "live" ? "Live" : summary.dataFreshness === "stale" ? "Stale" : "Missing"}
          </span>
          {riskLocked && (
            <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-rose-300">Risk Lock</span>
          )}
          <span className={`rounded-full border px-2 py-1 ${readinessBadgeClass(summary.systemState)}`}>
            {readinessLabel(summary.systemState)}
          </span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--spx-border)] pt-2 text-xs text-[var(--spx-muted)]">
        <span>
          Last refresh {generatedAtEt ?? "--:--:--"} ET / {generatedAtParis ?? "--:--:--"} Paris
          {" · "}
          Data age {dataAgeSeconds == null ? "-" : `${dataAgeSeconds}s`}
        </span>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onToggleAlerts}
            className={`btn px-2 text-xs ${alertsEnabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "text-[var(--spx-muted)]"}`}
          >
            Alerts {alertsEnabled ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={onToggleFocusMode}
            className={`btn px-2 text-xs ${focusMode ? "border-[var(--spx-accent)] bg-[var(--spx-accent)]/10 text-[var(--spx-accent)]" : "text-[var(--spx-muted)]"}`}
          >
            Focus Mode
          </button>
          <button
            type="button"
            onClick={onOpenRiskSleeve}
            className="btn px-2 text-xs"
          >
            Risk & Sleeves
          </button>
        </div>
      </div>
    </section>
  );
}
