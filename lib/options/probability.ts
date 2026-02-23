import type { CreditSpreadInput } from "@/lib/options/payoff";

export type ProbabilityConfidence = "LOW" | "MED" | "HIGH";

export type ProbabilityResult = {
  pop: number | null;
  probabilityOfTouch: number | null;
  probItmShort: number | null;
  confidence: ProbabilityConfidence;
  warning?: string;
};

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

export function normalizeIv(ivRaw: number | null | undefined): number | null {
  const iv = Number(ivRaw);
  if (!Number.isFinite(iv) || iv <= 0) return null;
  // Accept decimal IV (0.22) or percentage-like (22)
  return iv > 3 ? iv / 100 : iv;
}

function sigmaT(iv: number, dte: number): number {
  const t = Math.max(0, dte) / 365;
  return iv * Math.sqrt(t);
}

function logReturnZ(spot: number, strike: number, sigmaTimesSqrtT: number): number | null {
  if (!Number.isFinite(spot) || !Number.isFinite(strike) || spot <= 0 || strike <= 0) return null;
  if (!Number.isFinite(sigmaTimesSqrtT) || sigmaTimesSqrtT <= 0) return null;
  return Math.log(strike / spot) / sigmaTimesSqrtT;
}

function confidenceFromInputs(iv: number | null, dte: number | null): ProbabilityConfidence {
  if (iv == null || dte == null) return "LOW";
  if (dte >= 7 && dte <= 60 && iv >= 0.05 && iv <= 1.5) return "HIGH";
  return "MED";
}

export function computePopAndTouch(params: {
  spread: CreditSpreadInput;
  spot: number;
  dte: number | null | undefined;
  iv: number | null | undefined;
}): ProbabilityResult {
  const side = params.spread.side;
  const shortStrike = Number(params.spread.shortStrike);
  const credit = Number(params.spread.credit);
  const breakeven = side === "PUT_CREDIT" ? shortStrike - credit : shortStrike + credit;

  const iv = normalizeIv(params.iv);
  const dte = params.dte == null ? null : Number(params.dte);
  const confidence = confidenceFromInputs(iv, dte);

  if (iv == null || dte == null || !Number.isFinite(dte) || dte <= 0) {
    return {
      pop: null,
      probabilityOfTouch: null,
      probItmShort: null,
      confidence,
      warning: "PoP unavailable: missing/invalid IV or DTE.",
    };
  }

  const sigma = sigmaT(iv, dte);
  if (!Number.isFinite(sigma) || sigma <= 0) {
    return {
      pop: null,
      probabilityOfTouch: null,
      probItmShort: null,
      confidence,
      warning: "PoP unavailable: sigma*sqrt(T) invalid.",
    };
  }

  const zBreakeven = logReturnZ(params.spot, breakeven, sigma);
  const zShort = logReturnZ(params.spot, shortStrike, sigma);
  if (zBreakeven == null || zShort == null) {
    return {
      pop: null,
      probabilityOfTouch: null,
      probItmShort: null,
      confidence,
      warning: "PoP unavailable: invalid spot/strike inputs.",
    };
  }

  const pop =
    side === "PUT_CREDIT"
      ? clamp01(1 - normalCdf(zBreakeven))
      : clamp01(normalCdf(zBreakeven));

  const probItmShort =
    side === "PUT_CREDIT"
      ? clamp01(normalCdf(zShort))
      : clamp01(1 - normalCdf(zShort));

  const probabilityOfTouch = clamp01(2 * probItmShort);

  return {
    pop,
    probabilityOfTouch,
    probItmShort,
    confidence,
  };
}
