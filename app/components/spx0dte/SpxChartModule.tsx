"use client";

import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";

type Tf = "5m" | "30m" | "1h" | "1d";

type ChartCandlePayload = {
  ok: boolean;
  instrument?: "SPX" | "ES";
  dataMode?: "LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE";
  source?: string;
  generatedAtEt?: string | null;
  spot?: number | null;
  dataAgeMs?: {
    spot: number | null;
    candles: number | null;
    chain: number | null;
    greeks: number | null;
  };
  fallbackUsed?: boolean;
  candles?: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
  vwap?: Array<{ time: number; value: number }>;
  indicatorNotice?: string;
  warnings?: string[];
  message?: string;
  diagnostics?: {
    attemptedSources?: string[];
    minBarsHint?: number;
    gotBars?: number;
  };
};

type OverlayLevels = {
  shortStrike?: number | null;
  longStrike?: number | null;
  breakevens?: Array<number | null | undefined>;
};

type Props = {
  selectedDte?: number | null;
  em1sd?: number | null;
  spot?: number | null;
  zScore?: number | null;
  mmcPassed?: boolean | null;
  levels?: OverlayLevels;
};

type PivotZone = { id: string; level: number; type: "support" | "resistance" };
type CandlestickPoint = { time: number; open: number; high: number; low: number; close: number; volume?: number };
type LinePoint = { time: number; value: number };
type HistogramPoint = { time: number; value: number; color: string };
const DEBUG_UI = process.env.NEXT_PUBLIC_SPX0DTE_DEBUG === "true";

declare global {
  interface Window {
    LightweightCharts?: {
      createChart: (el: HTMLElement, options: Record<string, unknown>) => LwChart;
      CandlestickSeries?: unknown;
    };
  }
}

type LwPriceLine = { options?: () => unknown };
type LwLineSeries = {
  setData: (data: LinePoint[]) => void;
};
type LwHistogramSeries = {
  setData: (data: HistogramPoint[]) => void;
};
type LwAnySeries = LwLineSeries | LwHistogramSeries;
type LwCandlestickSeries = {
  setData: (data: CandlestickPoint[]) => void;
  createPriceLine: (options: Record<string, unknown>) => LwPriceLine;
  removePriceLine: (line: LwPriceLine) => void;
};
type LwChart = {
  addCandlestickSeries: (options: Record<string, unknown>) => LwCandlestickSeries;
  addSeries?: (seriesCtor: unknown, options: Record<string, unknown>) => LwCandlestickSeries;
  addLineSeries: (options: Record<string, unknown>) => LwLineSeries;
  addHistogramSeries?: (options: Record<string, unknown>) => LwHistogramSeries;
  removeSeries: (series: LwAnySeries) => void;
  remove: () => void;
};

