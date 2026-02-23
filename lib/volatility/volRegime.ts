import { computePercentile, type IvSample } from "@/lib/data/ivCache";

export type VolRegime = "VOL_SUPPRESSED" | "VOL_NORMAL" | "VOL_EXPANDING" | "VOL_EXTREME" | "UNKNOWN";
export type VolFeatureConfidence = "HIGH" | "MED" | "LOW";

export type VolInputs = {
  asOfIso: string;
  dataMode: "LIVE" | "DELAYED" | "HISTORICAL" | "FIXTURE";
  spot: number | null;
  iv_atm: number | null;
  iv_term?: Record<number, number | null>;
  realized_vol_5d?: number | null;
  realized_range_proxy?: number | null;
  iv_history_samples?: IvSample[];
  vix?: number | null;
  freshnessAges?: {
    spot?: number | null;
    iv_atm?: number | null;
    vix?: number | null;
    realized?: number | null;
  };
};

export type VolClassifierConfig = {
  lookbackDays: number;
  minSamples: number;
  ivFreshMaxAgeMs: number;
  lowPercentile: number;
  highPercentile: number;
  extremePercentile: number;
  ivVsRvSuppressed: number;
  ivVsRvExpanding: number;
  termSlopeExpanding: number;
};

export type VolClassificationResult = {
  regime: VolRegime;
  features: {
    ivPercentile: number | null;
    ivVsRvRatio: number | null;
    termSlope: number | null;
    shockFlag: boolean | null;
    confidence: VolFeatureConfidence;
  };
  warnings: string[];
  missingInputs: string[];
  sampleCount: number;
  lookbackDays: number;
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ivDecimal(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value > 3 ? value / 100 : value;
}

function defaultConfig(): VolClassifierConfig {
  const lookbackDays = Math.max(10, Number(process.env.VOL_LOOKBACK_DAYS ?? 60));
  const minSamples = Math.max(5, Number(process.env.VOL_MIN_SAMPLES ?? 20));
  return {
    lookbackDays,
    minSamples,
    ivFreshMaxAgeMs: Math.max(1_000, Number(process.env.VOL_IV_MAX_AGE_MS ?? 5_000)),
    lowPercentile: Number(process.env.VOL_PCTL_LOW ?? 25),
    highPercentile: Number(process.env.VOL_PCTL_HIGH ?? 70),
    extremePercentile: Number(process.env.VOL_PCTL_EXTREME ?? 90),
    ivVsRvSuppressed: Number(process.env.VOL_IV_RV_SUPPRESSED ?? 0.8),
    ivVsRvExpanding: Number(process.env.VOL_IV_RV_EXPANDING ?? 1.6),
    termSlopeExpanding: Number(process.env.VOL_TERM_SLOPE_EXPANDING ?? 0.03),
  };
}

function computeTermSlope(ivTerm?: Record<number, number | null>): number | null {
  if (!ivTerm) return null;
  const rows = Object.entries(ivTerm)
    .map(([dte, iv]) => ({ dte: Number(dte), iv: ivDecimal(finite(iv)) }))
    .filter((row): row is { dte: number; iv: number } => Number.isFinite(row.dte) && row.iv != null)
    .sort((a, b) => a.dte - b.dte);
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (last.dte === first.dte) return null;
  return (last.iv - first.iv) / (last.dte - first.dte);
}

function computeIvVsRvRatio(ivAtm: number | null, realizedVol: number | null, realizedRangeProxy: number | null): number | null {
  const iv = ivDecimal(ivAtm);
  if (iv == null) return null;
  const rv = ivDecimal(realizedVol);
  if (rv != null && rv > 0) return iv / rv;
  const rr = finite(realizedRangeProxy);
  if (rr != null && rr > 0) return iv / rr;
  return null;
}

export function classifyVolRegime(
  input: VolInputs,
  cfg: Partial<VolClassifierConfig> = {},
): VolClassificationResult {
  const config = { ...defaultConfig(), ...cfg };
  const warnings: string[] = [];
  const missingInputs: string[] = [];

  const ivAtm = ivDecimal(finite(input.iv_atm));
  if (ivAtm == null) {
    missingInputs.push("iv_atm");
    warnings.push("ATM IV is missing.");
    return {
      regime: "UNKNOWN",
      features: {
        ivPercentile: null,
        ivVsRvRatio: null,
        termSlope: null,
        shockFlag: null,
        confidence: "LOW",
      },
      warnings,
      missingInputs,
      sampleCount: 0,
      lookbackDays: config.lookbackDays,
    };
  }

  const ivAge = finite(input.freshnessAges?.iv_atm);
  if (ivAge == null || ivAge > config.ivFreshMaxAgeMs) {
    warnings.push("ATM IV freshness is stale or unavailable.");
    missingInputs.push("iv_atm_freshness");
  }

  const percentileResult = computePercentile(
    ivAtm,
    input.iv_history_samples ?? [],
    config.lookbackDays,
    Date.parse(input.asOfIso),
  );
  const ivPercentile = percentileResult.percentile;
  if (percentileResult.sampleCount < config.minSamples) {
    warnings.push(`IV cache insufficient (${percentileResult.sampleCount}/${config.minSamples} samples).`);
    if (ivPercentile == null) {
      missingInputs.push("iv_history");
    }
  }

  const ivVsRvRatio = computeIvVsRvRatio(ivAtm, finite(input.realized_vol_5d), finite(input.realized_range_proxy));
  if (ivVsRvRatio == null) {
    warnings.push("Realized volatility proxy unavailable.");
    missingInputs.push("realized_vol");
  }

  const termSlope = computeTermSlope(input.iv_term);
  if (termSlope == null) {
    warnings.push("Term-structure slope unavailable.");
    missingInputs.push("iv_term");
  }

  let regime: VolRegime = "UNKNOWN";
  if (ivPercentile != null) {
    if (ivPercentile >= config.extremePercentile) regime = "VOL_EXTREME";
    else if (ivPercentile >= config.highPercentile) regime = "VOL_EXPANDING";
    else if (ivPercentile <= config.lowPercentile) regime = "VOL_SUPPRESSED";
    else regime = "VOL_NORMAL";
  } else if (ivVsRvRatio != null) {
    if (ivVsRvRatio >= config.ivVsRvExpanding) regime = "VOL_EXPANDING";
    else if (ivVsRvRatio <= config.ivVsRvSuppressed) regime = "VOL_SUPPRESSED";
    else regime = "VOL_NORMAL";
  } else if (termSlope != null) {
    if (termSlope > config.termSlopeExpanding) regime = "VOL_EXPANDING";
    else regime = "VOL_NORMAL";
  }

  const signalCount = [ivPercentile, ivVsRvRatio, termSlope].filter((v) => v != null).length;
  const confidence: VolFeatureConfidence =
    regime === "UNKNOWN" || signalCount <= 1
      ? "LOW"
      : signalCount >= 3 && percentileResult.sampleCount >= config.minSamples
        ? "HIGH"
        : "MED";

  return {
    regime,
    features: {
      ivPercentile,
      ivVsRvRatio: ivVsRvRatio == null ? null : Number(ivVsRvRatio.toFixed(4)),
      termSlope: termSlope == null ? null : Number(termSlope.toFixed(6)),
      shockFlag: null,
      confidence,
    },
    warnings: Array.from(new Set(warnings)),
    missingInputs: Array.from(new Set(missingInputs)),
    sampleCount: percentileResult.sampleCount,
    lookbackDays: config.lookbackDays,
  };
}
