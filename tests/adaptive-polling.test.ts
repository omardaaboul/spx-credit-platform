import { describe, expect, it } from "vitest";
import { computePollingInterval } from "@/app/components/spx0dte/adaptivePolling";

describe("adaptive polling interval", () => {
  it("uses correct baseline per DTE bucket", () => {
    expect(
      computePollingInterval({
        openTrades: [],
        candidates: [{ strategy: "45-DTE Credit Spread" }],
      }),
    ).toBe(60);
    expect(
      computePollingInterval({
        openTrades: [],
        candidates: [{ strategy: "30-DTE Credit Spread" }],
      }),
    ).toBe(60);
    expect(
      computePollingInterval({
        openTrades: [],
        candidates: [{ strategy: "14-DTE Credit Spread" }],
      }),
    ).toBe(30);
    expect(
      computePollingInterval({
        openTrades: [],
        candidates: [{ strategy: "7-DTE Credit Spread" }],
      }),
    ).toBe(15);
    expect(
      computePollingInterval({
        openTrades: [],
        candidates: [{ strategy: "2-DTE Credit Spread" }],
      }),
    ).toBe(10);
  });

  it("forces <= 10s when any open trade is DTE <= 2", () => {
    const interval = computePollingInterval({
      openTrades: [{ strategy: "2-DTE Credit Spread", status: "OPEN" }],
      candidates: [{ strategy: "45-DTE Credit Spread" }],
    });
    expect(interval).toBeLessThanOrEqual(10);
    expect(interval).toBe(10);
  });

  it("forces 5s at dangerRatio <= 0.50", () => {
    const interval = computePollingInterval({
      openTrades: [
        {
          strategy: "14-DTE Credit Spread",
          status: "OPEN",
          spot: 5000,
          shortStrike: 4990,
          em1sd: 25,
        },
      ],
      candidates: [],
    });
    // distToShort/em1sd = 10/25 = 0.4
    expect(interval).toBe(5);
  });

  it("returns 120s in quiet mode (no open trades and no candidates)", () => {
    const interval = computePollingInterval({
      openTrades: [],
      candidates: [],
    });
    expect(interval).toBe(120);
  });

  it("always uses the fastest escalation rule", () => {
    const nowMs = Date.now();
    const interval = computePollingInterval({
      openTrades: [
        {
          strategy: "7-DTE Credit Spread",
          status: "OPEN",
          spot: 5000,
          shortStrike: 4998,
          em1sd: 40,
        },
      ],
      candidates: [{ strategy: "45-DTE Credit Spread" }],
      mmcEvents: [{ dteBucket: 7, triggeredAtMs: nowMs - 5 * 60 * 1000 }],
      nowMs,
    });
    // baseline 60, open<=7 -> 15, mmc -> 15, near-risk ratio 2/40 = 0.05 -> 5
    expect(interval).toBe(5);
  });

  it("volatility expansion increases cadence when no stronger rule exists", () => {
    const interval = computePollingInterval({
      openTrades: [],
      candidates: [{ strategy: "30-DTE Credit Spread" }],
      volRegime: "VOL_EXPANDING",
      shockFlag: false,
    });
    expect(interval).toBe(15);
  });
});
