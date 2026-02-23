import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DashboardPayload } from "@/lib/spx0dte";
import type { DataMode } from "@/lib/contracts/decision";
import { normalizeDataMode } from "@/lib/engine/dataMode";
import { classifyProxyMode, selectChartInstrument } from "@/lib/engine/session";
import { simulationModeEnabled } from "@/lib/server/runtimeEnv";

export const dynamic = "force-dynamic";

type Tf = "5m" | "30m" | "1h" | "1d";
type ChartInstrument = "SPX" | "ES";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  vwap?: number;
};

type MinutePoint = {
  time: number;
  price: number;
  vwap?: number;
};

type VwapBuildResult = {
  points: Array<{ time: number; value: number }>;
  mode: "native" | "volume_weighted_close_fallback" | "cumulative_close_fallback" | "none";
};

type ChartFailure = {
  ok: false;
  symbol: "SPX";
  instrument: ChartInstrument;
  tf: Tf;
  limit: number;
  dataMode: DataMode;
  source: string;
  fallbackUsed: boolean;
  generatedAtEt: string | null;
  spot: number | null;
  dataAgeMs: {
    spot: number | null;
    candles: number | null;
    chain: number | null;
    greeks: number | null;
  };
  candles: [];
  vwap: [];
  message: string;
  diagnostics: {
    attemptedSources: string[];
    minBarsHint: number;
    gotBars: number;
  };
};

export type CandleApiResponse =
  | ChartFailure
  | {
      ok: true;
      symbol: "SPX";
      instrument: ChartInstrument;
      tf: Tf;
      limit: number;
      dataMode: DataMode;
      source: string;
      fallbackUsed: boolean;
      generatedAtEt: string | null;
      spot: number | null;
      dataAgeMs: {
        spot: number | null;
        candles: number | null;
        chain: number | null;
        greeks: number | null;
      };
      candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
      vwap: Array<{ time: number; value: number }>;
      indicatorNotice?: string;
      warnings?: string[];
    };

const TF_TO_SECONDS: Record<Tf, number> = {
  "5m": 5 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "1d": 24 * 60 * 60,
};
const DEFAULT_LIMIT_BY_TF: Record<Tf, number> = {
  "5m": 1100,
  "30m": 1000,
  "1h": 1000,
  "1d": 1260,
};
const MIN_BARS_HINT_BY_TF: Record<Tf, number> = {
  "5m": 1000,
  "30m": 780,
  "1h": 700,
  "1d": 252,
};
const INDICATOR_MIN_BARS: Record<Tf, number> = {
  "5m": 60,
  "30m": 60,
  "1h": 60,
  "1d": 60,
};
const ET_CLOCK_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const SIMULATION_MODE = simulationModeEnabled();
const LAST_CHART_SERIES_PATH = path.join(process.cwd(), "storage", ".last_spx_chart_series.json");
const SNAPSHOT_LOG_PATH = path.join(process.cwd(), "storage", "spx0dte_snapshot_log.jsonl");
const DEBUG_MODE = String(process.env.SPX0DTE_DEBUG || "false").toLowerCase() === "true";

function debugLog(requestId: string, event: string, extra: Record<string, unknown> = {}): void {
  if (!DEBUG_MODE) return;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      request_id: requestId,
      event,
      route: "/api/market/candles",
      ...extra,
    }),
  );
}

function errorLog(requestId: string, event: string, extra: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      request_id: requestId,
      event,
      route: "/api/market/candles",
      ...extra,
    }),
  );
}

function parseTf(input: string | null): Tf {
  if (input === "30m" || input === "1h" || input === "1d") return input;
  return "5m";
}

function clampLimit(input: string | null, tf: Tf): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT_BY_TF[tf];
  return Math.max(50, Math.min(5000, Math.round(n)));
}

function nowEtClock(): string {
  return ET_CLOCK_FMT.format(new Date());
}

function sanitizeCandles(input: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const row of input) {
    if (!Number.isFinite(row.time) || row.time <= 0) continue;
    if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value))) continue;
    map.set(row.time, row);
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

