import { describe, expect, it } from "vitest";
import { detectVolShock } from "@/lib/volatility/volShock";

describe("volatility shock detector", () => {
  it("triggers shock when move exceeds EM_1SD threshold", () => {
    const out = detectVolShock(
      {
        spot: 5050,
        prevSpot: 5000,
        em1sd: 100,
        vix: 20,
        prevVix: 20,
      },
      { movePctEm1Sd: 0.35, vixJump: 2 },
    );
    expect(out.shockFlag).toBe(true);
    expect(out.reasonCode).toBe("VOL_SHOCK_WARN");
  });
});

