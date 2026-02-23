import { describe, expect, it } from "vitest";
import { expectedMove1Sd } from "@/lib/engine/math";

describe("engine expected move math", () => {
  it("computes EM_1SD = spot * iv_atm * sqrt(dte/365)", () => {
    const spot = 5000;
    const ivAtm = 0.2;
    const dte = 30;
    const em = expectedMove1Sd(spot, ivAtm, dte);
    const expected = spot * ivAtm * Math.sqrt(dte / 365);
    expect(em).toBeCloseTo(expected, 10);
  });

  it("returns NaN for invalid inputs", () => {
    expect(Number.isNaN(expectedMove1Sd(0, 0.2, 30))).toBe(true);
    expect(Number.isNaN(expectedMove1Sd(5000, 0, 30))).toBe(true);
    expect(Number.isNaN(expectedMove1Sd(5000, 0.2, 0))).toBe(true);
  });
});

