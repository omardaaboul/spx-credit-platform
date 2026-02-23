import type { ReadinessSummary } from "@/lib/readiness";

function chipClass(state: "good" | "warn" | "bad") {
  if (state === "good") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (state === "warn") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-rose-500/40 bg-rose-500/10 text-rose-300";
}

type LiveStateRibbonProps = {
  summary: ReadinessSummary;
  marketOpen: boolean;
  dataAgeSeconds: number | null | undefined;
  regime: string | undefined;
  favoredStrategy: string | undefined;
  sleeveCapital: number;
  openRisk: number;
  maxOpenRisk: number;
  dayPnl: number;
  weekPnl: number;
  lockState: "OFF" | "DAILY" | "WEEKLY" | "RISK LOCK";
  dataContractStatus: "healthy" | "degraded" | "inactive" | undefined;
};

export default function LiveStateRibbon({
  summary,
  marketOpen,
  dataAgeSeconds,
  regime,
  favoredStrategy,
  sleeveCapital,
  openRisk,
  maxOpenRisk,
  dayPnl,
  weekPnl,
  lockState,
  dataContractStatus,
}: LiveStateRibbonProps) {
  const marketState: "good" | "warn" | "bad" = marketOpen
    ? summary.dataFreshness === "live"
      ? "good"
      : summary.dataFreshness === "stale"
        ? "warn"
        : "bad"
    : "warn";

  const riskPct = maxOpenRisk > 0 ? (openRisk / maxOpenRisk) * 100 : 0;
  const openRiskState: "good" | "warn" | "bad" =
    riskPct >= 100 ? "bad" : riskPct >= 75 ? "warn" : "good";

  const lockStateTone: "good" | "warn" | "bad" =
    lockState === "OFF" ? "good" : lockState === "RISK LOCK" ? "bad" : "warn";

  const dataContractTone: "good" | "warn" | "bad" =
    dataContractStatus === "healthy"
      ? "good"
      : dataContractStatus === "degraded"
        ? "bad"
        : "warn";
  const dataContractLabel =
    dataContractStatus === "healthy"
      ? "OK"
      : dataContractStatus === "degraded"
        ? "DEGRADED"
        : "INACTIVE (MARKET CLOSED)";

  return (
    <section className="sticky top-[58px] z-30 border-b border-[var(--spx-border)] bg-[var(--spx-surface)]/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-5 py-2 text-xs xl:px-8">
        <Chip
          label="MARKET"
          value={`${marketOpen ? "Open" : "Closed"} · ${dataAgeSeconds == null ? "age -" : `age ${dataAgeSeconds}s`}`}
          tone={marketState}
        />
        <Chip
          label="REGIME"
          value={`${regime ?? "-"}${favoredStrategy ? ` · ${favoredStrategy}` : ""}`}
          tone={summary.gates.find((gate) => gate.key === "regime")?.state === "pass" ? "good" : "warn"}
        />
        <Chip label="SLEEVE" value={`$${Math.round(sleeveCapital)}`} tone="good" />
        <Chip
          label="OPEN RISK"
          value={`$${Math.round(openRisk)} / $${Math.round(maxOpenRisk)}`}
          tone={openRiskState}
        />
        <Chip label="DAY P/L" value={`${dayPnl.toFixed(0)}`} tone={dayPnl < 0 ? "warn" : "good"} />
        <Chip label="WEEK P/L" value={`${weekPnl.toFixed(0)}`} tone={weekPnl < 0 ? "warn" : "good"} />
        <Chip label="LOCK" value={lockState} tone={lockStateTone} />
        <Chip
          label="DATA CONTRACT"
          value={dataContractLabel}
          tone={dataContractTone}
        />
      </div>
    </section>
  );
}

function Chip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "good" | "warn" | "bad";
}) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${chipClass(tone)}`}>
      <span className="uppercase tracking-[0.08em]">{label}</span>
      <span className="text-[var(--spx-text)]/90">{value}</span>
    </span>
  );
}
