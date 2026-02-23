import { describe, expect, it } from "vitest";
import { computePopAndTouch, normalizeIv, normalCdf } from "@/lib/options/probability";
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
});
