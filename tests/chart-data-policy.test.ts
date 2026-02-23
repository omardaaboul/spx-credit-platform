import { describe, expect, it } from "vitest";
import { classifyProxyMode, isUsRthEt, selectChartInstrument } from "@/lib/engine/session";
import { normalizeDataMode } from "@/lib/engine/dataMode";

describe("chart data policy", () => {
  it("uses SPX during US RTH and ES outside RTH", () => {
    const tenAmEt = new Date("2026-02-20T15:00:00.000Z"); // 10:00 ET
    const ninePmEt = new Date("2026-02-21T02:00:00.000Z"); // 21:00 ET previous day
    expect(isUsRthEt(tenAmEt)).toBe(true);
    expect(selectChartInstrument(tenAmEt)).toBe("SPX");
    expect(isUsRthEt(ninePmEt)).toBe(false);
    expect(selectChartInstrument(ninePmEt)).toBe("ES");
  });

  it("classifies proxy freshness for ES mode", () => {
    expect(classifyProxyMode(50_000)).toBe("LIVE");
    expect(classifyProxyMode(300_000)).toBe("DELAYED");
    expect(classifyProxyMode(null)).toBe("DELAYED");
  });

  it("normalizes canonical data modes with fallback", () => {
    expect(normalizeDataMode("live", "FIXTURE")).toBe("LIVE");
    expect(normalizeDataMode("historical", "FIXTURE")).toBe("HISTORICAL");
    expect(normalizeDataMode("closed", "LIVE")).toBe("LIVE");
    expect(normalizeDataMode("unknown", "FIXTURE")).toBe("FIXTURE");
  });
});
