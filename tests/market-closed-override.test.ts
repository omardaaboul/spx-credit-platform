import { afterEach, describe, expect, it, vi } from "vitest";

const CLOSED_SESSION_TIME = new Date("2026-02-22T15:00:00Z");

function buildClosedSnapshot() {
  const ts = "2026-02-22T14:59:50.000Z";
  const candleTs = "2026-02-22T14:55:00.000Z";
  const recommendation = {
    type: "2-DTE Credit Spread",
    right: "PUT",
    expiry: "2026-02-24",
    short_strike: 5980,
    long_strike: 5970,
    short_delta: -0.08,
    long_delta: -0.03,
    distance_points: 20,
    width: 10,
    credit: 1.0,
    max_loss_points: 9,
    max_loss_dollars: 900,
    stop_debit: 2.5,
    liquidity_ratio: 0.06,
    profit_take_debit: 0.05,
    delta_stop: 0.22,
    use_delta_stop: true,
    candidate_id: "cand-2dte-test",
    target_dte: 2,
    selected_dte: 2,
    legs: [
      { action: "SELL", type: "PUT", strike: 5980, delta: -0.08 },
      { action: "BUY", type: "PUT", strike: 5970, delta: -0.03 },
    ],
  };

  return {
    generatedAtEt: "10:00:00",
    generatedAtParis: "16:00:00",
    market: {
      isOpen: false,
      hoursEt: "09:30-16:00 ET (Mon-Fri)",
      source: "market-closed-snapshot-log",
      telegramEnabled: false,
    },
    metrics: {
      spx: 6000,
      emr: 55,
      vix: 20,
      vwap: 5998,
      range15mPctEm: 0.2,
      atr1m: 3,
      putCallRatio: 0.95,
      iv: 0.22,
    },
    globalChecklist: [],
    regimeSummary: {
      regime: "CHOP",
      favoredStrategy: "Iron Condor",
      reason: "Test regime.",
    },
    strategyEligibility: [],
    candidates: [],
    alerts: [],
    openTrades: [],
    priceSeries: [{ t: "09:55:00", price: 6000, vwap: 5998 }],
    volSeries: [{ t: "09:55:00", emr: 55, rangePctEm: 0.2, atr: 3 }],
    warnings: [],
    dataFeeds: {
      underlying_price: { value: 6000, timestampIso: ts, source: "snapshot" },
      option_chain: { value: 120, timestampIso: ts, source: "snapshot" },
      greeks: { value: 90, timestampIso: ts, source: "snapshot" },
      intraday_candles: { value: 80, timestampIso: candleTs, source: "snapshot" },
      vwap: { value: 5998, timestampIso: candleTs, source: "derived" },
      atr_1m_5: { value: 3, timestampIso: candleTs, source: "derived" },
      realized_range_15m: { value: 8, timestampIso: candleTs, source: "derived" },
      expected_move: { value: 55, timestampIso: ts, source: "derived" },
      regime: { value: "CHOP", timestampIso: ts, source: "derived" },
    },
    twoDte: {
      ready: true,
      reason: "2-DTE setup aligned.",
      checklist: [{ name: "2-DTE data available", status: "pass", detail: "snapshot ok", required: true }],
      recommendation,
      metrics: { iv: 0.2, em_1sd: 40, configProfile: "2-DTE" },
      settings: {},
      openTrades: [],
    },
    multiDte: {
      targets: [
        {
          strategy_label: "2-DTE Credit Spread",
          target_dte: 2,
          selected_dte: 2,
          expiration: "2026-02-24",
          ready: true,
          reason: "2-DTE criteria passed.",
          checklist: [{ name: "Delta in range", status: "pass", detail: "ok", required: true }],
          recommendation,
          metrics: { iv: 0.2, em_1sd: 40, configProfile: "2-DTE" },
        },
      ],
    },
  };
}

async function loadRouteWithMockedExec(snapshot: Record<string, unknown>) {
  vi.resetModules();
  const execFileSync = vi.fn(() => JSON.stringify(snapshot));
  vi.doMock("node:child_process", () => ({ execFileSync }));
  const route = await import("@/app/api/spx0dte/route");
  return { GET: route.GET, execFileSync };
}

