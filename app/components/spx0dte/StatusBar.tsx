import Panel from "@/app/components/spx0dte/Panel";

type StatusBarProps = {
  marketOpen: boolean;
  dataAgeSeconds?: number | null;
  dayPnl: number;
  weekPnl: number;
  dataContractStatus?: "healthy" | "degraded" | "inactive";
  alertCount: number;
  onOpenAlerts: () => void;
};

function toneClass(state: "good" | "warn" | "bad") {
  if (state === "good") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (state === "warn") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-rose-500/40 bg-rose-500/10 text-rose-300";
}

export default function StatusBar({
  marketOpen,
  dataAgeSeconds,
  dayPnl,
  weekPnl,
  dataContractStatus,
  alertCount,
  onOpenAlerts,
}: StatusBarProps) {
  const marketTone: "good" | "warn" | "bad" = marketOpen ? (dataAgeSeconds != null && dataAgeSeconds > 20 ? "warn" : "good") : "warn";
  const contractTone: "good" | "warn" | "bad" =
    dataContractStatus === "healthy" ? "good" : dataContractStatus === "degraded" ? "bad" : "warn";
  const contractLabel =
    dataContractStatus === "healthy"
      ? "OK"
      : dataContractStatus === "degraded"
        ? "Degraded"
        : "Inactive (market closed)";

  return (
    <Panel className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Chip
          label="Market"
          value={`${marketOpen ? "Open" : "Closed"}${dataAgeSeconds == null ? "" : ` · ${dataAgeSeconds}s`}`}
          tone={marketTone}
        />
        <Chip label="Day" value={`${dayPnl.toFixed(0)}`} tone={dayPnl < 0 ? "warn" : "good"} />
        <Chip label="Week" value={`${weekPnl.toFixed(0)}`} tone={weekPnl < 0 ? "warn" : "good"} />
        <Chip
          label="Data"
          value={contractLabel}
          tone={contractTone}
        />

        <button type="button" onClick={onOpenAlerts} className="btn ml-auto h-7 px-2 text-xs">
          🔔 {alertCount}
        </button>
      </div>
    </Panel>
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
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${toneClass(tone)}`}>
      <span className="uppercase tracking-[0.08em]">{label}</span>
      <span className="text-[var(--spx-text)]/90">{value}</span>
    </span>
  );
}
