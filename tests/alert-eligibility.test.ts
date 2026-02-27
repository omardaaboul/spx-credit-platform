import { describe, expect, it } from "vitest";
import { evaluateProbabilisticEligibility } from "@/lib/alerts/alertEligibility";
import type { CandidateCard } from "@/lib/spx0dte";

const thresholds = { minPop: 0.55, minRor: 0.1, minCreditPct: 0.08 };

function makeCandidate(overrides: Partial<CandidateCard> = {}): CandidateCard {
  return {
    candidateId: "cand-1",
    strategy: "7-DTE Credit Spread",
    ready: false,
    width: 5,
    credit: 1,
    maxRisk: 400,
    popPct: 0.6,
    maxProfit: 100,
    maxLoss: 400,
    ror: 0.25,
    creditPct: 0.2,
    reason: "",
    legs: [
      { action: "SELL", type: "PUT", strike: 100, delta: -0.2 },
      { action: "BUY", type: "PUT", strike: 95, delta: -0.1 },
    ],
    ...overrides,
  };
}

describe("alert eligibility thresholds", () => {
  it("passes when candidate meets thresholds", () => {
    const result = evaluateProbabilisticEligibility(makeCandidate(), thresholds);
    expect(result.ok).toBe(true);
  });

  it("fails when PoP below minimum", () => {
    const result = evaluateProbabilisticEligibility(makeCandidate({ popPct: 0.4 }), thresholds);
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("POP_TOO_LOW");
  });

  it("fails when RoR below minimum", () => {
    const result = evaluateProbabilisticEligibility(makeCandidate({ ror: 0.05 }), thresholds);
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("ROR_TOO_LOW");
  });

  it("fails when credit/width below minimum", () => {
    const result = evaluateProbabilisticEligibility(makeCandidate({ creditPct: 0.02 }), thresholds);
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("CREDIT_PCT_TOO_LOW");
  });

  it("fails for non-credit strategies", () => {
    const result = evaluateProbabilisticEligibility(
      makeCandidate({ strategy: "Iron Condor" }),
      thresholds,
    );
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("NO_CREDIT_SPREAD_CANDIDATE");
  });
});
