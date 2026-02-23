import { describe, expect, it } from "vitest";
import { applyVolPolicy } from "@/lib/policy/volPolicy";

describe("volatility policy overlay", () => {
  it("returns expected allowed buckets for each regime", () => {
    expect(applyVolPolicy("VOL_NORMAL").allowedDteBuckets).toEqual([2, 7, 14, 30, 45]);
    expect(applyVolPolicy("VOL_SUPPRESSED").allowedDteBuckets).toEqual([2, 7, 14, 30]);
    expect(applyVolPolicy("VOL_EXPANDING", { expandingAllow2Dte: false }).allowedDteBuckets).toEqual([7, 14, 30, 45]);
    expect(applyVolPolicy("VOL_EXTREME", { extremeBlockAll: false }).allowedDteBuckets).toEqual([30, 45]);
  });

  it("is deterministic for same regime and config", () => {
    const a = applyVolPolicy("VOL_EXPANDING", { expandingAllow2Dte: false });
    const b = applyVolPolicy("VOL_EXPANDING", { expandingAllow2Dte: false });
    expect(a).toEqual(b);
  });
});