function calcEma(values: number[], length: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (length + 1);
  const out: number[] = [];
  let ema = values[0];
  for (const value of values) {
    ema = value * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function buildPivotZones(candles: CandlestickPoint[]): PivotZone[] {
  if (candles.length < 7) return [];
  const zones: PivotZone[] = [];
  for (let i = 2; i < candles.length - 2; i += 1) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const next = candles[i + 1];
    if (cur.high > prev.high && cur.high > next.high) {
      zones.push({ id: `r-${i}`, level: cur.high, type: "resistance" });
    }
    if (cur.low < prev.low && cur.low < next.low) {
      zones.push({ id: `s-${i}`, level: cur.low, type: "support" });
    }
  }
  const deduped: PivotZone[] = [];
  for (const zone of zones.reverse()) {
    if (deduped.some((x) => Math.abs(x.level - zone.level) < 1.5)) continue;
    deduped.push(zone);
    if (deduped.length >= 4) break;
  }
  return deduped.reverse();
}

export default function SpxChartModule({ selectedDte, em1sd, spot, zScore, mmcPassed, levels }: Props) {
  const [tf, setTf] = useState<Tf>("5m");
  const showEma20 = true;
  const showEma50 = true;
  const showVwap = false;
  const showSr = true;
  const showEm2 = false;
  const showTradeLines = true;
  const [candles, setCandles] = useState<CandlestickPoint[]>([]);
  const [vwapLine, setVwapLine] = useState<LinePoint[]>([]);
  const [sourceLabel, setSourceLabel] = useState("-");
  const [instrumentLabel, setInstrumentLabel] = useState<"SPX" | "ES">("SPX");
  const [dataMode, setDataMode] = useState<"LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE">("FIXTURE");
  const [generatedAtEt, setGeneratedAtEt] = useState<string | null>(null);
  const [indicatorNotice, setIndicatorNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pinnedZoneIds, setPinnedZoneIds] = useState<string[]>([]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<LwChart | null>(null);
  const candleSeriesRef = useRef<LwCandlestickSeries | null>(null);
  const lineSeriesRefs = useRef<LwAnySeries[]>([]);
  const priceLineRefs = useRef<LwPriceLine[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const queryLimit = tf === "5m" ? 1100 : tf === "30m" ? 1000 : tf === "1h" ? 1000 : 1260;
        if (DEBUG_UI) {
          console.info("[spx-chart] timeframe_change", { tf, queryLimit });
        }
        const res = await fetch(`/api/market/candles?symbol=SPX&tf=${tf}&limit=${queryLimit}`, { cache: "no-store" });
        const payload = (await res.json().catch(() => ({}))) as ChartCandlePayload;
        if (!active) return;

        const nextInstrument = payload.instrument === "ES" ? "ES" : "SPX";
        const nextMode =
          payload.dataMode === "LIVE" ||
          payload.dataMode === "DELAYED" ||
          payload.dataMode === "HISTORICAL" ||
          payload.dataMode === "FIXTURE"
            ? payload.dataMode
            : "FIXTURE";
        setInstrumentLabel(nextInstrument);
        setDataMode(nextMode);
        setSourceLabel(payload.source ?? "-");
        setGeneratedAtEt(payload.generatedAtEt ?? null);
        setIndicatorNotice(payload.indicatorNotice ?? null);
        setWarnings(Array.isArray(payload.warnings) ? payload.warnings.filter((w) => typeof w === "string") : []);

        if (!res.ok || !payload.ok || !Array.isArray(payload.candles) || payload.candles.length === 0) {
          const detail = payload.message ?? `Candle feed unavailable (${res.status}).`;
          const sourceTrace = Array.isArray(payload.diagnostics?.attemptedSources)
            ? payload.diagnostics?.attemptedSources.join(" -> ")
            : "";
          setFetchError(sourceTrace ? `${detail} Sources: ${sourceTrace}` : detail);
          return;
        }
        const deduped = new Map<number, CandlestickPoint>();
        for (const bar of payload.candles) {
          const row: CandlestickPoint = {
            time: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: typeof bar.volume === "number" ? bar.volume : undefined,
          };
          deduped.set(row.time, row);
        }
        const nextCandles = Array.from(deduped.values()).sort((a, b) => a.time - b.time);
        if (nextCandles.length === 0) {
          setFetchError(payload.message ?? "No candle data after dedupe/sanitize.");
          return;
        }
        setCandles(nextCandles);
        setVwapLine(
          (payload.vwap ?? []).map((row) => ({
            time: row.time,
            value: row.value,
          })),
        );
        if (DEBUG_UI) {
          console.info("[spx-chart] payload_ok", {
            tf,
            bars: nextCandles.length,
            instrument: nextInstrument,
            mode: nextMode,
            source: payload.source ?? "-",
          });
        }
        setFetchError(null);
      } catch {
        if (!active) return;
        setFetchError("Failed to load SPX candles.");
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [tf]);

  const autoZones = useMemo(() => buildPivotZones(candles), [candles]);
  const selectedZones = useMemo(() => {
    if (pinnedZoneIds.length === 0) return autoZones.slice(0, 4);
    const pinned = autoZones.filter((zone) => pinnedZoneIds.includes(zone.id));
    const fallback = autoZones.filter((zone) => !pinnedZoneIds.includes(zone.id));
    return [...pinned, ...fallback].slice(0, 4);
  }, [autoZones, pinnedZoneIds]);
  const lastBar = candles.length > 0 ? candles[candles.length - 1] : null;
  const prevBar = candles.length > 1 ? candles[candles.length - 2] : null;
  const change = lastBar && prevBar ? lastBar.close - prevBar.close : null;
  const changePct = lastBar && prevBar && prevBar.close !== 0 ? (change! / prevBar.close) * 100 : null;

  const dangerRatio = (() => {
    if (spot == null || em1sd == null || em1sd <= 0 || levels?.shortStrike == null) return null;
    return Math.abs(spot - levels.shortStrike) / em1sd;
  })();
  const dangerActive = dangerRatio != null && dangerRatio <= 0.75;

  useEffect(() => {
    if (!rootRef.current) return;
    let cancelled = false;

    const loadAndInit = async () => {
      if (!window.LightweightCharts) {
        await new Promise<void>((resolve, reject) => {
          const existing = document.querySelector("script[data-lwc='1']") as HTMLScriptElement | null;
          if (existing) {
            if (window.LightweightCharts) resolve();
            existing.addEventListener("load", () => resolve(), { once: true });
            existing.addEventListener("error", () => reject(new Error("script failed")), { once: true });
            return;
          }
          const script = document.createElement("script");
          // Pin v4 API surface for compatibility with addCandlestickSeries.
          script.src = "https://unpkg.com/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js";
          script.async = true;
          script.dataset.lwc = "1";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("script failed"));
          document.head.appendChild(script);
        }).catch(() => {
          if (!cancelled) setFetchError((prev) => prev ?? "Lightweight chart library unavailable.");
        });
      }

      if (cancelled || !window.LightweightCharts || !rootRef.current) return;
      const root = rootRef.current;
      const chart = window.LightweightCharts.createChart(root, {
        autoSize: true,
        layout: {
          background: { color: "#ffffff" },
          textColor: "#334155",
        },
        grid: {
          vertLines: { color: "#edf2f7" },
          horzLines: { color: "#edf2f7" },
        },
        rightPriceScale: { borderColor: "#dbe2e8" },
        timeScale: { borderColor: "#dbe2e8" },
        crosshair: { mode: 0 },
      });
      const candleOptions = {
        upColor: "#2563EB",
        downColor: "#F97316",
        borderVisible: false,
        wickUpColor: "#1d4ed8",
        wickDownColor: "#c2410c",
      };
      const candleSeries =
        typeof chart.addCandlestickSeries === "function"
          ? chart.addCandlestickSeries(candleOptions)
          : typeof chart.addSeries === "function" && window.LightweightCharts?.CandlestickSeries
            ? chart.addSeries(window.LightweightCharts.CandlestickSeries, candleOptions)
            : null;
      if (!candleSeries) {
        setFetchError((prev) => prev ?? "Chart library loaded but candlestick series API is unavailable.");
        chart.remove();
        return;
      }
      chartRef.current = chart;
      candleSeriesRef.current = candleSeries;
    };

    loadAndInit();

    return () => {
      cancelled = true;
      if (candleSeriesRef.current) {
        for (const line of priceLineRefs.current) {
          candleSeriesRef.current.removePriceLine(line);
        }
      }
      priceLineRefs.current = [];
      const chart = chartRef.current;
      lineSeriesRefs.current.forEach((series) => {
        chart?.removeSeries(series);
      });
      lineSeriesRefs.current = [];
      chart?.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries) return;
    candleSeries.setData(candles);

    lineSeriesRefs.current.forEach((series) => chart.removeSeries(series));
    lineSeriesRefs.current = [];
    for (const line of priceLineRefs.current) {
      candleSeries.removePriceLine(line);
    }
    priceLineRefs.current = [];

    if (candles.length > 0) {
      const closes = candles.map((bar) => bar.close);
      const volumeRows = candles
        .map((bar) => {
          if (typeof bar.volume !== "number" || !Number.isFinite(bar.volume) || bar.volume < 0) return null;
          return {
            time: bar.time,
            value: bar.volume,
            color: bar.close >= bar.open ? "rgba(37,99,235,0.35)" : "rgba(249,115,22,0.35)",
          };
        })
        .filter((row): row is HistogramPoint => row != null);
      if (volumeRows.length > 0 && typeof chart.addHistogramSeries === "function") {
        const volumeSeries = chart.addHistogramSeries({
          priceFormat: { type: "volume" },
          priceScaleId: "",
          base: 0,
          lineWidth: 1,
        });
        volumeSeries.setData(volumeRows);
        lineSeriesRefs.current.push(volumeSeries);
      }
      if (showEma20) {
        const ema = calcEma(closes, 20).map((value, idx) => ({ time: candles[idx].time, value }));
        const s = chart.addLineSeries({ color: "#2563eb", lineWidth: 2 });
        s.setData(ema);
        lineSeriesRefs.current.push(s);
      }
      if (showEma50) {
        const ema = calcEma(closes, 50).map((value, idx) => ({ time: candles[idx].time, value }));
        const s = chart.addLineSeries({ color: "#64748b", lineWidth: 2 });
        s.setData(ema);
        lineSeriesRefs.current.push(s);
      }
      if (showVwap && vwapLine.length > 0) {
        const s = chart.addLineSeries({ color: "#0f766e", lineWidth: 1 });
        s.setData(vwapLine);
        lineSeriesRefs.current.push(s);
      }
    }

    if (showSr) {
      selectedZones.forEach((zone) => {
        const line = candleSeries.createPriceLine({
          price: zone.level,
          color: zone.type === "support" ? "#0891b2" : "#b45309",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: zone.type === "support" ? "S" : "R",
        });
        priceLineRefs.current.push(line);
      });
    }

    if (em1sd != null && em1sd > 0 && spot != null) {
      const baseBands = [
        { price: spot + em1sd, title: "+1EM" },
        { price: spot - em1sd, title: "-1EM" },
      ];
      const extraBands = showEm2
        ? [
            { price: spot + em1sd * 2, title: "+2EM" },
            { price: spot - em1sd * 2, title: "-2EM" },
          ]
        : [];
      [...baseBands, ...extraBands].forEach((band) => {
        const line = candleSeries.createPriceLine({
          price: band.price,
          color: "#7c3aed",
          lineWidth: 1,
          lineStyle: 3,
          axisLabelVisible: true,
          title: band.title,
        });
        priceLineRefs.current.push(line);
      });
    }

    if (showTradeLines) {
      if (levels?.shortStrike != null) {
        const line = candleSeries.createPriceLine({
          price: levels.shortStrike,
          color: "#f97316",
          lineWidth: 2,
          axisLabelVisible: true,
          title: "Short",
        });
        priceLineRefs.current.push(line);
      }
      if (levels?.longStrike != null) {
        const line = candleSeries.createPriceLine({
          price: levels.longStrike,
          color: "#2563eb",
          lineWidth: 2,
          axisLabelVisible: true,
          title: "Long",
        });
        priceLineRefs.current.push(line);
      }
      (levels?.breakevens ?? []).forEach((value, idx) => {
        if (value == null) return;
        const line = candleSeries.createPriceLine({
          price: value,
          color: "#0f766e",
          lineWidth: 1,
          lineStyle: 1,
          axisLabelVisible: true,
          title: `BE${idx + 1}`,
        });
        priceLineRefs.current.push(line);
      });
    }
  }, [
    candles,
    em1sd,
    levels?.breakevens,
    levels?.longStrike,
    levels?.shortStrike,
    selectedZones,
    showEma20,
    showEma50,
    showEm2,
    showSr,
    showTradeLines,
    showVwap,
    spot,
    vwapLine,
  ]);

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600, color: "#0f172a" }}>SPX Chart</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={pillStyle("#e2e8f0", "#334155")}>{instrumentLabel}</div>
          <div style={pillStyle(modeBg(dataMode), modeText(dataMode))}>{dataMode}</div>
          <div style={{ fontSize: 12, color: "#64748b" }}>In-App</div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        {(["5m", "30m", "1h", "1d"] as Tf[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTf(value)}
            style={{
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              background: tf === value ? "#3b82f6" : "#ffffff",
              color: tf === value ? "#ffffff" : "#334155",
              padding: "5px 9px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {value}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 10,
          fontSize: 12,
          color: "#475569",
        }}
      >
        <span>
          Last:{" "}
          <strong style={{ color: "#0f172a" }}>
            {lastBar ? lastBar.close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-"}
          </strong>
        </span>
        <span>
          O/H/L/C:{" "}
          {lastBar
            ? `${lastBar.open.toFixed(2)} / ${lastBar.high.toFixed(2)} / ${lastBar.low.toFixed(2)} / ${lastBar.close.toFixed(2)}`
            : "-"}
        </span>
        <span>
          Chg:{" "}
          {change == null || changePct == null ? "-" : `${change >= 0 ? "+" : ""}${change.toFixed(2)} (${changePct.toFixed(2)}%)`}
        </span>
        <span>MMC: {mmcPassed == null ? "-" : mmcPassed ? "PASS" : "FAIL"}</span>
        <span>z-score: {zScore == null ? "-" : zScore.toFixed(2)}</span>
        <span>DTE bucket: {selectedDte ?? "-"}</span>
        <span>Source: {sourceLabel}</span>
        <span>ET: {generatedAtEt ?? "-"}</span>
      </div>

      <div style={{ position: "relative" }}>
        <div
          ref={rootRef}
          style={{
            width: "100%",
            height: 380,
            borderRadius: 10,
            border: "1px solid #e2e8f0",
            background: "#ffffff",
            overflow: "hidden",
          }}
        />
        {dangerActive && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              background: "linear-gradient(to bottom, rgba(245,158,11,0.10), rgba(245,158,11,0.04))",
            }}
          />
        )}
      </div>

      {fetchError && <p style={{ marginTop: 8, color: "#b91c1c", fontSize: 12 }}>{fetchError}</p>}
      {indicatorNotice && <p style={{ marginTop: 6, color: "#92400e", fontSize: 12 }}>{indicatorNotice}</p>}
      {warnings.map((warning) => (
        <p key={warning} style={{ marginTop: 6, color: "#92400e", fontSize: 12 }}>
          {warning}
        </p>
      ))}

      {showSr && autoZones.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {autoZones.slice(0, 4).map((zone) => {
            const pinned = pinnedZoneIds.includes(zone.id);
            return (
              <button
                key={zone.id}
                type="button"
                onClick={() =>
                  setPinnedZoneIds((prev) => {
                    if (pinned) return prev.filter((id) => id !== zone.id);
                    if (prev.length >= 4) return [...prev.slice(1), zone.id];
                    return [...prev, zone.id];
                  })
                }
                style={{
                  borderRadius: 999,
                  border: "1px solid #cbd5e1",
                  background: pinned ? "#0f172a" : "#ffffff",
                  color: pinned ? "#ffffff" : "#334155",
                  fontSize: 11,
                  padding: "4px 8px",
                  cursor: "pointer",
                }}
              >
                {zone.type === "support" ? "S" : "R"} {zone.level.toFixed(1)} {pinned ? "• pinned" : ""}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function modeBg(mode: "LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE"): string {
  if (mode === "LIVE") return "#dcfce7";
  if (mode === "DELAYED") return "#fef3c7";
  if (mode === "HISTORICAL") return "#dbeafe";
  return "#ede9fe";
}

function modeText(mode: "LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE"): string {
  if (mode === "LIVE") return "#166534";
  if (mode === "DELAYED") return "#92400e";
  if (mode === "HISTORICAL") return "#1d4ed8";
  return "#5b21b6";
}

function pillStyle(background: string, color: string): CSSProperties {
  return {
    borderRadius: 999,
    border: "1px solid #cbd5e1",
    background,
    color,
    fontSize: 11,
    padding: "3px 9px",
    fontWeight: 600,
    letterSpacing: "0.02em",
  };
}
