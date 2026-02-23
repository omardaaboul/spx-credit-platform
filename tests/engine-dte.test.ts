import { describe, expect, it } from "vitest";
import { parseDteFromStrategy, resolveNearestDteBuckets } from "@/lib/engine/dte";

describe("engine dte resolver", () => {
  it("parses dte from strategy labels", () => {
    expect(parseDteFromStrategy("2-DTE Credit Spread")).toBe(2);
    expect(parseDteFromStrategy("45-DTE Credit Spread")).toBe(45);
    expect(parseDteFromStrategy("Iron Condor")).toBeNull();
  });

  it("maps each target bucket to nearest available expiration dte", () => {
    const rows = resolveNearestDteBuckets([1, 5, 15, 29, 47], [2, 7, 14, 30, 45]);
    expect(rows).toEqual([
      { targetDte: 2, selectedDte: 1, distance: 1 },
      { targetDte: 7, selectedDte: 5, distance: 2 },
      { targetDte: 14, selectedDte: 15, distance: 1 },
      { targetDte: 30, selectedDte: 29, distance: 1 },
      { targetDte: 45, selectedDte: 47, distance: 2 },
    ]);
  });

  it("returns null selection when no dte values are available", () => {
    const rows = resolveNearestDteBuckets([], [2, 7]);
    expect(rows).toEqual([
      { targetDte: 2, selectedDte: null, distance: null },
      { targetDte: 7, selectedDte: null, distance: null },
    ]);
  });
});