function toMinuteSnapshotsFromDashboard(payload: DashboardPayload): MinutePoint[] {
  const series = payload.priceSeries ?? [];
  const nowSec = Math.floor(Date.now() / 1000);
  const out: MinutePoint[] = [];
  for (let idx = 0; idx < series.length; idx += 1) {
    const point = series[idx];
    const price = Number(point.price);
    if (!Number.isFinite(price) || price <= 1000) continue;
    const vwap = Number(point.vwap);
    const backSteps = series.length - 1 - idx;
    out.push({
      time: nowSec - backSteps * 60,
      price,
      vwap: Number.isFinite(vwap) ? vwap : undefined,
    });
  }
  return out;
}

function toMinuteSnapshotsFromSeries(series: Array<{ t: string; price: number; vwap: number }>): MinutePoint[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const out: MinutePoint[] = [];
  for (let idx = 0; idx < series.length; idx += 1) {
    const point = series[idx];
    const price = Number(point.price);
    if (!Number.isFinite(price) || price <= 1000) continue;
    const vwap = Number(point.vwap);
    const backSteps = series.length - 1 - idx;
    out.push({
      time: nowSec - backSteps * 60,
      price,
      vwap: Number.isFinite(vwap) ? vwap : undefined,
    });
  }
  return out;
}

function loadLastChartCache():
  | {
      spot: number | null;
      source: string;
      series: Array<{ t: string; price: number; vwap: number }>;
    }
  | null {
  try {
    if (!existsSync(LAST_CHART_SERIES_PATH)) return null;
    const raw = JSON.parse(readFileSync(LAST_CHART_SERIES_PATH, "utf8")) as {
      spot?: unknown;
      source?: unknown;
      priceSeries?: unknown;
    };
    const spot = Number(raw.spot);
    const series = Array.isArray(raw.priceSeries)
      ? raw.priceSeries
          .map((row) => row as { t?: unknown; price?: unknown; vwap?: unknown })
          .filter((row) => typeof row.t === "string")
          .map((row) => ({
            t: String(row.t),
            price: Number(row.price),
            vwap: Number(row.vwap),
          }))
          .filter((row) => Number.isFinite(row.price))
      : [];
    return {
      spot: Number.isFinite(spot) && spot > 1000 ? spot : null,
      source: typeof raw.source === "string" ? raw.source : "cache",
      series,
    };
  } catch {
    return null;
  }
}

function loadMinuteSnapshotsFromSnapshotLog(
  maxRows: number,
  opts: {
    includeMarketClosed: boolean;
  },
): MinutePoint[] {
  try {
    if (!existsSync(SNAPSHOT_LOG_PATH)) return [];
    const raw = readFileSync(SNAPSHOT_LOG_PATH, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(200, Math.min(maxRows, 30_000)));

    const out: MinutePoint[] = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as {
          ts_iso?: unknown;
          market_open?: unknown;
          market_source?: unknown;
          metrics?: { spx?: unknown; vwap?: unknown };
        };
        const source = String(row.market_source ?? "").toLowerCase();
        if (!opts.includeMarketClosed && (!row.market_open || source.includes("market-closed"))) {
          continue;
        }
        const tsIso = typeof row.ts_iso === "string" ? row.ts_iso : null;
        if (!tsIso) continue;
        const time = Math.floor(new Date(tsIso).getTime() / 1000);
        if (!Number.isFinite(time) || time <= 0) continue;
        const price = Number(row.metrics?.spx);
        if (!Number.isFinite(price) || price <= 1000) continue;
        const vwap = Number(row.metrics?.vwap);
        out.push({
          time,
          price,
          vwap: Number.isFinite(vwap) ? vwap : undefined,
        });
      } catch {
        // skip invalid row
      }
    }
    out.sort((a, b) => a.time - b.time);
    const deduped = new Map<number, MinutePoint>();
    for (const row of out) {
      deduped.set(row.time, row);
    }
    return Array.from(deduped.values()).sort((a, b) => a.time - b.time);
  } catch {
    return [];
  }
}

