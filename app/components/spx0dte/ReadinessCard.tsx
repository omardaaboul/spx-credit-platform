import Panel from "@/app/components/spx0dte/Panel";
import type { ReadinessSummary } from "@/lib/readiness";

type ReadinessCardProps = {
  summary: ReadinessSummary;
  onOpenDetails: () => void;
};

export default function ReadinessCard({ summary, onOpenDetails }: ReadinessCardProps) {
  const marketClosed = summary.marketStatus === "closed";
  const health = summary.systemState === "pass" ? "Healthy" : summary.systemState === "degraded" ? "Degraded" : "Warning";
  const primaryBanner = summary.banners[0]?.text ?? "All checks running.";

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.12em] text-[var(--spx-muted)]">Readiness & Health</p>
          <h2 className="text-lg font-semibold text-[var(--spx-text)]">
            {marketClosed ? "⏸ Paused (Market Closed)" : summary.systemState === "pass" ? "✔ Ready" : summary.systemState === "degraded" ? "⚠ Attention" : "✖ Paused"}
          </h2>
        </div>
        <button type="button" onClick={onOpenDetails} className="btn text-xs">
          Details
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <MiniRow label="System" value={health} good={summary.systemState === "pass"} />
        <MiniRow label="Global" value={labelForGate(summary, "global")} good={stateIsGood(summary, "global", marketClosed)} />
        <MiniRow label="Regime" value={labelForGate(summary, "regime")} good={stateIsGood(summary, "regime", marketClosed)} />
      </div>

      <p className="text-sm text-[var(--spx-muted)]">{compress(primaryBanner)}</p>
    </Panel>
  );
}

function MiniRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--spx-muted)]">{label}</p>
      <p className={`text-sm ${good ? "text-emerald-300" : "text-amber-300"}`}>{value}</p>
    </div>
  );
}

function labelForGate(summary: ReadinessSummary, key: string): string {
  const gate = summary.gates.find((g) => g.key === key);
  if (!gate) return "-";
  if (summary.marketStatus === "closed" && (key === "global" || key === "regime")) return "Paused";
  if (gate.state === "pass") return "Pass";
  if (gate.state === "blocked") return "Blocked";
  if (gate.state === "degraded") return "Degraded";
  if (gate.state === "fail") return "Fail";
  return "N/A";
}

function stateIsGood(summary: ReadinessSummary, key: string, marketClosed: boolean): boolean {
  if (marketClosed && (key === "global" || key === "regime")) return true;
  const gate = summary.gates.find((g) => g.key === key);
  return gate?.state === "pass";
}

function compress(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (/market closed/i.test(clean)) return "Paused: Market closed.";
  if (/degraded/i.test(clean)) return "Warning: Required data is degraded.";
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
