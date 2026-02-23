"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PricePoint, VolPoint } from "@/lib/spx0dte";

type MarketChartsProps = {
  priceSeries: PricePoint[];
  volSeries: VolPoint[];
};

export default function MarketCharts({ priceSeries, volSeries }: MarketChartsProps) {
  const [mounted, setMounted] = useState(false);
  // Recharts depends on client-only layout measurement.
   
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <section className="grid gap-4 lg:grid-cols-2">
        <article className="min-w-0 rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-4">
          <h3 className="mb-3 text-sm font-semibold text-[var(--spx-text)]">SPX Price vs VWAP</h3>
          <div className="h-[260px] rounded-lg bg-[var(--spx-panel)]" />
        </article>
        <article className="min-w-0 rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-4">
          <h3 className="mb-3 text-sm font-semibold text-[var(--spx-text)]">Volatility Profile</h3>
          <div className="h-[260px] rounded-lg bg-[var(--spx-panel)]" />
        </article>
      </section>
    );
  }

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <article className="min-w-0 rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--spx-text)]">
          <span>SPX Price vs VWAP</span>
          <span className="group relative inline-flex">
            <span
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--spx-border)] text-[10px] leading-none text-[var(--spx-muted)]"
              tabIndex={0}
              aria-label="SPX vs VWAP information"
            >
              i
            </span>
            <span className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-20 hidden w-64 -translate-x-1/2 rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1.5 text-[11px] font-normal leading-snug text-[var(--spx-text)] shadow-lg group-hover:block group-focus-within:block">
              Above VWAP suggests bullish intraday bias; below VWAP suggests bearish bias. Smaller distance is generally better for neutral premium selling.
            </span>
          </span>
        </h3>
        <div className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={280} minHeight={220}>
            <LineChart data={priceSeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--spx-grid)" vertical={false} />
              <XAxis dataKey="t" tick={{ fill: "var(--spx-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fill: "var(--spx-muted)", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={56}
                domain={["dataMin - 5", "dataMax + 5"]}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--spx-surface)",
                  border: "1px solid var(--spx-border)",
                  borderRadius: "10px",
                  color: "var(--spx-text)",
                }}
              />
              <Legend wrapperStyle={{ color: "var(--spx-muted)", fontSize: 12 }} />
              <Line type="monotone" dataKey="price" stroke="var(--spx-accent)" dot={false} strokeWidth={2} name="SPX" />
              <Line type="monotone" dataKey="vwap" stroke="var(--spx-muted)" dot={false} strokeWidth={1.8} name="VWAP" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </article>

      <article className="min-w-0 rounded-2xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--spx-text)]">
          <span>Volatility Profile</span>
          <span className="group relative inline-flex">
            <span
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--spx-border)] text-[10px] leading-none text-[var(--spx-muted)]"
              tabIndex={0}
              aria-label="Volatility profile information"
            >
              i
            </span>
            <span className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-20 hidden w-64 -translate-x-1/2 rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1.5 text-[11px] font-normal leading-snug text-[var(--spx-text)] shadow-lg group-hover:block group-focus-within:block">
              Lower 15m Range/EMR and ATR are calmer conditions. Rising bars indicate higher intraday risk and potential exit pressure.
            </span>
          </span>
        </h3>
        <div className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={280} minHeight={220}>
            <BarChart data={volSeries} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--spx-grid)" vertical={false} />
              <XAxis dataKey="t" tick={{ fill: "var(--spx-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "var(--spx-muted)", fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                contentStyle={{
                  background: "var(--spx-surface)",
                  border: "1px solid var(--spx-border)",
                  borderRadius: "10px",
                  color: "var(--spx-text)",
                }}
              />
              <Legend wrapperStyle={{ color: "var(--spx-muted)", fontSize: 12 }} />
              <Bar dataKey="rangePctEm" name="15m Range/EMR" fill="var(--spx-accent)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="atr" name="ATR(1m)" fill="var(--spx-muted)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </article>
    </section>
  );
}