function aggregateCandles(points: MinutePoint[], tf: Tf): Candle[] {
  const bucketSec = TF_TO_SECONDS[tf];
  if (points.length === 0) return [];
  const ordered = points.slice().sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  let bucketStart = -1;
  let o = 0;
  let h = Number.NEGATIVE_INFINITY;
  let l = Number.POSITIVE_INFINITY;
  let c = 0;
  let vwapSum = 0;
  let vwapCount = 0;

  for (const point of ordered) {
    const b = Math.floor(point.time / bucketSec) * bucketSec;
    if (b !== bucketStart) {
      if (bucketStart > 0) {
        out.push({
          time: bucketStart,
          open: o,
          high: h,
          low: l,
          close: c,
          vwap: vwapCount > 0 ? vwapSum / vwapCount : undefined,
        });
      }
      bucketStart = b;
      o = point.price;
      h = point.price;
      l = point.price;
      c = point.price;
      vwapSum = 0;
      vwapCount = 0;
    } else {
      h = Math.max(h, point.price);
      l = Math.min(l, point.price);
      c = point.price;
    }
    if (point.vwap != null && Number.isFinite(point.vwap)) {
      vwapSum += point.vwap;
      vwapCount += 1;
    }
  }

  if (bucketStart > 0) {
    out.push({
      time: bucketStart,
      open: o,
      high: h,
      low: l,
      close: c,
      vwap: vwapCount > 0 ? vwapSum / vwapCount : undefined,
    });
  }

  return sanitizeCandles(out);
}

function buildVwapSeries(candles: Candle[]): VwapBuildResult {
  if (candles.length === 0) {
    return { points: [], mode: "none" };
  }

  const native = candles
    .filter((bar) => Number.isFinite(bar.vwap))
    .map((bar) => ({ time: bar.time, value: Number(bar.vwap) }));
  if (native.length > 0) {
    return { points: native, mode: "native" };
  }

  const hasAnyPositiveVolume = candles.some(
    (bar) => typeof bar.volume === "number" && Number.isFinite(bar.volume) && bar.volume > 0,
  );

  let cumPv = 0;
  let cumVol = 0;
  let cumClose = 0;
  let closeCount = 0;
  const derived: Array<{ time: number; value: number }> = [];

  for (const bar of candles) {
    const close = Number(bar.close);
    if (!Number.isFinite(close)) continue;

    cumClose += close;
    closeCount += 1;

    const volume = typeof bar.volume === "number" && Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : 0;
    if (volume > 0) {
      cumPv += close * volume;
      cumVol += volume;
    }

    const value = cumVol > 0 ? cumPv / cumVol : closeCount > 0 ? cumClose / closeCount : close;
    derived.push({ time: bar.time, value });
  }

  if (derived.length === 0) {
    return { points: [], mode: "none" };
  }

  return {
    points: derived,
    mode: hasAnyPositiveVolume ? "volume_weighted_close_fallback" : "cumulative_close_fallback",
  };
}

async function fetchStooqDaily(limit: number): Promise<Candle[]> {
  try {
    const res = await fetch("https://stooq.com/q/d/l/?s=%5Espx&i=d", { cache: "no-store" });
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return [];
    const out: Candle[] = [];
    for (let i = 1; i < lines.length; i += 1) {
      const [dateStr, openStr, highStr, lowStr, closeStr] = lines[i].split(",");
      if (!dateStr || !openStr || !highStr || !lowStr || !closeStr) continue;
      const ts = Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
      const open = Number(openStr);
      const high = Number(highStr);
      const low = Number(lowStr);
      const close = Number(closeStr);
      if (![ts, open, high, low, close].every((v) => Number.isFinite(v))) continue;
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
      out.push({ time: ts, open, high, low, close });
    }
    return sanitizeCandles(out).slice(-Math.max(5, Math.min(limit, 5000)));
  } catch {
    return [];
  }
}

function yahooParamsForTf(tf: Tf): { interval: string; range: string } {
  switch (tf) {
    case "5m":
      return { interval: "5m", range: "10d" };
    case "30m":
      return { interval: "30m", range: "60d" };
    case "1h":
      return { interval: "60m", range: "120d" };
    case "1d":
      return { interval: "1d", range: "5y" };
    default:
      return { interval: "5m", range: "10d" };
  }
}

