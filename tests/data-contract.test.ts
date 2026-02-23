import { describe, expect, it } from "vitest";
import { applyDataContractToRows, evaluateDataContract } from "@/lib/dataContract";
import type { DashboardPayload } from "@/lib/spx0dte";

function basePayload(): DashboardPayload {
  return {
    generatedAtEt: "11:00:00",
    generatedAtParis: "17:00:00",
    market: {
      isOpen: true,
      hoursEt: "09:30-16:00 ET (Mon-Fri)",
      source: "tastytrade-live",
      telegramEnabled: true,
    },
    metrics: {
      spx: 5000,
      emr: 25,
      vix: 18,
      vwap: 4998,
      range15mPctEm: 0.2,
      atr1m: 4,
      putCallRatio: 0.9,
      iv: 0.18,
    },
    candidates: [],
    alerts: [],
    openTrades: [],
    priceSeries: [],
    volSeries: [],
    dataFeeds: {},
  };
}

describe("data contract", () => {
  it("marks feeds healthy when fresh values are present", () => {
    const nowIso = new Date().toISOString();
    const payload = basePayload();
    payload.dataFeeds = {
      underlying_price: { value: 5000, timestampIso: nowIso, source: "live" },
      option_chain: { value: 200, timestampIso: nowIso, source: "live" },
      greeks: { value: 180, timestampIso: nowIso, source: "live" },
      intraday_candles: { value: 60, timestampIso: nowIso, source: "live" },
      vwap: { value: 4998, timestampIso: nowIso, source: "derived" },
      atr_1m_5: { value: 4.2, timestampIso: nowIso, source: "derived" },
      realized_range_15m: { value: 6.5, timestampIso: nowIso, source: "derived" },
      expected_move: { value: 24.8, timestampIso: nowIso, source: "derived" },
      regime: { value: "CHOP", timestampIso: nowIso, source: "derived" },
    };
    const result = evaluateDataContract(payload);
    expect(result.status).toBe("healthy");
    expect(result.issues.length).toBe(0);
    expect(result.feeds.option_chain.isValid).toBe(true);
  });

  it("blocks criterion when required feed is stale", () => {
    const staleIso = new Date(Date.now() - 30_000).toISOString();
    const nowIso = new Date().toISOString();
    const payload = basePayload();
    payload.dataFeeds = {
      underlying_price: { value: 5000, timestampIso: nowIso, source: "live" },
      option_chain: { value: 200, timestampIso: staleIso, source: "live" },
      greeks: { value: 180, timestampIso: staleIso, source: "live" },
      intraday_candles: { value: 60, timestampIso: nowIso, source: "live" },
      vwap: { value: 4998, timestampIso: nowIso, source: "derived" },
      atr_1m_5: { value: 4.2, timestampIso: nowIso, source: "derived" },
      realized_range_15m: { value: 6.5, timestampIso: nowIso, source: "derived" },
      expected_move: { value: 24.8, timestampIso: nowIso, source: "derived" },
      regime: { value: "CHOP", timestampIso: nowIso, source: "derived" },
    };
    const contract = evaluateDataContract(payload);
    const rows = applyDataContractToRows(
      [{ name: "Liquidity OK (bid/ask <= 12% of mid)", status: "pass", detail: "0.08 <= 0.12", required: true }],
      "global",
      "Iron Condor",
      contract,
    );
    expect(contract.status).toBe("degraded");
    expect(rows[0].status).toBe("blocked");
    expect(rows[0].detail?.toLowerCase()).toContain("stale/missing feed");
    expect(rows[0].requires).toContain("option_chain");
  });

  it("does not block liquidity row when only greeks feed is stale", () => {
    const staleIso = new Date(Date.now() - 30_000).toISOString();
    const nowIso = new Date().toISOString();
    const payload = basePayload();
    payload.dataFeeds = {
      underlying_price: { value: 5000, timestampIso: nowIso, source: "live" },
      option_chain: { value: 200, timestampIso: nowIso, source: "live" },
      greeks: { value: 180, timestampIso: staleIso, source: "live" },
      intraday_candles: { value: 60, timestampIso: nowIso, source: "live" },
      vwap: { value: 4998, timestampIso: nowIso, source: "derived" },
      atr_1m_5: { value: 4.2, timestampIso: nowIso, source: "derived" },
      realized_range_15m: { value: 6.5, timestampIso: nowIso, source: "derived" },
      expected_move: { value: 24.8, timestampIso: nowIso, source: "derived" },
      regime: { value: "CHOP", timestampIso: nowIso, source: "derived" },
    };
    const contract = evaluateDataContract(payload);
    const rows = applyDataContractToRows(
      [{ name: "Liquidity OK (bid/ask <= 12% of mid)", status: "pass", detail: "0.08 <= 0.12", required: true }],
      "global",
      "Iron Condor",
      contract,
    );
    expect(contract.status).toBe("degraded");
    expect(rows[0].requires).toEqual(["option_chain"]);
    expect(rows[0].status).toBe("pass");
  });

  it("replaces generic missing/threshold fail copy with explicit fail reason", () => {
    const nowIso = new Date().toISOString();
    const payload = basePayload();
    payload.dataFeeds = {
      underlying_price: { value: 5000, timestampIso: nowIso, source: "live" },
      option_chain: { value: 200, timestampIso: nowIso, source: "live" },
      greeks: { value: 180, timestampIso: nowIso, source: "live" },
      intraday_candles: { value: 60, timestampIso: nowIso, source: "live" },
      vwap: { value: 4998, timestampIso: nowIso, source: "derived" },
      atr_1m_5: { value: 4.2, timestampIso: nowIso, source: "derived" },
      realized_range_15m: { value: 6.5, timestampIso: nowIso, source: "derived" },
      expected_move: { value: 24.8, timestampIso: nowIso, source: "derived" },
      regime: { value: "CHOP", timestampIso: nowIso, source: "derived" },
    };
    const contract = evaluateDataContract(payload);
    const rows = applyDataContractToRows(
      [{ name: "VWAP Distance <= 40% EMR", status: "fail", detail: "Data missing or threshold exceeded.", required: true }],
      "strategy",
      "Iron Condor",
      contract,
    );
    expect(rows[0].status).toBe("fail");
    expect(rows[0].detail).toBe("Threshold failed with fresh data.");
  });
});
