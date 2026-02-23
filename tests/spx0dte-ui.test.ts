import { describe, expect, it } from "vitest";
import { formatOptionLegLine, severityDotClass, statusTone, type OptionLeg } from "@/lib/spx0dte";

describe("spx0dte ui helpers", () => {
  it("formats option legs with explicit action/type/strike/delta", () => {
    const leg: OptionLeg = { action: "SELL", type: "PUT", strike: 4870, delta: -0.12 };
    expect(formatOptionLegLine(leg)).toBe("Sell 1 PUT 4870 (Δ -0.12)");
  });

  it("maps severity to consistent dot classes", () => {
    expect(severityDotClass("good")).toContain("emerald");
    expect(severityDotClass("caution")).toContain("amber");
    expect(severityDotClass("risk")).toContain("rose");
  });

  it("classifies P/L into stable tones", () => {
    expect(statusTone(0.6)).toBe("good");
    expect(statusTone(0.3)).toBe("caution");
    expect(statusTone(0.1)).toBe("risk");
  });
});