async function fetchYahooCandles(symbol: string, tf: Tf): Promise<Candle[]> {
  try {
    const { interval, range } = yahooParamsForTf(tf);
    const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    url.searchParams.set("interval", interval);
    url.searchParams.set("range", range);
    url.searchParams.set("includePrePost", "true");
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return [];
    const payload = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> };
        }>;
      };
    };
    const result = payload.chart?.result?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const quote = result?.indicators?.quote?.[0];
    const opens = Array.isArray(quote?.open) ? quote.open : [];
    const highs = Array.isArray(quote?.high) ? quote.high : [];
    const lows = Array.isArray(quote?.low) ? quote.low : [];
    const closes = Array.isArray(quote?.close) ? quote.close : [];
    const volumes = Array.isArray(quote?.volume) ? quote.volume : [];
    const out: Candle[] = [];
    const size = Math.min(timestamps.length, opens.length, highs.length, lows.length, closes.length);
    for (let i = 0; i < size; i += 1) {
      const time = Number(timestamps[i]);
      const open = Number(opens[i]);
      const high = Number(highs[i]);
      const low = Number(lows[i]);
      const close = Number(closes[i]);
      if (![time, open, high, low, close].every((value) => Number.isFinite(value))) continue;
      if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
      const volume = Number(volumes[i]);
      out.push({
        time,
        open,
        high,
        low,
        close,
        volume: Number.isFinite(volume) && volume >= 0 ? volume : undefined,
      });
    }
    return sanitizeCandles(out);
  } catch {
    return [];
  }
}

function inferOpenModeFromDashboard(payload: DashboardPayload | null): DataMode {
  if (!payload) return "DELAYED";
  const source = String(payload.market?.source ?? "").toLowerCase();
  if (source.includes("live")) return "LIVE";
  if (source.includes("partial") || source.includes("delay") || source.includes("cache")) return "DELAYED";
  return normalizeDataMode(payload.data_mode, "DELAYED");
}

function buildFailure(
  requestId: string,
  params: {
    instrument: ChartInstrument;
    tf: Tf;
    limit: number;
    dataMode: DataMode;
    source: string;
    attemptedSources: string[];
    generatedAtEt: string | null;
    spot: number | null;
    dataAgeMs: { spot: number | null; candles: number | null; chain: number | null; greeks: number | null };
    message: string;
  },
  startedAtMs: number,
): NextResponse<ChartFailure> {
  const body: ChartFailure = {
    ok: false,
    symbol: "SPX",
    instrument: params.instrument,
    tf: params.tf,
    limit: params.limit,
    dataMode: params.dataMode,
    source: params.source,
    fallbackUsed: params.attemptedSources.length > 1,
    generatedAtEt: params.generatedAtEt,
    spot: params.spot,
    dataAgeMs: params.dataAgeMs,
    candles: [],
    vwap: [],
    message: params.message,
    diagnostics: {
      attemptedSources: params.attemptedSources,
      minBarsHint: MIN_BARS_HINT_BY_TF[params.tf],
      gotBars: 0,
    },
  };
  errorLog(requestId, "request_failed", {
    instrument: params.instrument,
    tf: params.tf,
    source: params.source,
    attempted_sources: params.attemptedSources,
    message: params.message,
    duration_ms: Date.now() - startedAtMs,
  });
  return NextResponse.json(body, {
    status: 503,
    headers: {
      "x-request-id": requestId,
      "x-eval-duration-ms": String(Date.now() - startedAtMs),
    },
  });
}