function expectSnapshotHeaderShape(payload: Record<string, unknown>) {
  expect(typeof payload.generatedAtEt).toBe("string");
  expect(typeof payload.generatedAtParis).toBe("string");
  expect(typeof payload.data_mode).toBe("string");

  const market = payload.market as Record<string, unknown>;
  expect(typeof market).toBe("object");
  expect(typeof market.isOpen).toBe("boolean");

  const metrics = payload.metrics as Record<string, unknown>;
  expect(typeof metrics).toBe("object");
  expect(metrics.spx).not.toBeUndefined();

  const dataFeeds = payload.dataFeeds as Record<string, unknown>;
  expect(typeof dataFeeds).toBe("object");
  expect(dataFeeds).not.toBeNull();
  expect((dataFeeds.underlying_price as Record<string, unknown>).timestampIso).not.toBeUndefined();
  expect((dataFeeds.option_chain as Record<string, unknown>).timestampIso).not.toBeUndefined();
  expect((dataFeeds.greeks as Record<string, unknown>).timestampIso).not.toBeUndefined();

  const symbolValidation = payload.symbolValidation as Record<string, unknown>;
  expect(typeof symbolValidation).toBe("object");
  expect(symbolValidation).not.toBeNull();

  const targets = symbolValidation.targets as Record<string, unknown>;
  expect(targets).not.toBeNull();
  expect(typeof targets).toBe("object");
  expect(targets["2"]).toBeDefined();
  expect(targets["7"]).toBeDefined();
  expect(targets["14"]).toBeDefined();
  expect(targets["30"]).toBeDefined();
  expect(targets["45"]).toBeDefined();

  const chain = symbolValidation.chain as Record<string, unknown>;
  expect(Array.isArray(chain.expirationsPresent)).toBe(true);

  const checks = symbolValidation.checks as Record<string, unknown>;
  expect(typeof checks.spot_reasonable).toBe("boolean");
  expect(typeof checks.chain_has_target_expirations).toBe("boolean");
  expect(typeof checks.greeks_match_chain).toBe("boolean");
  expect(typeof checks.spot_age_ok).toBe("boolean");
  expect(typeof checks.chain_age_ok).toBe("boolean");
  expect(typeof checks.greeks_age_ok).toBe("boolean");
}

describe("market closed override for /api/spx0dte", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.ALLOW_MARKET_CLOSED;
    delete process.env.SIMULATION_MODE;
    delete process.env.SPX0DTE_FORCE_MARKET_OPEN;
  });

  it("keeps market-closed blocking when SIMULATION_MODE=false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOSED_SESSION_TIME);
    process.env.SIMULATION_MODE = "false";
    process.env.ALLOW_MARKET_CLOSED = "false";
    process.env.SPX0DTE_FORCE_MARKET_OPEN = "false";

    const { GET, execFileSync } = await loadRouteWithMockedExec(buildClosedSnapshot());
    const response = await GET(new Request("http://localhost:3000/api/spx0dte"));
    const payload = (await response.json()) as Record<string, unknown>;
    expectSnapshotHeaderShape(payload);

    expect(payload.market_closed_override).toBe(false);
    expect((payload.market as Record<string, unknown>).isOpen).toBe(false);
    expect((payload.market as Record<string, unknown>).source).toBe("market-closed");
    expect(payload.data_mode).toBe("FIXTURE");
    expect((payload.candidates as Array<Record<string, unknown>>).every((row) => row.ready === false)).toBe(true);
    const calledSnapshotScript = execFileSync.mock.calls.some(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].some((arg: unknown) => typeof arg === "string" && arg.includes("spx0dte_snapshot.py")),
    );
    expect(calledSnapshotScript).toBe(false);
  });

  it("runs evaluation on market-closed sessions when SIMULATION_MODE=true", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(CLOSED_SESSION_TIME);
    process.env.SIMULATION_MODE = "true";
    process.env.ALLOW_MARKET_CLOSED = "true";
    process.env.SPX0DTE_FORCE_MARKET_OPEN = "false";

    const { GET, execFileSync } = await loadRouteWithMockedExec(buildClosedSnapshot());
    const response = await GET(new Request("http://localhost:3000/api/spx0dte"));
    const payload = (await response.json()) as Record<string, unknown>;
    expectSnapshotHeaderShape(payload);

    const calledSnapshotScript = execFileSync.mock.calls.some(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].some((arg: unknown) => typeof arg === "string" && arg.includes("spx0dte_snapshot.py")),
    );
    expect(calledSnapshotScript).toBe(true);
    expect(payload.market_closed_override).toBe(true);
    expect((payload.market as Record<string, unknown>).isOpen).toBe(false);
    expect(payload.data_mode).toBe("HISTORICAL");
    expect((payload.metrics as Record<string, unknown>).spx).toBe(6000);
    expect(((payload.data_age_ms as Record<string, unknown>).spot as number | null) != null).toBe(true);
    expect(((payload.data_age_ms as Record<string, unknown>).candles as number | null) != null).toBe(true);
    expect(
      (payload.candidates as Array<Record<string, unknown>>).some((row) => row.strategy === "2-DTE Credit Spread"),
    ).toBe(true);
  });
});
