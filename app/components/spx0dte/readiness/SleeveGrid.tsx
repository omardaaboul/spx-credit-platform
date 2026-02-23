import type { SleeveReadiness } from "@/lib/readiness";
import { readinessBadgeClass, readinessIcon } from "@/app/components/spx0dte/readiness/stateTone";

type SleeveGridProps = {
  sleeves: SleeveReadiness[];
  focusMode: boolean;
  onOpenDiagnostics: (sectionKey?: string) => void;
};

function sleeveLabel(strategy: SleeveReadiness["strategy"]): string {
  if (strategy === "Iron Condor") return "Iron Condor (0DTE)";
  if (strategy === "Iron Fly") return "Iron Fly (0DTE)";
  if (strategy === "Broken-Wing Put Butterfly") return "Broken-Wing Put Butterfly (21-45 DTE)";
  return strategy;
}

export default function SleeveGrid({ sleeves, focusMode, onOpenDiagnostics }: SleeveGridProps) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {sleeves.map((sleeve) => (
        <article
          key={sleeve.key}
          id={`section-${sleeve.sectionKey}`}
          className={`rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-3 ${focusMode && sleeve.state !== "pass" ? "opacity-80" : ""}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-[var(--spx-text)]">{sleeveLabel(sleeve.strategy)}</p>
              <p className="mt-0.5 text-[11px] text-[var(--spx-muted)]">Candidate: {sleeve.candidateExists ? "YES" : "NO"}</p>
            </div>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${readinessBadgeClass(sleeve.state)}`}>
              {sleeve.ready ? "READY" : sleeve.state === "degraded" ? "DEGRADED" : sleeve.state === "blocked" ? "BLOCKED" : "NOT READY"}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            {(sleeve.metrics.length > 0 ? sleeve.metrics : [{ label: "Metric", value: "-" }]).map((metric) => (
              <div key={`${sleeve.key}-${metric.label}`} className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1.5">
                <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--spx-muted)]">{metric.label}</p>
                <p className="text-sm font-medium text-[var(--spx-text)]">{metric.value}</p>
              </div>
            ))}
          </div>

          <p className="mt-3 text-xs text-[var(--spx-muted)]">
            <span className="font-medium text-[var(--spx-text)]">{readinessIcon(sleeve.state)}</span> {sleeve.reason}
          </p>
          <p className="mt-1 text-[11px] text-[var(--spx-muted)]">
            {sleeve.counts.pass}/{sleeve.counts.required} pass
            {sleeve.counts.fail > 0 ? ` · ${sleeve.counts.fail} fail` : ""}
            {sleeve.counts.blocked > 0 ? ` · ${sleeve.counts.blocked} blocked` : ""}
          </p>

          {!focusMode && (
            <button
              type="button"
              onClick={() => onOpenDiagnostics(sleeve.sectionKey)}
              className="btn mt-3 text-xs"
            >
              {sleeve.ready ? "View diagnostics" : "Why blocked?"}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
