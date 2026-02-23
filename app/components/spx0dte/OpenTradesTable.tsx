import Panel from "@/app/components/spx0dte/Panel";
import type { OpenTrade } from "@/lib/spx0dte";
import { formatOptionLegLine } from "@/lib/spx0dte";

type OpenTradesTableProps = {
  rows: OpenTrade[];
  onCloseTrade: (trade: OpenTrade) => void;
  closeBusyId?: string | null;
};

export default function OpenTradesTable({ rows, onCloseTrade, closeBusyId }: OpenTradesTableProps) {
  if (rows.length === 0) {
    return (
      <Panel className="px-3 py-2 text-sm text-[var(--spx-muted)]">
        No open trades.
      </Panel>
    );
  }

  return (
    <Panel className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--spx-text)]">Open Trades</h2>
        <span className="text-xs text-[var(--spx-muted)]">{rows.length} active</span>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[760px] table-fixed border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.08em] text-[var(--spx-muted)]">
              <th className="border-b border-[var(--spx-border)] pb-2 pr-2">Strategy</th>
              <th className="border-b border-[var(--spx-border)] pb-2 pr-2">Entry Credit</th>
              <th className="border-b border-[var(--spx-border)] pb-2 pr-2">Current P/L %</th>
              <th className="border-b border-[var(--spx-border)] pb-2 pr-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((trade, idx) => (
              <tr key={trade.id} className={idx % 2 === 0 ? "bg-[var(--spx-panel)]/35" : ""}>
                <td className="px-1 py-2 text-[var(--spx-text)]">
                  <div className="font-medium">{trade.strategy}</div>
                  <div className="text-[11px] text-[var(--spx-muted)]">{trade.entryEt} ET</div>
                </td>
                <td className="px-1 py-2 text-[var(--spx-text)]">{trade.initialCredit.toFixed(2)}</td>
                <td className="px-1 py-2 text-[var(--spx-text)]">{(trade.plPct * 100).toFixed(0)}%</td>
                <td className="px-1 py-2">
                  <details>
                    <summary className="cursor-pointer text-xs text-[var(--spx-accent)]">Menu</summary>
                    <div className="mt-2 space-y-2">
                      <button
                        type="button"
                        onClick={() => onCloseTrade(trade)}
                        disabled={closeBusyId === trade.id}
                        className="btn h-7 px-2 text-xs"
                      >
                        {closeBusyId === trade.id ? "Closing..." : "Close trade"}
                      </button>
                      <ul className="space-y-1 text-[11px] text-[var(--spx-muted)]">
                        {trade.legs.map((leg, i) => (
                          <li key={`${trade.id}-${i}`}>{formatOptionLegLine(leg)}</li>
                        ))}
                      </ul>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
