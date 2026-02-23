import type { ReadinessGate } from "@/lib/readiness";
import { readinessBadgeClass, readinessIcon, readinessLabel } from "@/app/components/spx0dte/readiness/stateTone";

type ReadinessGatesProps = {
  gates: ReadinessGate[];
  focusMode: boolean;
  onOpenDiagnostics: (sectionKey?: string) => void;
};

export default function ReadinessGates({ gates, focusMode, onOpenDiagnostics }: ReadinessGatesProps) {
  return (
    <section className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
      {gates.map((gate) => (
        <button
          key={gate.key}
          id={gate.key === "global" || gate.key === "regime" ? `section-${gate.sectionKey}` : undefined}
          type="button"
          disabled={focusMode}
          onClick={() => onOpenDiagnostics(gate.sectionKey)}
          className="rounded-xl border border-[var(--spx-border)] bg-[var(--spx-surface)] px-3 py-2 text-left disabled:cursor-default"
          aria-label={`Open diagnostics for ${gate.label}`}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] uppercase tracking-[0.11em] text-[var(--spx-muted)]">{gate.label}</p>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${readinessBadgeClass(gate.state)}`}>
              {readinessLabel(gate.state)}
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--spx-text)]">
            {readinessIcon(gate.state)} {gate.reason}
          </p>
          <p className="mt-1 text-[11px] text-[var(--spx-muted)]">
            {gate.counts.pass}/{gate.counts.required} pass
            {gate.counts.fail > 0 ? ` · ${gate.counts.fail} fail` : ""}
            {gate.counts.blocked > 0 ? ` · ${gate.counts.blocked} blocked` : ""}
          </p>
        </button>
      ))}
    </section>
  );
}