export async function GET(request: Request) {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const startedAtMs = Date.now();
  const url = new URL(request.url);
  const symbol = String(url.searchParams.get("symbol") ?? "SPX").toUpperCase();
  const tf = parseTf(url.searchParams.get("tf"));
  const limit = clampLimit(url.searchParams.get("limit"), tf);

  if (symbol !== "SPX") {
    debugLog(requestId, "request_end", { status: 400, reason: "unsupported_symbol", symbol });
    return NextResponse.json(
      { ok: false, message: "Only SPX is supported.", symbol, tf, limit },
      {
        status: 400,
        headers: {
          "x-request-id": requestId,
          "x-eval-duration-ms": String(Date.now() - startedAtMs),
        },
      },
    );
  }

  const instrument = selectChartInstrument(new Date());
  const attemptedSources: string[] = [];
  debugLog(requestId, "request_start", {
    tf,
    requested_limit: limit,
    instrument,
    simulation_mode: SIMULATION_MODE,
  });

  const h = await headers();
  const reqUrl = new URL(request.url);
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? reqUrl.host;
  const proto = h.get("x-forwarded-proto") ?? reqUrl.protocol.replace(":", "") ?? "http";
  const upstreamUrl = `${proto}://${host}/api/spx0dte`;

  let dashboard: DashboardPayload | null = null;
  let dashboardMode: DataMode = "FIXTURE";
  let dashboardSpot: number | null = null;
  let dashboardGeneratedAtEt: string | null = null;
  let dashboardAges = { spot: null as number | null, candles: null as number | null, chain: null as number | null, greeks: null as number | null };

  try {
    const upstream = await fetch(upstreamUrl, { cache: "no-store" });
    if (upstream.ok) {
      dashboard = (await upstream.json()) as DashboardPayload;
      dashboardMode = normalizeDataMode(dashboard.data_mode, dashboard.market?.isOpen ? "DELAYED" : "FIXTURE");
      dashboardSpot = Number.isFinite(dashboard.metrics?.spx) ? Number(dashboard.metrics?.spx) : null;
      dashboardGeneratedAtEt = dashboard.generatedAtEt ?? null;
      dashboardAges = {
        spot: typeof dashboard.data_age_ms?.spot === "number" ? dashboard.data_age_ms.spot : null,
        candles: typeof dashboard.data_age_ms?.candles === "number" ? dashboard.data_age_ms.candles : null,
        chain: typeof dashboard.data_age_ms?.chain === "number" ? dashboard.data_age_ms.chain : null,
        greeks: typeof dashboard.data_age_ms?.greeks === "number" ? dashboard.data_age_ms.greeks : null,
      };
    } else {
      attemptedSources.push(`spx0dte-${upstream.status}`);
    }
  } catch {
    attemptedSources.push("spx0dte-fetch-failed");
  }

  let candles: Candle[] = [];
  let source = "unavailable";
  let dataMode: DataMode = instrument === "SPX" ? inferOpenModeFromDashboard(dashboard) : "FIXTURE";
  let spot: number | null = dashboardSpot;
  let generatedAtEt: string | null = dashboardGeneratedAtEt;
  const warnings: string[] = [];

  if (instrument === "SPX") {
    if (tf === "1d") {
      attemptedSources.push("stooq-daily-spx");
      const daily = await fetchStooqDaily(limit);
      if (daily.length > 0) {
        candles = daily;
        source = "stooq-daily";
        dataMode = dashboardMode === "LIVE" ? "DELAYED" : dashboardMode;
        spot = Number.isFinite(spot) ? spot : daily[daily.length - 1]?.close ?? null;
      }
    }

    if (candles.length === 0) {
      attemptedSources.push("snapshot-log-live-spx");
      const logPoints = loadMinuteSnapshotsFromSnapshotLog(20_000, { includeMarketClosed: false });
      if (logPoints.length > 0) {
        candles = aggregateCandles(logPoints, tf).slice(-limit);
        source = "snapshot-log";
        if (logPoints.length > 0 && spot == null) {
          spot = logPoints[logPoints.length - 1]?.price ?? null;
        }
      }
    }

    if (candles.length === 0 && dashboard) {
      attemptedSources.push("dashboard-price-series");
      const points = toMinuteSnapshotsFromDashboard(dashboard);
      candles = aggregateCandles(points, tf).slice(-limit);
      if (candles.length > 0) {
        source = "dashboard-series";
      }
    }

    if (candles.length === 0) {
      attemptedSources.push("last-chart-cache");
      const cache = loadLastChartCache();
      if (cache && cache.series.length > 0) {
        const points = toMinuteSnapshotsFromSeries(cache.series);
        candles = aggregateCandles(points, tf).slice(-limit);
        if (candles.length > 0) {
          source = `${cache.source}-cache`;
          if (spot == null) spot = cache.spot;
          warnings.push("Using cached chart series.");
        }
      }
    }
  } else {
    attemptedSources.push("yahoo-es-f");
    const esCandles = await fetchYahooCandles("ES=F", tf);
    if (esCandles.length > 0) {
      candles = esCandles.slice(-limit);
      source = "yahoo-es-f";
      const ageMs = Math.max(0, Date.now() - candles[candles.length - 1].time * 1000);
      dataMode = classifyProxyMode(ageMs);
      spot = candles[candles.length - 1]?.close ?? spot;
      generatedAtEt = nowEtClock();
    } else if (SIMULATION_MODE) {
      warnings.push("Simulation Mode - Market Closed. Using historical data.");
      dataMode = "HISTORICAL";
      attemptedSources.push("historical-override");
      if (tf === "1d") {
        const daily = await fetchStooqDaily(limit);
        if (daily.length > 0) {
          candles = daily;
          source = "historical-override-stooq";
          spot = daily[daily.length - 1]?.close ?? spot;
          generatedAtEt = nowEtClock();
        }
      } else {
        const points = loadMinuteSnapshotsFromSnapshotLog(30_000, { includeMarketClosed: false });
        if (points.length > 0) {
          candles = aggregateCandles(points, tf).slice(-limit);
          source = "historical-override-snapshot-log";
          if (spot == null) {
            spot = points[points.length - 1]?.price ?? null;
          }
          generatedAtEt = nowEtClock();
        }
      }
    } else {
      dataMode = "FIXTURE";
    }
  }

  candles = sanitizeCandles(candles).slice(-limit);
  const vwapBuilt = buildVwapSeries(candles);
  const vwap = vwapBuilt.points;
  if (vwapBuilt.mode === "volume_weighted_close_fallback") {
    warnings.push("VWAP source unavailable; using derived VWAP from close+volume.");
  } else if (vwapBuilt.mode === "cumulative_close_fallback") {
    warnings.push("VWAP source unavailable; using cumulative-close fallback.");
  }

  if (dashboardSpot != null && candles.length > 0) {
    const close = candles[candles.length - 1].close;
    if (Number.isFinite(close) && Math.abs(close - dashboardSpot) > 30) {
      errorLog(requestId, "source_conflict", {
        instrument,
        tf,
        dashboard_spot: dashboardSpot,
        candle_close: close,
        source,
      });
    }
  }

  if (candles.length === 0) {
    return buildFailure(
      requestId,
      {
        instrument,
        tf,
        limit,
        dataMode: instrument === "ES" ? "FIXTURE" : dataMode,
        source,
        attemptedSources,
        generatedAtEt,
        spot,
        dataAgeMs: dashboardAges,
        message:
          instrument === "ES"
            ? "ES proxy feed unavailable. Chart is in non-live mode."
            : "SPX candle feed unavailable for requested timeframe.",
      },
      startedAtMs,
    );
  }

  const indicatorNotice =
    candles.length < INDICATOR_MIN_BARS[tf]
      ? `Insufficient bars for full indicator set (${candles.length}/${INDICATOR_MIN_BARS[tf]}).`
      : undefined;

  const durationMs = Date.now() - startedAtMs;
  debugLog(requestId, "request_end", {
    status: 200,
    instrument,
    tf,
    candle_count: candles.length,
    data_mode: dataMode,
    source,
    fallback_used: attemptedSources.length > 1,
    duration_ms: durationMs,
  });

  const body: CandleApiResponse = {
    ok: true,
    symbol: "SPX",
    instrument,
    tf,
    limit,
    dataMode,
    source,
    fallbackUsed: attemptedSources.length > 1,
    generatedAtEt,
    spot: Number.isFinite(spot) ? spot : null,
    dataAgeMs: dashboardAges,
    candles: candles.map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    })),
    vwap,
    indicatorNotice,
    warnings,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: {
      "x-request-id": requestId,
      "x-eval-duration-ms": String(durationMs),
    },
  });
}
