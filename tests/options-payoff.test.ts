import { describe, expect, it } from "vitest";
import {
  buildExpirationPayoffCurve,
  computeBreakeven,
  computeCurrentPnlFromMark,
  computeMaxLoss,
  computeMaxProfit,
  computeVerticalPayoff,
  expirationPnl,
  inferWidth,
  type CreditSpreadInput,
} from "@/lib/options/payoff";

describe("lib/options/payoff", () => {
  it("computes put credit spread max metrics and breakeven", () => {
    const spread: CreditSpreadInput = {
      side: "PUT_CREDIT",
      shortStrike: 100,
      longStrike: 95,
      credit: 1.5,
      width: 5,
      contracts: 1,
    };

    expect(computeMaxProfit(spread)).toBeCloseTo(150, 8);
    expect(computeMaxLoss(spread)).toBeCloseTo(350, 8);
    expect(computeBreakeven(spread)).toBeCloseTo(98.5, 8);

    expect(expirationPnl(spread, 110)).toBeCloseTo(150, 8);
    expect(expirationPnl(spread, 98.5)).toBeCloseTo(0, 8);
    expect(expirationPnl(spread, 95)).toBeCloseTo(-350, 8);
    expect(expirationPnl(spread, 80)).toBeCloseTo(-350, 8);
  });

  it("computes call credit spread max metrics and breakeven", () => {
    const spread: CreditSpreadInput = {
      side: "CALL_CREDIT",
      shortStrike: 105,
      longStrike: 110,
      credit: 1.25,
      width: 5,
      contracts: 2,
    };

    expect(computeMaxProfit(spread)).toBeCloseTo(250, 8);
    expect(computeMaxLoss(spread)).toBeCloseTo(750, 8);
    expect(computeBreakeven(spread)).toBeCloseTo(106.25, 8);

    expect(expirationPnl(spread, 100)).toBeCloseTo(250, 8);
    expect(expirationPnl(spread, 110)).toBeCloseTo(-750, 8);
    expect(expirationPnl(spread, 120)).toBeCloseTo(-750, 8);
  });

  it("builds smooth curve with bounded endpoints", () => {
    const spread: CreditSpreadInput = {
      side: "PUT_CREDIT",
      shortStrike: 100,
      longStrike: 95,
      credit: 1,
      width: 5,
    };

    const curve = buildExpirationPayoffCurve(spread, 100, 0.12, 120);
    expect(curve).toHaveLength(120);
    expect(curve[0].x).toBeCloseTo(88, 2);
    expect(curve[curve.length - 1].x).toBeCloseTo(112, 2);
    expect(curve[0].y).toBeCloseTo(-400, 8);
    expect(curve[curve.length - 1].y).toBeCloseTo(100, 8);
  });

  it("computes current pnl from mark and infers width", () => {
    const spread: CreditSpreadInput = {
      side: "CALL_CREDIT",
      shortStrike: 105,
      longStrike: 110,
      credit: 1,
      width: inferWidth(105, 110),
      contracts: 3,
    };

    expect(computeCurrentPnlFromMark(spread, 0.45)).toBeCloseTo(165, 8);
  });

  it("computes payoff metrics via computeVerticalPayoff", () => {
    const put = computeVerticalPayoff({
      side: "PUT_CREDIT",
      shortStrike: 100,
      longStrike: 95,
      credit: 1.5,
      contracts: 1,
    });
    expect(put.valid).toBe(true);
    expect(put.maxProfit).toBeCloseTo(150, 8);
    expect(put.maxLoss).toBeCloseTo(350, 8);
    expect(put.breakeven).toBeCloseTo(98.5, 8);

    const call = computeVerticalPayoff({
      side: "CALL_CREDIT",
      shortStrike: 105,
      longStrike: 110,
      credit: 1.25,
      contracts: 2,
    });
    expect(call.valid).toBe(true);
    expect(call.maxProfit).toBeCloseTo(250, 8);
    expect(call.maxLoss).toBeCloseTo(750, 8);
    expect(call.breakeven).toBeCloseTo(106.25, 8);
  });
});
