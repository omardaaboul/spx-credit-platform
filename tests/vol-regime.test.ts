import { describe, expect, it } from "vitest";
import { classifyVolRegime } from "@/lib/volatility/volRegime";

function samples(values: number[]): Array<{ tsIso: string; iv_atm: number }> {
  return values.map((v, i) => ({
    tsIso: new Date(Date.UTC(2026, 0, i + 1, 0, 0, 0)).toISOString(),
    iv_atm: v,
  }));
}

describe("volatility regime classifier", () => {
  it("classifies low iv percentile as VOL_SUPPRESSED", () => {
    const out = classifyVolRegime(
      {
        asOfIso: "2026-02-22T00:00:00.000Z",
        dataMode: "LIVE",
        spot: 5000,
        iv_atm: 0.12,
        iv_history_samples: samples([0.2, 0.21, 0.19, 0.18, 0.17, 0.22, 0.24, 0.25, 0.23, 0.2]),
      },
      { minSamples: 5, lookbackDays: 60 },
    );
    expect(out.regime).toBe("VOL_SUPPRESSED");
  });

  it("classifies mid percentile as VOL_NORMAL", () => {
    const out = classifyVolRegime(
      {
        asOfIso: "2026-02-22T00:00:00.000Z",
        dataMode: "LIVE",
        spot: 5000,
        iv_atm: 0.2,
        iv_history_samples: samples([0.16, 0.18, 0.19, 0.2, 0.21, 0.22, 0.17, 0.23]),
      },
      { minSamples: 5, lookbackDays: 60 },
    );
    expect(out.regime).toBe("VOL_NORMAL");
  });

  it("classifies high percentile as VOL_EXPANDING", () => {
    const out = classifyVolRegime(
      {
        asOfIso: "2026-02-22T00:00:00.000Z",
        dataMode: "LIVE",
        spot: 5000,
        iv_atm: 0.21,
        iv_history_samples: samples([0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2, 0.22, 0.23, 0.24]),
      },
      { minSamples: 5, lookbackDays: 60, highPercentile: 70, extremePercentile: 95 },
    );
    expect(out.regime).toBe("VOL_EXPANDING");
  });

  it("classifies very high percentile as VOL_EXTREME", () => {
    const out = classifyVolRegime(
      {
        asOfIso: "2026-02-22T00:00:00.000Z",
        dataMode: "LIVE",
        spot: 5000,
        iv_atm: 0.45,
        iv_history_samples: samples([0.12, 0.14, 0.15, 0.16, 0.17, 0.19, 0.2, 0.21, 0.22, 0.23]),
      },
      { minSamples: 5, lookbackDays: 60, extremePercentile: 90 },
    );
    expect(out.regime).toBe("VOL_EXTREME");
  });

  it("returns UNKNOWN or low confidence warning when sample history is insufficient", () => {
    const out = classifyVolRegime(
      {
        asOfIso: "2026-02-22T00:00:00.000Z",
        dataMode: "LIVE",
        spot: 5000,
        iv_atm: 0.2,
        iv_history_samples: samples([0.19, 0.2]),
      },
      { minSamples: 20, lookbackDays: 60 },
    );
    expect(out.features.confidence).toBe("LOW");
    expect(out.warnings.some((w) => w.toLowerCase().includes("insufficient"))).toBe(true);
  });
});
