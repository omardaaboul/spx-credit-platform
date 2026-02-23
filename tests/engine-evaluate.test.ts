import { describe, expect, it } from "vitest";
import { evaluateDecision } from "@/lib/engine/evaluate";
import type { DecisionInput } from "@/lib/contracts/decision";
import type { CandidateCard } from "@/lib/spx0dte";

function baseInput(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    asOfIso: "2026-02-22T15:00:00.000Z",
    source: "market-closed-snapshot-log",
    dataMode: "FIXTURE",
    session: "CLOSED",
    simulationMode: false,
    allowSimAlerts: false,
    strictLiveBlocks: true,
    feature0dte: false,
    freshnessAges: {
      spot: null,
      chain: null,
      greeks: null,
      candles: null,
    },
    freshnessPolicy: {
      spot_max_age_s: 2,
      chain_max_age_s: 5,
      greeks_max_age_s: 5,
    },
    regime: "TREND_UP",
    warnings: [],
    candidates: [],
    strategyEligibility: [],
    multiDteTargets: [],
    alerts: [],
    vol: {
      spot: 5000,
      iv_atm: 0.2,
      iv_term: { 2: 0.19, 7: 0.2, 14: 0.205, 30: 0.21, 45: 0.215 },
      realized_range_proxy: 0.12,
      vix: 18,
      prevSpot: 4999,
      prevVix: 17.8,
      samples: Array.from({ length: 30 }, (_, i) => ({
        tsIso: new Date(Date.UTC(2026, 0, i + 1, 0, 0, 0)).toISOString(),
        iv_atm: 0.15 + i * 0.001,
      })),
      freshnessAges: {
        spot: null,
        iv_atm: null,
        vix: null,
        realized: null,
      },
    },
    ...overrides,
  };
}

describe("engine evaluate pipeline", () => {
  it("blocks when market is closed and simulation mode is disabled", () => {
    const out = evaluateDecision(baseInput());
    expect(out.status).toBe("BLOCKED");
    expect(out.blocks.some((b) => b.code === "MARKET_CLOSED")).toBe(true);
  });

  it("does not hard-block market closed when simulation mode is enabled", () => {
    const out = evaluateDecision(
      baseInput({
        simulationMode: true,
        dataMode: "HISTORICAL",
      }),
    );
    expect(out.blocks.some((b) => b.code === "MARKET_CLOSED")).toBe(false);
    expect(out.warnings.some((w) => w.code === "SIMULATION_ACTIVE")).toBe(true);
  });

  it("applies volatility policy bucket disable reasons deterministically", () => {
    const candidate: CandidateCard = {
      strategy: "2-DTE Credit Spread",
      ready: true,
      width: 10,
      credit: 1.0,
      maxRisk: 900,
      popPct: 0.75,
      reason: "ready",
      legs: [{ action: "SELL", type: "PUT", strike: 4950, delta: -0.05 }],
      checklist: {
        global: [],
        regime: [],
        strategy: [],
      },
    };

    const out = evaluateDecision(
      baseInput({
        session: "OPEN",
        simulationMode: false,
        dataMode: "DELAYED",
        candidates: [candidate],
        multiDteTargets: [
          {
            strategy_label: "2-DTE Credit Spread",
            target_dte: 2,
            selected_dte: 2,
            expiration: "2026-02-24",
            ready: true,
            reason: "ok",
            checklist: [],
            recommendation: null,
            metrics: { iv_atm: 0.45 },
          },
        ],
        vol: {
          ...baseInput().vol,
          iv_atm: 0.45,
          samples: Array.from({ length: 50 }, (_, i) => ({
            tsIso: new Date(Date.UTC(2026, 0, i + 1, 0, 0, 0)).toISOString(),
            iv_atm: 0.12 + i * 0.001,
          })),
        },
      }),
    );

    expect(out.vol.regime).toBe("VOL_EXTREME");
    expect(out.blocks.some((row) => row.code === "VOL_POLICY_BUCKET_DISABLED")).toBe(true);
  });
});
