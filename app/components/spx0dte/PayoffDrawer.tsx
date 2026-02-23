"use client";

import { useEffect, useMemo, useState } from "react";
import type { ThemeMode } from "@/app/components/spx0dte/types";
import PayoffChart from "@/app/components/spx0dte/PayoffChart";
import {
  buildPayoffSeriesWithConfig,
  computeBreakevens,
  computeMaxProfitLoss,
  buildTodayPayoffSeries,
  DEFAULT_CONTRACT_MULTIPLIER,
  type PayoffCandidate,
} from "@/lib/payoff";

type PayoffDrawerProps = {
  open: boolean;
  onClose: () => void;
  candidate: PayoffCandidate | null;
  theme: ThemeMode;
};

export default function PayoffDrawer({ open, onClose, candidate, theme }: PayoffDrawerProps) {
  const [showEmrBand, setShowEmrBand] = useState(true);
  const [showT0Curve, setShowT0Curve] = useState(false);

  const hasPremiums = useMemo(() => {
    if (!candidate) return false;
    if (!candidate.legs.length) return false;
    return candidate.legs.every((leg) => Number.isFinite(leg.premium));
  }, [candidate]);

  const computed = useMemo(() => {
    if (!candidate || !hasPremiums) return null;
    const series = buildPayoffSeriesWithConfig(candidate, DEFAULT_CONTRACT_MULTIPLIER);
    const breakevens = computeBreakevens(series.x, series.y).map((point) => point.price);
    const extremes = computeMaxProfitLoss(series.y);
    return { ...series, breakevens, ...extremes };
  }, [candidate, hasPremiums]);

  const todaySeries = useMemo(() => {
    if (!candidate || !hasPremiums) return null;
    return buildTodayPayoffSeries(candidate, DEFAULT_CONTRACT_MULTIPLIER);
  }, [candidate, hasPremiums]);

  const canShowT0 = Boolean(todaySeries && todaySeries.y.length > 0);

  // Keep toggle state coherent when model inputs disappear.
   
  useEffect(() => {
    if (!canShowT0 && showT0Curve) {
      setShowT0Curve(false);
    }
  }, [canShowT0, showT0Curve]);
   

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/35" aria-label="Close payoff drawer" />
      <aside className="absolute right-0 top-0 h-full w-full max-w-3xl border-l border-[var(--spx-border)] bg-[var(--spx-bg)] p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--spx-text)]">Payoff Diagram</h2>
            <p className="text-xs text-[var(--spx-muted)]">Expiration P/L profile for the selected setup</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn text-xs"
          >
            Close
          </button>
        </div>

        {!candidate && (
          <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-3 py-2 text-sm text-[var(--spx-muted)]">
            No eligible strategy candidate available.
          </div>
        )}

        {candidate && !hasPremiums && (
          <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
            Missing leg premiums. Payoff chart is blocked until live option premium data is available.
          </div>
        )}

        {candidate && computed && (
          <div className="space-y-3">
            <section className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Max Profit" value={`$${computed.maxProfit.toFixed(0)}`} />
              <Stat label="Max Loss" value={`$${computed.maxLoss.toFixed(0)}`} />
              <Stat
                label="Breakevens"
                value={computed.breakevens.length ? computed.breakevens.map((v) => v.toFixed(1)).join(" / ") : "-"}
              />
              <Stat
                label={candidate.netCredit >= 0 ? "Credit" : "Debit"}
                value={`$${Math.abs(candidate.netCredit).toFixed(2)}`}
              />
              <Stat label="Width" value={candidate.width ? String(candidate.width) : "-"} />
              <Stat label="Spot" value={candidate.spot.toFixed(2)} />
            </section>

            <PayoffChart
              x={computed.x}
              y={computed.y}
              yToday={showT0Curve && todaySeries ? todaySeries.y : null}
              spot={candidate.spot}
              emr={candidate.emr}
              legs={candidate.legs}
              breakevens={computed.breakevens}
              showEmrBand={showEmrBand}
              theme={theme}
            />

            <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-3 py-2 text-xs text-[var(--spx-muted)]">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  Short strike
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  Long strike
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-orange-400" />
                  Breakeven
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-violet-400" />
                  Spot
                </span>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 text-[var(--spx-text)]">
                <input
                  type="checkbox"
                  checked={showEmrBand}
                  onChange={(e) => setShowEmrBand(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[var(--spx-border)] bg-[var(--spx-bg)]"
                />
                Show EMR band
              </label>
              <label
                className={`inline-flex items-center gap-2 ${
                  canShowT0 ? "cursor-pointer text-[var(--spx-text)]" : "cursor-not-allowed text-[var(--spx-muted)]/70"
                }`}
                title={canShowT0 ? "Model-based same-day curve" : "IV/time inputs missing for T+0 curve"}
              >
                <input
                  type="checkbox"
                  checked={showT0Curve}
                  disabled={!canShowT0}
                  onChange={(e) => setShowT0Curve(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-[var(--spx-border)] bg-[var(--spx-bg)] disabled:opacity-50"
                />
                Show T+0 curve (model)
              </label>
            </section>
            {!canShowT0 && (
              <p className="text-xs text-[var(--spx-muted)]">
                T+0 curve unavailable: IV/time inputs missing.
              </p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-2">
      <p className="text-[10px] uppercase tracking-[0.08em] text-[var(--spx-muted)]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[var(--spx-text)]">{value}</p>
    </article>
  );
}
