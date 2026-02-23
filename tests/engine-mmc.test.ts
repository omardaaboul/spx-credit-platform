import { describe, expect, it } from "vitest";
import { measuredMoveCompletionPass } from "@/lib/engine/mmc";

describe("engine mmc gate", () => {
  it("passes for bull put when stretch/zscore/momentum/sign align", () => {
    const pass = measuredMoveCompletionPass({
      spot: 4950,
      prevSpot: 4938,
      ema20: 5000,
      prevEma20: 5002,
      em1sd: 30,
      zScore: -1.8,
      macdHist: -0.2,
      macdHistPrev: -0.35,
      direction: "BULL_PUT",
      dte: 7,
      enforceNotStillExtending: true,
    });
    expect(pass).toBe(true);
  });

  it("fails when zscore sign does not match direction", () => {
    const pass = measuredMoveCompletionPass({
      spot: 5050,
      prevSpot: 5048,
      ema20: 5000,
      prevEma20: 4998,
      em1sd: 30,
      zScore: -1.7,
      macdHist: 0.1,
      macdHistPrev: 0.2,
      direction: "BEAR_CALL",
      dte: 7,
      enforceNotStillExtending: true,
    });
    expect(pass).toBe(false);
  });

  it("fails short-dte setup if stretch keeps extending when safeguard is enabled", () => {
    const pass = measuredMoveCompletionPass({
      spot: 4900,
      prevSpot: 4920,
      ema20: 5000,
      prevEma20: 5000,
      em1sd: 40,
      zScore: -2.0,
      macdHist: -0.2,
      macdHistPrev: -0.3,
      direction: "BULL_PUT",
      dte: 2,
      enforceNotStillExtending: true,
    });
    expect(pass).toBe(false);
  });
});

