import type { ChecklistItem, ChecklistStatus, DashboardPayload } from "@/lib/spx0dte";
import Panel from "@/app/components/spx0dte/Panel";

type ChecklistPanelProps = {
  data: DashboardPayload | null;
};

export default function ChecklistPanel({ data }: ChecklistPanelProps) {
  const globalRows = data?.globalChecklist ?? [];
  const regime = data?.regimeSummary;
  const eligibility = data?.strategyEligibility ?? [];

  return (
    <Panel as="section" className="p-5">
      <h2 className="text-base font-semibold text-[var(--spx-text)]">Strategy Checklist Panel</h2>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Panel as="div" className="bg-[var(--spx-panel)] p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--spx-muted)]">Global Checklist</p>
          <ChecklistRows rows={globalRows} />
        </Panel>

        <Panel as="div" className="bg-[var(--spx-panel)] p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--spx-muted)]">Regime Check</p>
          <div className="space-y-2 text-sm">
            <p className="text-[var(--spx-text)]">
              Regime: <span className="font-medium">{regime?.regime ?? "-"}</span>
            </p>
            <p className="text-[var(--spx-text)]">
              Favored: <span className="font-medium">{regime?.favoredStrategy ?? "-"}</span>
            </p>
            <p className="text-xs text-[var(--spx-muted)]">{regime?.reason ?? "Waiting for regime data."}</p>
          </div>
        </Panel>

        <Panel as="div" className="bg-[var(--spx-panel)] p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--spx-muted)]">Strategy Eligibility</p>
          <ul className="space-y-2 text-sm">
            {eligibility.length === 0 && <li className="text-[var(--spx-muted)]">No strategy eligibility data yet.</li>}
            {eligibility.map((row) => (
              <li key={row.strategy} className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-surface)] px-2 py-1.5">
                <div className="flex items-start gap-2">
                  <StatusIcon status={row.status} />
                  <div>
                    <p className={`leading-tight ${statusTextClass(row.status)}`}>{row.strategy}</p>
                    <p className="text-xs text-[var(--spx-muted)]">{row.reason}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </Panel>
  );
}

function ChecklistRows({ rows }: { rows: ChecklistItem[] }) {
  return (
    <ul className="space-y-2 text-sm">
      {rows.length === 0 && <li className="text-[var(--spx-muted)]">No global checklist data yet.</li>}
      {rows.map((row, idx) => (
        <li key={`${row.name}-${idx}`} className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-surface)] px-2 py-1.5">
          <div className="flex items-start gap-2">
            <StatusIcon status={row.status} />
            <div>
              <p className={`leading-tight ${statusTextClass(row.status)}`}>{row.name}</p>
              {row.detail && <p className="text-xs text-[var(--spx-muted)]">{row.detail}</p>}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function StatusIcon({ status }: { status: ChecklistStatus }) {
  if (status === "pass") {
    return (
      <span className="mt-[1px] text-xs font-bold text-emerald-400" aria-hidden>
        ✔
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="mt-[1px] text-xs font-bold text-rose-400" aria-hidden>
        ✖
      </span>
    );
  }
  if (status === "blocked") {
    return (
      <span className="mt-[1px] text-xs font-bold text-amber-300" aria-hidden>
        !
      </span>
    );
  }
  return (
    <span className="mt-[1px] text-xs font-bold text-slate-400" aria-hidden>
      —
    </span>
  );
}

function statusTextClass(status: ChecklistStatus): string {
  if (status === "pass") return "text-emerald-200";
  if (status === "fail") return "text-rose-200";
  if (status === "blocked") return "text-amber-200";
  return "text-slate-300";
}
