import { describe, expect, it } from "vitest";
import { resolveDataMode } from "@/lib/engine/dataMode";

describe("engine data mode resolution", () => {
  const policy = {
    spot_max_age_s: 2,
    chain_max_age_s: 5,
    greeks_max_age_s: 5,
  };

  it("returns LIVE when source indicates live and core feeds are fresh", () => {
    const mode = resolveDataMode({
      source: "tastytrade-live",
      session: "OPEN",
      simulationMode: false,
      freshnessAges: {
        spot: 500,
        chain: 1200,
        greeks: 1200,
        candles: 2_000,
      },
      freshnessPolicy: policy,
    });
    expect(mode).toBe("LIVE");
  });

  it("downgrades to DELAYED when live source is stale", () => {
    const mode = resolveDataMode({
      source: "tastytrade-live",
      session: "OPEN",
      simulationMode: false,
      freshnessAges: {
        spot: 5_000,
        chain: 11_000,
        greeks: 11_000,
        candles: 11_000,
      },
      freshnessPolicy: policy,
    });
    expect(mode).toBe("DELAYED");
  });

  it("returns HISTORICAL in simulation mode for market-closed style sources", () => {
    const mode = resolveDataMode({
      source: "market-closed-snapshot-log",
      session: "CLOSED",
      simulationMode: true,
      freshnessAges: {
        spot: null,
        chain: null,
        greeks: null,
        candles: null,
      },
      freshnessPolicy: policy,
    });
    expect(mode).toBe("HISTORICAL");
  });

  it("returns FIXTURE for closed sessions without simulation", () => {
    const mode = resolveDataMode({
      source: "market-closed",
      session: "CLOSED",
      simulationMode: false,
      freshnessAges: {
        spot: null,
        chain: null,
        greeks: null,
        candles: null,
      },
      freshnessPolicy: policy,
    });
    expect(mode).toBe("FIXTURE");
  });
});

