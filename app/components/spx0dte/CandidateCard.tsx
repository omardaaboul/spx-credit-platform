import { useState } from "react";
import { Calendar, ChevronDown, ChevronUp, Info, TrendingUp } from "lucide-react";
import Panel from "@/app/components/spx0dte/Panel";
import type { CandidateCard as CandidateCardType } from "@/lib/spx0dte";
import { formatOptionLegLine } from "@/lib/spx0dte";

type CandidateCardProps = {
  candidate: CandidateCardType | null;
  blocked: boolean;
  blockedReason?: string | null;
  riskImpactText: string;
  capacityText: string;
  onOpenChecklist: () => void;
  onOpenDetails: () => void;
  onCopyOrderTicket: () => void;
  onOpenPayoff: () => void;
  onPlacePaperTrade: () => void;
  placeDisabled: boolean;
  placing: boolean;
  copyState: "idle" | "ok" | "error";
  paperState: "idle" | "sending" | "ok" | "error";
  paperMessage?: string;
  hiddenDetailLine?: string;
  dataQualityPass?: boolean;
  greeksData?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    iv?: number;
  };
};

export default function CandidateCard({
  candidate,
  blocked,
  blockedReason,
  riskImpactText,
  capacityText,
  onOpenChecklist,
  onOpenDetails,
  onCopyOrderTicket,
  onOpenPayoff,
  onPlacePaperTrade,
  placeDisabled,
  placing,
  copyState,
  paperState,
  paperMessage,
  hiddenDetailLine,
  dataQualityPass = true,
  greeksData,
}: CandidateCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const stateLabel = blocked ? "NOT READY" : candidate?.ready ? "READY" : "NOT READY";
  const stateClass = blocked
    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
    : candidate?.ready
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : "border-[var(--spx-border)] bg-[var(--spx-panel)] text-[var(--spx-muted)]";

  const premiumLabel = candidate?.premiumLabel ?? (candidate?.strategy === "Convex Debit Spread" ? "Debit" : "Credit");
  const premiumValue = candidate ? (candidate.adjustedPremium ?? candidate.credit).toFixed(2) : "-";
  const dte = candidate?.daysToExpiry ?? extractDte(candidate?.strategy);
  const message = blocked
    ? `Not ready: ${blockedReason ?? "Status gate active."}`
    : candidate?.ready
      ? "Ready for execution."
      : `Waiting: ${blockedReason ?? "criteria alignment in progress."}`;
  const canPlace = !placeDisabled && dataQualityPass;

  return (
    <Panel as="article" className={`space-y-3 p-4 ${blocked ? "opacity-85" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.12em] text-[var(--spx-muted)]">Potential Trade Candidate</p>
          <h2 className="text-lg font-semibold text-[var(--spx-text)]">{candidate?.strategy ?? "No eligible strategy right now"}</h2>
          {dte > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-0.5">
              <Calendar className={`h-3.5 w-3.5 ${dte <= 2 ? "text-rose-400" : dte <= 14 ? "text-amber-400" : "text-blue-400"}`} />
              <span className="text-[11px] font-medium text-[var(--spx-muted)]">{dte} DTE</span>
            </div>
          )}
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${stateClass}`}>{stateLabel}</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Stat label={premiumLabel} value={premiumValue} />
        <Stat label="Setup Mode" value={riskImpactText.replace("Risk impact: ", "")} />
      </div>

      <div className="space-y-1 text-sm text-[var(--spx-muted)]">
        <p>{message}</p>
        <p>{capacityText}</p>
        {!dataQualityPass && <p className="text-rose-300">Data quality check failed. Waiting for fresh/complete feed.</p>}
        {!candidate?.ready && (
          <button type="button" onClick={onOpenDetails} className="text-xs text-[var(--spx-accent)] hover:underline">
            Why not ready?
          </button>
        )}
      </div>

      {greeksData?.delta != null && (
        <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
          <div className="mb-2 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-[var(--spx-accent)]" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--spx-muted)]">Greeks Snapshot</span>
          </div>
          <div className="grid grid-cols-5 gap-2 text-xs">
            <GreekCell label="Delta" value={fmt(greeksData.delta, 3)} />
            <GreekCell label="Gamma" value={fmt(greeksData.gamma, 3)} />
            <GreekCell label="Theta" value={fmt(greeksData.theta, 2)} />
            <GreekCell label="Vega" value={fmt(greeksData.vega, 2)} />
            <GreekCell label="IV" value={greeksData.iv != null ? `${(greeksData.iv * 100).toFixed(1)}%` : "-"} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onOpenChecklist} className="btn text-xs">
          Open Checklist
        </button>
        <button type="button" onClick={onPlacePaperTrade} disabled={!canPlace} className="btn text-xs">
          {placing ? "Placing..." : !dataQualityPass ? "Data Check Failed" : "Place Trade"}
        </button>
        {paperState === "ok" && <span className="self-center text-xs text-emerald-400">Submitted</span>}
        {paperState === "error" && <span className="self-center text-xs text-rose-400">Failed</span>}
      </div>

      <button
        type="button"
        onClick={() => setShowDetails((prev) => !prev)}
        className="inline-flex items-center gap-2 text-sm font-medium text-[var(--spx-muted)] transition-colors hover:text-[var(--spx-text)]"
      >
        <Info className="h-4 w-4" />
        {showDetails ? "Hide" : "Show"} Details
        {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      {showDetails && (
        <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-3">
          <div className="space-y-2 text-sm text-[var(--spx-muted)]">
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="Width" value={candidate ? String(candidate.width) : "-"} />
            <Stat label="PoP" value={formatPct(candidate?.popPct, 0)} />
            <Stat label="RoR" value={formatPct(candidate?.ror, 2)} />
            <Stat label="Max Profit" value={formatDollars(candidate?.maxProfit)} />
            <Stat label="Max Loss" value={formatDollars(candidate?.maxLoss)} />
            <Stat label="Breakeven" value={formatBreakeven(candidate)} />
            <Stat label="EV" value={formatDollars(candidate?.ev)} />
            <Stat label="EV/Risk" value={formatPct(candidate?.evRor, 2)} />
            <Stat label="State" value={candidate?.ready ? "READY" : "PENDING"} />
          </div>
          {hiddenDetailLine && <p className="text-xs">{hiddenDetailLine}</p>}

          <ul className="space-y-1 text-xs text-[var(--spx-text)]">
            {candidate && candidate.legs.length > 0 ? (
              candidate.legs.map((leg, idx) => <li key={`${candidate.strategy}-${idx}`}>{formatOptionLegLine(leg)}</li>)
            ) : (
              <li className="text-[var(--spx-muted)]">No legs available.</li>
            )}
          </ul>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onCopyOrderTicket} disabled={!candidate} className="btn text-xs">
              Copy Ticket
            </button>
            <button type="button" onClick={onOpenPayoff} disabled={!candidate} className="btn text-xs">
              Payoff
            </button>
            {copyState === "ok" && <span className="self-center text-xs text-emerald-400">Copied</span>}
            {copyState === "error" && <span className="self-center text-xs text-rose-400">Copy failed</span>}
          </div>
        </div>
      </div>
      )}

      {paperMessage && <p className="text-xs text-[var(--spx-muted)]">{paperMessage}</p>}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--spx-muted)]">{label}</p>
      <p className="text-sm font-semibold text-[var(--spx-text)]">{value}</p>
    </div>
  );
}

function GreekCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[var(--spx-muted)]">{label}</div>
      <div className="font-mono font-semibold text-[var(--spx-text)]">{value}</div>
    </div>
  );
}

function extractDte(strategy?: string): number {
  if (!strategy) return 0;
  const m = strategy.match(/(\d+)-DTE/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function fmt(value: number | undefined, decimals: number): string {
  return value == null || !Number.isFinite(value) ? "-" : value.toFixed(decimals);
}

function formatPct(value: number | null | undefined, decimals = 0): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(decimals)}%`;
}

function formatDollars(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatBreakeven(candidate: CandidateCardType | null | undefined): string {
  if (!candidate) return "-";
  if (candidate.breakeven != null && Number.isFinite(candidate.breakeven)) {
    return candidate.breakeven.toFixed(2);
  }
  if (
    candidate.breakevenLow != null &&
    candidate.breakevenHigh != null &&
    Number.isFinite(candidate.breakevenLow) &&
    Number.isFinite(candidate.breakevenHigh)
  ) {
    return `${candidate.breakevenLow.toFixed(2)}–${candidate.breakevenHigh.toFixed(2)}`;
  }
  return "-";
}
