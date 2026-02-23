import { describe, expect, it } from "vitest";
import { rankCandidatesDeterministic } from "@/lib/engine/ranker";
import type { CandidateCard } from "@/lib/spx0dte";

function candidate(partial: Partial<CandidateCard>): CandidateCard {
  return {
    strategy: "7-DTE Credit Spread",
    ready: true,
    width: 10,
    credit: 1,
    maxRisk: 900,
    popPct: 0.75,
    reason: "ok",
    legs: [],
    ...partial,
  };
}

describe("engine deterministic ranking", () => {
  it("ranks by delta fit, then credit/width, then gamma penalty", () => {
    const rows = rankCandidatesDeterministic([
      candidate({
        candidateId: "b",
        adjustedPremium: 0.9,
        legs: [{ action: "SELL", type: "PUT", strike: 4950, delta: -0.08 }],
        greeks: { gamma: 0.08 },
      }),
      candidate({
        candidateId: "a",
        adjustedPremium: 0.8,
        legs: [{ action: "SELL", type: "PUT", strike: 4940, delta: -0.09 }],
        greeks: { gamma: 0.06 },
      }),
      candidate({
        candidateId: "c",
        adjustedPremium: 1.0,
        legs: [{ action: "SELL", type: "PUT", strike: 4930, delta: -0.07 }],
        greeks: { gamma: 0.09 },
      }),
    ]);

    expect(rows.map((r) => r.candidateId)).toEqual(["a", "b", "c"]);
  });

  it("uses candidate id as deterministic tie-breaker", () => {
    const rows = rankCandidatesDeterministic([
      candidate({
        candidateId: "zeta",
        adjustedPremium: 0.9,
        legs: [{ action: "SELL", type: "PUT", strike: 4950, delta: -0.09 }],
        greeks: { gamma: 0.05 },
      }),
      candidate({
        candidateId: "alpha",
        adjustedPremium: 0.9,
        legs: [{ action: "SELL", type: "PUT", strike: 4950, delta: -0.09 }],
        greeks: { gamma: 0.05 },
      }),
    ]);
    expect(rows.map((r) => r.candidateId)).toEqual(["alpha", "zeta"]);
  });
});

