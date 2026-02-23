"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  buildExpirationPayoffCurve,
  computeBreakeven,
  computeCurrentPnlFromMark,
  computeMaxLoss,
  computeMaxProfit,
  type CreditSpreadInput,
  type CreditSpreadSide,
} from "@/lib/options/payoff";
import { computePopAndTouch } from "@/lib/options/probability";

export type TradeVisualizerInput = {
  id: string;
  label: string;
  side: CreditSpreadSide;
  shortStrike: number;
  longStrike: number;
  credit: number;
  width: number;
  contracts?: number;
  multiplier?: number;
  dte?: number | null;
  expiry?: string | null;
  ivAtm?: number | null;
  entryUnderlying?: number | null;
  currentSpot?: number | null;
  currentMark?: number | null;
  rangePct?: number;
};

type TradeVisualizerProps = {
  open: boolean;
  onClose: () => void;
  input: TradeVisualizerInput | null;
};

export default function TradeVisualizer({ open, onClose, input }: TradeVisualizerProps) {
  const spread = useMemo<CreditSpreadInput | null>(() => {
    if (!input) return null;
    if (![input.shortStrike, input.longStrike, input.credit, input.width].every((n) => Number.isFinite(Number(n)))) {
      return null;
    }
    return {
      side: input.side,
      shortStrike: Number(input.shortStrike),
      longStrike: Number(input.longStrike),
      credit: Number(input.credit),
      width: Number(input.width),
      contracts: Number.isFinite(Number(input.contracts)) ? Number(input.contracts) : 1,
      multiplier: Number.isFinite(Number(input.multiplier)) ? Number(input.multiplier) : 100,
    };
  }, [input]);

  const spotForRange = useMemo(() => {
    if (!input) return null;
    const s = [input.currentSpot, input.entryUnderlying, input.shortStrike].find(
      (v) => v != null && Number.isFinite(Number(v)) && Number(v) > 0,
    );
    return s == null ? null : Number(s);
  }, [input]);

  const curve = useMemo(() => {
    if (!spread || spotForRange == null) return [];
    return buildExpirationPayoffCurve(spread, spotForRange, input?.rangePct ?? 0.12, 120);
  }, [spread, spotForRange, input?.rangePct]);

  const stats = useMemo(() => {
    if (!spread) return null;
    const maxProfit = computeMaxProfit(spread);
    const maxLoss = computeMaxLoss(spread);
    const breakeven = computeBreakeven(spread);
    const dte = input?.dte ?? null;
    const iv = input?.ivAtm ?? null;
    const spot = input?.currentSpot ?? input?.entryUnderlying ?? null;
    const probs =
      spot != null
        ? computePopAndTouch({
            spread,
            spot,
            dte,
            iv,
          })
        : { pop: null, probabilityOfTouch: null, probItmShort: null, confidence: "LOW" as const, warning: "PoP unavailable: missing spot." };

    const currentPnl =
      input?.currentMark != null && Number.isFinite(Number(input.currentMark))
        ? computeCurrentPnlFromMark(spread, Number(input.currentMark))
        : null;

    return {
      maxProfit,
      maxLoss,
      breakeven,
      probs,
      currentPnl,
    };
  }, [spread, input]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70]">
      <button type="button" className="absolute inset-0 bg-black/35" onClick={onClose} aria-label="Close trade visualizer" />
      <aside className="absolute right-0 top-0 h-full w-full max-w-4xl border-l border-[var(--spx-border)] bg-[var(--spx-bg)] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--spx-text)]">Trade Visualizer</h2>
            <p className="text-xs text-[var(--spx-muted)]">Expiration payoff profile</p>
          </div>
          <button type="button" onClick={onClose} className="btn h-8 px-3 text-xs">
            Close
          </button>
        </div>

        {!input || !spread || !stats ? (
          <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-3 text-sm text-[var(--spx-muted)]">
            Missing spread inputs. Unable to render trade graph.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold text-[var(--spx-text)]">{input.label}</p>
                <p className="text-xs text-[var(--spx-muted)]">
                  {input.expiry ? `Exp ${input.expiry}` : "Expiry -"}
                  {input.dte != null ? ` · DTE ${input.dte}` : ""}
                </p>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
                <Stat label="Max profit" value={formatDollars(stats.maxProfit)} />
                <Stat label="Max loss" value={formatDollars(-Math.abs(stats.maxLoss))} />
                <Stat label="Breakeven" value={stats.breakeven.toFixed(2)} />
                <Stat label="PoP" value={stats.probs.pop == null ? "-" : `${(stats.probs.pop * 100).toFixed(1)}%`} />
                <Stat
                  label="Prob touch"
                  value={stats.probs.probabilityOfTouch == null ? "-" : `${(stats.probs.probabilityOfTouch * 100).toFixed(1)}%`}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-[var(--spx-muted)]">
                <span>Short {input.shortStrike.toFixed(2)}</span>
                <span>Long {input.longStrike.toFixed(2)}</span>
                <span>Credit {input.credit.toFixed(2)}</span>
                <span>Width {input.width.toFixed(2)}</span>
                <span>Contracts {Math.max(1, Math.round(input.contracts ?? 1))}</span>
                {input.currentMark != null && Number.isFinite(input.currentMark) && (
                  <span>Current mark {Number(input.currentMark).toFixed(2)}</span>
                )}
              </div>
            </div>

            <div className="h-[420px] rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={curve} margin={{ top: 14, right: 20, left: 20, bottom: 14 }}>
                  <CartesianGrid stroke="var(--spx-border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="x"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(v) => Number(v).toFixed(0)}
                    stroke="var(--spx-muted)"
                  />
                  <YAxis
                    dataKey="y"
                    type="number"
                    domain={["auto", "auto"]}
                    tickFormatter={(v) => `${Math.round(Number(v))}`}
                    stroke="var(--spx-muted)"
                  />
                  <Tooltip
                    formatter={(value, name) => [formatDollars(Number(value ?? 0)), name === "y" ? "P/L" : String(name)]}
                    labelFormatter={(label) => `SPX ${Number(label).toFixed(2)}`}
                  />
                  <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
                  <ReferenceLine x={stats.breakeven} stroke="#f97316" strokeDasharray="4 4" label={{ value: "BE", fill: "#f97316", position: "top" }} />
                  <ReferenceLine x={input.shortStrike} stroke="#dc2626" strokeDasharray="3 3" label={{ value: "Short", fill: "#dc2626", position: "top" }} />
                  <ReferenceLine x={input.longStrike} stroke="#2563eb" strokeDasharray="3 3" label={{ value: "Long", fill: "#2563eb", position: "top" }} />
                  {input.currentSpot != null && Number.isFinite(input.currentSpot) && (
                    <ReferenceLine
                      x={Number(input.currentSpot)}
                      stroke="#14b8a6"
                      strokeDasharray="2 2"
                      label={{ value: "Spot", fill: "#14b8a6", position: "insideTopRight" }}
                    />
                  )}
                  {input.currentSpot != null && stats.currentPnl != null && Number.isFinite(stats.currentPnl) && (
                    <ReferenceDot x={Number(input.currentSpot)} y={stats.currentPnl} r={4} fill="#14b8a6" stroke="none" />
                  )}
                  <Line type="monotone" dataKey="y" stroke="#2563eb" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <p className="text-xs text-[var(--spx-muted)]">
              PoP is an approximation from IV.
              {stats.probs.confidence ? ` Confidence: ${stats.probs.confidence}.` : ""}
              {stats.probs.warning ? ` ${stats.probs.warning}` : ""}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--spx-border)] bg-[var(--spx-bg)] px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--spx-muted)]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[var(--spx-text)]">{value}</p>
    </div>
  );
}

function formatDollars(value: number): string {
  const sign = value >= 0 ? "" : "-";
  return `${sign}$${Math.abs(value).toFixed(0)}`;
}
