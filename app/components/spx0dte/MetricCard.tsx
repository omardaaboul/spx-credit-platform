type MetricCardProps = {
  title: string;
  value: string;
  delta?: string;
  tone?: "neutral" | "good" | "risk";
  helpText?: string;
};

export default function MetricCard({ title, value, delta, tone = "neutral", helpText }: MetricCardProps) {
  const toneClass = tone === "good" ? "text-emerald-500" : tone === "risk" ? "text-rose-500" : "text-[var(--spx-muted)]";

  return (
    <article className="rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-5 shadow-[0_1px_1px_rgba(0,0,0,.03)]">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-[var(--spx-muted)]">
        <span>{title}</span>
        {helpText && (
          <span className="group relative inline-flex">
            <span
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--spx-border)] text-[10px] leading-none text-[var(--spx-muted)]"
              tabIndex={0}
              aria-label={`${title} information`}
            >
              i
            </span>
            <span className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-20 hidden w-56 -translate-x-1/2 rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1.5 text-[11px] normal-case leading-snug tracking-normal text-[var(--spx-text)] shadow-lg group-hover:block group-focus-within:block">
              {helpText}
            </span>
          </span>
        )}
      </div>
      <div className="mt-2 text-3xl font-semibold text-[var(--spx-text)] tabular-nums">{value}</div>
      {delta ? <div className={`mt-2 text-sm ${toneClass}`}>{delta}</div> : <div className="mt-2 h-5" />}
    </article>
  );
}
