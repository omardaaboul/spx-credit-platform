import { describe, expect, it } from "vitest";
import {
  buildPayoffSeries,
  buildTodayPayoffSeries,
  computeBreakevens,
  computeExpirationPayoff,
  computeMaxProfitLoss,
  type PayoffLeg,
} from "@/lib/payoff";

describe("payoff math", () => {
  it("computes known credit spread max profit/loss", () => {
    const legs: PayoffLeg[] = [
      { action: "SELL", right: "CALL", strike: 100, premium: 2.0, qty: 1 },
      { action: "BUY", right: "CALL", strike: 105, premium: 0.5, qty: 1 },
    ];
    expect(computeExpirationPayoff(legs, 95)).toBeCloseTo(150, 6);
    expect(computeExpirationPayoff(legs, 100)).toBeCloseTo(150, 6);
    expect(computeExpirationPayoff(legs, 105)).toBeCloseTo(-350, 6);
    expect(computeExpirationPayoff(legs, 112)).toBeCloseTo(-350, 6);
  });

  it("produces bounded iron condor payoff extremes", () => {
    const legs: PayoffLeg[] = [
      { action: "SELL", right: "PUT", strike: 95, premium: 1.0, qty: 1 },
      { action: "BUY", right: "PUT", strike: 90, premium: 0.4, qty: 1 },
      { action: "SELL", right: "CALL", strike: 105, premium: 1.1, qty: 1 },
      { action: "BUY", right: "CALL", strike: 110, premium: 0.5, qty: 1 },
    ];
    const series = buildPayoffSeries({ spot: 100, emr: 10, legs });
    const extremes = computeMaxProfitLoss(series.y);
    expect(extremes.maxProfit).toBeCloseTo(120, 6);
    expect(extremes.maxLoss).toBeCloseTo(-380, 6);
  });

  it("produces bounded iron fly payoff and breakevens", () => {
    const legs: PayoffLeg[] = [
      { action: "SELL", right: "PUT", strike: 100, premium: 4.5, qty: 1 },
      { action: "SELL", right: "CALL", strike: 100, premium: 4.7, qty: 1 },
      { action: "BUY", right: "PUT", strike: 90, premium: 0.8, qty: 1 },
      { action: "BUY", right: "CALL", strike: 110, premium: 0.9, qty: 1 },
    ];
    const series = buildPayoffSeries({ spot: 100, emr: 12, legs });
    const extremes = computeMaxProfitLoss(series.y);
    expect(extremes.maxProfit).toBeCloseTo(750, 6);
    expect(extremes.maxLoss).toBeCloseTo(-250, 6);
  });

  it("extracts breakevens from sampled payoff points", () => {
    const x = [90, 95, 100, 105, 110];
    const y = [-200, 0, 300, 0, -200];
    const breakevens = computeBreakevens(x, y).map((pt) => pt.price).sort((a, b) => a - b);
    expect(breakevens).toEqual([95, 105]);
  });

  it("returns T+0 series when IV and time are provided", () => {
    const legs: PayoffLeg[] = [
      { action: "SELL", right: "CALL", strike: 100, premium: 2.0, qty: 1, impliedVol: 0.2 },
      { action: "BUY", right: "CALL", strike: 105, premium: 0.5, qty: 1, impliedVol: 0.2 },
    ];
    const today = buildTodayPayoffSeries({
      spot: 100,
      emr: 10,
      legs,
      baseIv: 0.2,
      timeToExpiryYears: 1 / 365,
      riskFreeRate: 0.045,
      step: 5,
    });
    expect(today).not.toBeNull();
    expect(today?.x.length).toBeGreaterThan(2);
    expect(today?.y.length).toEqual(today?.x.length);
  });

  it("returns null T+0 series when model inputs are missing", () => {
    const legs: PayoffLeg[] = [
      { action: "SELL", right: "CALL", strike: 100, premium: 2.0, qty: 1 },
      { action: "BUY", right: "CALL", strike: 105, premium: 0.5, qty: 1 },
    ];
    const today = buildTodayPayoffSeries({
      spot: 100,
      emr: 10,
      legs,
      baseIv: null,
      timeToExpiryYears: null,
      step: 5,
    });
    expect(today).toBeNull();
  });
});
