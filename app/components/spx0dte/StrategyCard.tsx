import type { CandidateCard, ChecklistItem, ChecklistStatus } from "@/lib/spx0dte";
import { formatOptionLegLine } from "@/lib/spx0dte";
import Panel from "@/app/components/spx0dte/Panel";

type StrategyCardProps = {
  item: CandidateCard;
};

export default function StrategyCard({ item }: StrategyCardProps) {
  const checklist = item.checklist;
  const criteria = item.criteria ?? [];
  const flattenedChecklist = checklist ? [...checklist.global, ...checklist.regime, ...checklist.strategy] : [];
  const passedCount = flattenedChecklist.length
    ? flattenedChecklist.filter((c) => c.status === "pass").length
    : criteria.filter((c) => c.passed).length;
  const totalCount = flattenedChecklist.length || criteria.length;
  const premiumLabel = item.strategy === "Convex Debit Spread" ? "Debit" : "Credit";
  const blockedReason = item.blockedReason || item.reason || "Criteria not fully met.";

  return (
    <Panel as="article" className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-[var(--spx-text)]">{item.strategy}</h3>
          <p className="mt-1 text-sm text-[var(--spx-muted)]">{item.ready ? "All required checklist items passed." : blockedReason}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
            item.ready
              ? "bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/35"
              : "bg-amber-500/15 text-amber-500 ring-1 ring-amber-500/35"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${item.ready ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
          {item.ready ? "READY" : "NOT READY"}
        </span>
      </div>

      <div
        className={`mt-4 rounded-xl border px-3 py-2 text-sm ${
          item.ready
            ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
            : "border-rose-500/35 bg-rose-500/10 text-rose-300"
        }`}
      >
        {item.ready ? "READY TO TRADE" : `BLOCKED - ${blockedReason}`}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <div>
          <dt className="text-[var(--spx-muted)]">Width</dt>
          <dd className="font-medium text-[var(--spx-text)]">{item.width}</dd>
        </div>
        <div>
          <dt className="text-[var(--spx-muted)]">{premiumLabel}</dt>
          <dd className="font-medium text-[var(--spx-text)]">{item.credit.toFixed(2)}</dd>
        </div>
        <div>
          <dt className="text-[var(--spx-muted)]">Max Risk</dt>
          <dd className="font-medium text-[var(--spx-text)]">{item.maxRisk.toFixed(2)}</dd>
        </div>
        <div>
          <dt className="text-[var(--spx-muted)]">POP</dt>
          <dd className="font-medium text-[var(--spx-text)]">{(item.popPct * 100).toFixed(0)}%</dd>
        </div>
      </dl>

      <div className="mt-4 rounded-xl bg-[var(--spx-panel)] p-3">
        <div className="text-xs uppercase tracking-[0.12em] text-[var(--spx-muted)]">Legs</div>
        <ul className="mt-2 space-y-1 text-sm text-[var(--spx-text)]">
          {item.legs.map((leg, idx) => (
            <li key={`${item.strategy}-leg-${idx}`}>{formatOptionLegLine(leg)}</li>
          ))}
        </ul>
      </div>

      {(checklist || criteria.length > 0) && (
        <details className="mt-4 rounded-xl border border-[var(--spx-border)] bg-[var(--spx-panel)] px-3 py-2">
          <summary className="cursor-pointer list-none text-sm font-medium text-[var(--spx-text)]">
            <span className="inline-flex items-center gap-2">
              <span>Checklist</span>
              <span className="rounded-full bg-[var(--spx-surface)] px-2 py-0.5 text-xs text-[var(--spx-muted)]">
                {passedCount}/{totalCount}
              </span>
            </span>
          </summary>
          {checklist ? (
            <div className="mt-3 space-y-3">
              <ChecklistSection title="GLOBAL CHECKLIST" rows={checklist.global} strategy={item.strategy} />
              <ChecklistSection title="REGIME CHECK" rows={checklist.regime} strategy={item.strategy} />
              <ChecklistSection title="STRATEGY CHECKLIST" rows={checklist.strategy} strategy={item.strategy} />
            </div>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {criteria.map((criterion, idx) => (
                <li
                  key={`${item.strategy}-criterion-${idx}`}
                  className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-surface)] px-2.5 py-2"
                >
                  <div className="flex items-start gap-2">
                    <StatusIcon status={criterion.passed ? "pass" : "fail"} />
                    <div className="min-w-0">
                      <p className={`leading-tight ${criterion.passed ? "text-emerald-200" : "text-rose-200"}`}>
                        {criterion.name}
                      </p>
                      {criterion.detail && (
                        <p className="mt-1 text-xs leading-tight text-[var(--spx-muted)]">{criterion.detail}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </Panel>
  );
}

function ChecklistSection({ title, rows, strategy }: { title: string; rows: ChecklistItem[]; strategy: string }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--spx-muted)]">{title}</p>
      <ul className="space-y-2 text-sm">
        {rows.map((row, idx) => (
          <li
            key={`${strategy}-${title}-${idx}`}
            className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-surface)] px-2.5 py-2"
          >
            <div className="flex items-start gap-2">
              <StatusIcon status={row.status} />
              <div className="min-w-0">
                <p className={`leading-tight ${statusTextClass(row.status)}`}>{row.name}</p>
                {row.detail && <p className="mt-1 text-xs leading-tight text-[var(--spx-muted)]">{row.detail}</p>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
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
