"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { ThemeMode } from "@/app/components/spx0dte/types";
import type { PayoffLeg } from "@/lib/payoff";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

type PayoffChartProps = {
  x: number[];
  y: number[];
  yToday?: number[] | null;
  spot: number;
  emr: number;
  legs: PayoffLeg[];
  breakevens: number[];
  showEmrBand: boolean;
  theme: ThemeMode;
};

export default function PayoffChart({
  x,
  y,
  yToday,
  spot,
  emr,
  legs,
  breakevens,
  showEmrBand,
  theme,
}: PayoffChartProps) {
  const isDark = theme === "dark";
  const bg = isDark ? "#0D1628" : "#F8FAFC";
  const panel = isDark ? "#0A1424" : "#FFFFFF";
  const grid = isDark ? "#273246" : "#D3DCE7";
  const text = isDark ? "#DFE8F6" : "#111827";
  const muted = isDark ? "#9DB0C8" : "#5B6678";
  const payoff = isDark ? "#7CB6FF" : "#245C9F";
  const emrFill = isDark ? "rgba(124, 182, 255, 0.08)" : "rgba(36, 92, 159, 0.08)";
  const profitFill = isDark ? "rgba(16, 185, 129, 0.12)" : "rgba(16, 185, 129, 0.10)";
  const lossFill = isDark ? "rgba(244, 63, 94, 0.10)" : "rgba(220, 38, 38, 0.08)";
  const todayLine = isDark ? "#C4B5FD" : "#5B21B6";

  const positiveY = y.map((v) => (v > 0 ? v : 0));
  const negativeY = y.map((v) => (v < 0 ? v : 0));

  const markerShapes = useMemo(() => {
    const shapes: Array<Record<string, unknown>> = [];

    if (showEmrBand && emr > 0) {
      shapes.push({
        type: "rect",
        x0: spot - emr,
        x1: spot + emr,
        y0: 0,
        y1: 1,
        yref: "paper",
        line: { width: 0 },
        fillcolor: emrFill,
        layer: "below",
      });
    }

    for (const leg of legs) {
      const color = leg.action === "SELL" ? "#F59E0B" : "#34D399";
      shapes.push({
        type: "line",
        x0: leg.strike,
        x1: leg.strike,
        y0: 0,
        y1: 1,
        yref: "paper",
        line: { color, width: 1, dash: leg.action === "SELL" ? "dot" : "dash" },
      });
    }

    for (const be of breakevens) {
      shapes.push({
        type: "line",
        x0: be,
        x1: be,
        y0: 0,
        y1: 1,
        yref: "paper",
        line: { color: "#F97316", width: 1, dash: "dot" },
      });
    }

    shapes.push({
      type: "line",
      x0: spot,
      x1: spot,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color: "#A78BFA", width: 1 },
    });

    return shapes;
  }, [breakevens, emr, emrFill, legs, showEmrBand, spot]);

  return (
    <div className="h-[360px] w-full rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)]">
      <Plot
        data={[
          {
            x,
            y: positiveY,
            type: "scatter",
            mode: "lines",
            line: { color: "rgba(0,0,0,0)", width: 0 },
            fill: "tozeroy",
            fillcolor: profitFill,
            hoverinfo: "skip",
            name: "Profit zone",
          },
          {
            x,
            y: negativeY,
            type: "scatter",
            mode: "lines",
            line: { color: "rgba(0,0,0,0)", width: 0 },
            fill: "tozeroy",
            fillcolor: lossFill,
            hoverinfo: "skip",
            name: "Loss zone",
          },
          {
            x,
            y,
            type: "scatter",
            mode: "lines",
            line: { color: payoff, width: 2 },
            hovertemplate: "SPX %{x:.2f}<br>P/L $%{y:,.0f}<extra></extra>",
            name: "Expiration",
          },
          ...(yToday
            ? [
                {
                  x,
                  y: yToday,
                  type: "scatter" as const,
                  mode: "lines" as const,
                  line: { color: todayLine, width: 1.5, dash: "dot" as const },
                  hovertemplate: "SPX %{x:.2f}<br>T+0 P/L $%{y:,.0f}<extra></extra>",
                  name: "T+0 model",
                },
              ]
            : []),
          {
            x: [x[0], x[x.length - 1]],
            y: [0, 0],
            type: "scatter",
            mode: "lines",
            line: { color: muted, width: 1, dash: "dot" },
            hoverinfo: "skip",
            name: "Zero line",
          },
        ]}
        layout={{
          autosize: true,
          margin: { l: 52, r: 16, t: 16, b: 40 },
          paper_bgcolor: panel,
          plot_bgcolor: bg,
          font: { color: text, size: 11 },
          xaxis: {
            title: { text: "Underlying Price (SPX)" },
            showgrid: true,
            gridcolor: grid,
            zeroline: false,
          },
          yaxis: {
            title: { text: "P/L at Expiration ($)" },
            showgrid: true,
            gridcolor: grid,
            zeroline: false,
            tickformat: ",.0f",
          },
          shapes: markerShapes,
          showlegend: true,
          legend: {
            orientation: "h",
            x: 0,
            y: 1.12,
            font: { color: muted, size: 10 },
          },
          hovermode: "x unified",
        }}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler
        config={{ displayModeBar: false, responsive: true }}
      />
    </div>
  );
}
