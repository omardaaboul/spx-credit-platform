import type { AlertItem } from "@/lib/spx0dte";
import { formatOptionLegLine, severityDotClass } from "@/lib/spx0dte";

type AlertsPanelProps = {
  alerts: AlertItem[];
};

export default function AlertsPanel({ alerts }: AlertsPanelProps) {
  return (
    <section id="alerts" className="rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--spx-text)]">Alerts & Notifications</h2>
        <span className="text-xs text-[var(--spx-muted)]">Latest first</span>
      </div>

      <div className="max-h-[760px] space-y-3 overflow-auto pr-1">
        {alerts.map((alert) => (
          <article key={alert.id} className="rounded-xl border border-[var(--spx-border)] bg-[var(--spx-panel)] p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${severityDotClass(alert.severity)}`} aria-hidden />
                <p className="text-sm font-medium text-[var(--spx-text)]">
                  {alert.type === "ENTRY" ? "Entry" : "Exit"} - {alert.strategy}
                </p>
              </div>
              <span className="text-xs text-[var(--spx-muted)]">{alert.timeEt} ET</span>
            </div>

            <div className="mt-2 text-sm text-[var(--spx-muted)]">Spot {alert.spot.toFixed(2)}</div>
            <ul className="mt-2 space-y-1 text-sm text-[var(--spx-text)]">
              {alert.legs.map((leg, idx) => (
                <li key={`${alert.id}-${idx}`}>{formatOptionLegLine(leg)}</li>
              ))}
            </ul>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--spx-muted)]">
              <span>Credit: {alert.credit == null ? "-" : alert.credit.toFixed(2)}</span>
              <span>Debit: {alert.debit == null ? "-" : alert.debit.toFixed(2)}</span>
              <span>P/L: {alert.plPct == null ? "-" : `${(alert.plPct * 100).toFixed(0)}%`}</span>
              <span>POP: {alert.popPct == null ? "-" : `${(alert.popPct * 100).toFixed(0)}%`}</span>
            </div>
            <p className="mt-2 text-sm text-[var(--spx-text)]">{alert.reason}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
