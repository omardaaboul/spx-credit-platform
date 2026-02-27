import { describe, expect, it } from "vitest";
import { computePopAndTouch, computePopVertical, estimateEvVertical, normalizeIv, normalCdf } from "@/lib/options/probability";
import type { CreditSpreadInput } from "@/lib/options/payoff";

describe("lib/options/probability", () => {
  it("normalizes IV formats", () => {
    expect(normalizeIv(0.24)).toBeCloseTo(0.24, 8);
    expect(normalizeIv(24)).toBeCloseTo(0.24, 8);
    expect(normalizeIv(null)).toBeNull();
  });

  it("normal cdf sanity", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 3);
    expect(normalCdf(1)).toBeGreaterThan(0.84);
    expect(normalCdf(-1)).toBeLessThan(0.16);
  });

  it("computes put credit PoP and probability of touch", () => {
    const spread: CreditSpreadInput = {
      side: "PUT_CREDIT",
      shortStrike: 100,
      longStrike: 95,
      credit: 1,
      width: 5,
    };
    const result = computePopAndTouch({ spread, spot: 105, dte: 30, iv: 0.2 });
    expect(result.pop).not.toBeNull();
    expect(result.probabilityOfTouch).not.toBeNull();
    expect(result.pop!).toBeGreaterThan(0.5);
    expect(result.probabilityOfTouch!).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfTouch!).toBeLessThanOrEqual(1);
  });

  it("computes call credit PoP and probability of touch", () => {
    const spread: CreditSpreadInput = {
      side: "CALL_CREDIT",
      shortStrike: 105,
      longStrike: 110,
      credit: 1,
      width: 5,
    };
    const result = computePopAndTouch({ spread, spot: 100, dte: 30, iv: 0.2 });
    expect(result.pop).not.toBeNull();
    expect(result.pop!).toBeGreaterThan(0.5);
    expect(result.probabilityOfTouch).not.toBeNull();
  });

  it("returns warning when iv or dte missing", () => {
    const spread: CreditSpreadInput = {
      side: "PUT_CREDIT",
      shortStrike: 100,
      longStrike: 95,
      credit: 1,
      width: 5,
    };
    const result = computePopAndTouch({ spread, spot: 100, dte: null, iv: null });
    expect(result.pop).toBeNull();
    expect(result.probabilityOfTouch).toBeNull();
    expect(result.warning).toBeTruthy();
    expect(result.confidence).toBe("LOW");
  });

  it("pop rises as breakeven moves farther OTM", () => {
    const base = {
      side: "PUT_CREDIT" as const,
      shortStrike: 100,
      spot: 105,
      iv: 0.2,
      dte: 30,
    };
    const near = computePopVertical({ ...base, breakeven: 98 });
    const far = computePopVertical({ ...base, breakeven: 92 });
    expect(near.pop).not.toBeNull();
    expect(far.pop).not.toBeNull();
    expect(far.pop!).toBeGreaterThan(near.pop!);
  });

  it("monte carlo EV is deterministic for a given seed", () => {
    const inputs = {
      side: "PUT_CREDIT" as const,
      shortStrike: 100,
      longStrike: 95,
      breakeven: 98,
      width: 5,
      credit: 1,
      spot: 105,
      iv: 0.2,
      dte: 30,
      seedKey: "candidate-123",
      paths: 2000,
    };
    const a = estimateEvVertical(inputs);
    const b = estimateEvVertical(inputs);
    expect(a.ev).not.toBeNull();
    expect(b.ev).not.toBeNull();
    expect(a.ev).toBeCloseTo(b.ev!, 8);
  });
});
