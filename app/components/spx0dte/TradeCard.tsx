import Panel from "@/app/components/spx0dte/Panel";
import type { OpenTrade } from "@/lib/spx0dte";
import { formatOptionLegLine } from "@/lib/spx0dte";

type TradeCardProps = {
  trade: OpenTrade;
  onCopyTicket: (trade: OpenTrade) => void;
  onCloseTrade: (trade: OpenTrade) => void;
  closeBusy?: boolean;
};

export default function TradeCard({ trade, onCopyTicket, onCloseTrade, closeBusy = false }: TradeCardProps) {
  const riskImpact = estimateRiskImpact(trade);
  const canCloseInApp = trade.strategy === "2-DTE Credit Spread";
  const statusTone = trade.status === "OPEN" ? "text-emerald-300" : trade.status === "EXIT_PENDING" ? "text-amber-300" : "text-[var(--spx-muted)]";

  return (
    <Panel as="article" className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[var(--spx-text)]">{trade.strategy}</p>
          <p className="text-xs text-[var(--spx-muted)]">Entry {trade.entryEt} ET</p>
        </div>
        <span className={`text-xs font-medium ${statusTone}`}>{trade.status}</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-5">
        <MiniStat label="Width" value={estimateWidth(trade)} />
        <MiniStat label="Credit" value={trade.initialCredit.toFixed(2)} />
        <MiniStat label="Current P/L" value={`${(trade.plPct * 100).toFixed(0)}%`} />
        <MiniStat label="Risk impact" value={riskImpact} />
        <MiniStat label="POP" value={`${(trade.popPct * 100).toFixed(0)}%`} />
      </div>

      <details className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2">
        <summary className="cursor-pointer text-xs text-[var(--spx-muted)]">Actions</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => onCopyTicket(trade)} className="btn text-xs">
            Copy order ticket
          </button>
          <button
            type="button"
            onClick={() => onCloseTrade(trade)}
            disabled={!canCloseInApp || closeBusy}
            title={canCloseInApp ? "Close tracked paper trade" : "Manual close via broker"}
            className="btn text-xs"
          >
            {closeBusy ? "Closing..." : "Close trade"}
          </button>
        </div>

        <ul className="mt-2 space-y-1 text-xs text-[var(--spx-text)]">
          {trade.legs.map((leg, idx) => (
            <li key={`${trade.id}-${idx}`}>{formatOptionLegLine(leg)}</li>
          ))}
        </ul>
      </details>
    </Panel>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--spx-muted)]">{label}</p>
      <p className="text-sm text-[var(--spx-text)]">{value}</p>
    </div>
  );
}

function estimateWidth(trade: OpenTrade): string {
  const strikes = trade.legs.map((leg) => Number(leg.strike)).filter((v) => Number.isFinite(v));
  if (strikes.length < 2) return "-";
  const min = Math.min(...strikes);
  const max = Math.max(...strikes);
  const width = Math.max(0, max - min);
  return width > 0 ? width.toFixed(0) : "-";
}

function estimateRiskImpact(trade: OpenTrade): string {
  const widths: number[] = [];
  const callsSell = trade.legs.find((leg) => leg.action === "SELL" && leg.type === "CALL")?.strike;
  const callsBuy = trade.legs.find((leg) => leg.action === "BUY" && leg.type === "CALL")?.strike;
  if (callsSell != null && callsBuy != null) widths.push(Math.abs(callsBuy - callsSell));

  const putsSell = trade.legs.find((leg) => leg.action === "SELL" && leg.type === "PUT")?.strike;
  const putsBuy = trade.legs.find((leg) => leg.action === "BUY" && leg.type === "PUT")?.strike;
  if (putsSell != null && putsBuy != null) widths.push(Math.abs(putsBuy - putsSell));

  const width = widths.length > 0 ? Math.max(...widths) : Number.NaN;
  if (!Number.isFinite(width)) return "-";
  const risk = Math.max(0, width - Math.max(0, trade.initialCredit));
  return `${risk.toFixed(2)}`;
}
