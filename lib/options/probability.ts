import { DEFAULT_MULTIPLIER, type CreditSpreadInput, type IronPayoffInput, type VerticalPayoffInput, type VerticalSide } from "@/lib/options/payoff";

export type ProbabilityConfidence = "LOW" | "MED" | "HIGH";

export type ProbabilityResult = {
  pop: number | null;
  probabilityOfTouch: number | null;
  probItmShort: number | null;
  confidence: ProbabilityConfidence;
  warning?: string;
};

export type ProbConfidence = "HIGH" | "LOW";

export type PopResult = {
  pop: number | null;
  probTouch: number | null;
  confidence: ProbConfidence;
  warnings: string[];
};

export type EvResult = {
  ev: number | null;
  evRor: number | null;
  paths: number;
  seed: number;
  warnings: string[];
};

type ProbInputs = {
  spot: number | null;
  iv: number | null;
  dte: number | null;
  ivFreshMs?: number | null;
  ivFreshMaxAgeMs?: number;
};

const DEFAULT_PATHS = 5000;

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

function lognormalCdf(spot: number, sigma: number, strike: number): number | null {
  if (sigma <= 0 || spot <= 0 || strike <= 0) return null;
  const mu = Math.log(spot) - 0.5 * sigma * sigma;
  const z = (Math.log(strike) - mu) / sigma;
  return normalCdf(z);
}

function validateInputs(inputs: ProbInputs): { ok: boolean; warnings: string[]; sigma: number | null } {
  const warnings: string[] = [];
  const spot = Number(inputs.spot);
  const iv = normalizeIv(inputs.iv);
  const dte = inputs.dte == null ? null : Number(inputs.dte);

  if (!Number.isFinite(spot) || spot <= 0) warnings.push("Missing spot");
  if (iv == null || !Number.isFinite(iv) || iv <= 0) warnings.push("Missing IV");
  if (dte == null || !Number.isFinite(dte) || dte < 0) warnings.push("Missing DTE");

  const maxAge = inputs.ivFreshMaxAgeMs ?? Number(process.env.VOL_IV_MAX_AGE_MS ?? 5_000);
  if (inputs.ivFreshMs != null && inputs.ivFreshMs > maxAge) warnings.push("IV freshness stale");

  if (warnings.length > 0) {
    return { ok: false, warnings, sigma: null };
  }

  const dteUsed = Math.max(1, Number(dte ?? 0));
  const tYears = dteUsed / 365;
  const sigma = Number(iv ?? 0) * Math.sqrt(tYears);
  return { ok: true, warnings: [], sigma };
}

export function computePopVertical(
  inputs: ProbInputs & {
    side: VerticalSide;
    breakeven: number;
    shortStrike: number;
  },
): PopResult {
  const validation = validateInputs(inputs);
  if (!validation.ok || validation.sigma == null) {
    return { pop: null, probTouch: null, confidence: "LOW", warnings: validation.warnings };
  }
  const sigma = validation.sigma;
  const spot = Number(inputs.spot ?? 0);
  const breakeven = Number(inputs.breakeven);
  const shortStrike = Number(inputs.shortStrike);
  const cdfBreakeven = lognormalCdf(spot, sigma, breakeven);
  const cdfShort = lognormalCdf(spot, sigma, shortStrike);
  if (cdfBreakeven == null || cdfShort == null) {
    return { pop: null, probTouch: null, confidence: "LOW", warnings: ["Invalid lognormal inputs"] };
  }

  let pop: number;
  if (inputs.side === "PUT_CREDIT") {
    pop = 1 - cdfBreakeven;
  } else if (inputs.side === "CALL_CREDIT") {
    pop = cdfBreakeven;
  } else if (inputs.side === "PUT_DEBIT") {
    pop = cdfBreakeven;
  } else {
    pop = 1 - cdfBreakeven;
  }

  const probItm = inputs.side.startsWith("PUT") ? cdfShort : 1 - cdfShort;
  const probTouch = Math.min(1, 2 * probItm);

  return {
    pop: Math.min(1, Math.max(0, pop)),
    probTouch: Math.min(1, Math.max(0, probTouch)),
    confidence: "HIGH",
    warnings: [],
  };
}

export function computePopIron(
  inputs: ProbInputs & {
    breakevenLow: number;
    breakevenHigh: number;
    shortPutStrike: number;
    shortCallStrike: number;
  },
): PopResult {
  const validation = validateInputs(inputs);
  if (!validation.ok || validation.sigma == null) {
    return { pop: null, probTouch: null, confidence: "LOW", warnings: validation.warnings };
  }
  const sigma = validation.sigma;
  const spot = Number(inputs.spot ?? 0);
  const cdfLow = lognormalCdf(spot, sigma, Number(inputs.breakevenLow));
  const cdfHigh = lognormalCdf(spot, sigma, Number(inputs.breakevenHigh));
  if (cdfLow == null || cdfHigh == null) {
    return { pop: null, probTouch: null, confidence: "LOW", warnings: ["Invalid lognormal inputs"] };
  }
  const pop = Math.min(1, Math.max(0, cdfHigh - cdfLow));

  const cdfShortPut = lognormalCdf(spot, sigma, Number(inputs.shortPutStrike));
  const cdfShortCall = lognormalCdf(spot, sigma, Number(inputs.shortCallStrike));
  if (cdfShortPut == null || cdfShortCall == null) {
    return { pop, probTouch: null, confidence: "HIGH", warnings: [] };
  }
  const probItmPut = cdfShortPut;
  const probItmCall = 1 - cdfShortCall;
  const probTouch = Math.min(1, 2 * Math.max(probItmPut, probItmCall));

  return {
    pop,
    probTouch,
    confidence: "HIGH",
    warnings: [],
  };
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) || 1;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function normalSample(rng: () => number): number {
  const u1 = Math.max(1e-12, rng());
  const u2 = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function simulateSt(spot: number, sigma: number, z: number): number {
  const mu = Math.log(spot) - 0.5 * sigma * sigma;
  return Math.exp(mu + sigma * z);
}

export function estimateEvVertical(
  inputs: ProbInputs &
    VerticalPayoffInput & {
      breakeven: number;
      width: number;
      paths?: number;
      seedKey: string;
    },
): EvResult {
  const validation = validateInputs(inputs);
  const warnings: string[] = [...validation.warnings];
  if (!validation.ok || validation.sigma == null) {
    return { ev: null, evRor: null, paths: inputs.paths ?? DEFAULT_PATHS, seed: hashSeed(inputs.seedKey), warnings };
  }
  const sigma = validation.sigma;
  const spot = Number(inputs.spot ?? 0);
  const credit = Number(inputs.credit);
  const width = Number(inputs.width);
  if (!Number.isFinite(credit) || !Number.isFinite(width)) {
    return { ev: null, evRor: null, paths: inputs.paths ?? DEFAULT_PATHS, seed: hashSeed(inputs.seedKey), warnings: ["Invalid credit/width"] };
  }
  const multiplier = Number(inputs.multiplier ?? DEFAULT_MULTIPLIER);
  const contracts = Number(inputs.contracts ?? 1);
  const maxLoss = inputs.side.endsWith("CREDIT") ? (width - credit) * multiplier * contracts : credit * multiplier * contracts;
  if (!Number.isFinite(maxLoss) || maxLoss <= 0) {
    return { ev: null, evRor: null, paths: inputs.paths ?? DEFAULT_PATHS, seed: hashSeed(inputs.seedKey), warnings: ["Invalid max loss"] };
  }

  const seed = hashSeed(inputs.seedKey);
  const rng = mulberry32(seed);
  const paths = Math.max(500, Math.min(20000, Number(inputs.paths ?? DEFAULT_PATHS)));
  let sum = 0;

  for (let i = 0; i < paths; i += 1) {
    const st = simulateSt(spot, sigma, normalSample(rng));
    let intrinsic = 0;
    if (inputs.side === "PUT_CREDIT") {
      intrinsic = Math.min(width, Math.max(0, inputs.shortStrike - st));
      sum += (credit - intrinsic) * multiplier * contracts;
    } else if (inputs.side === "CALL_CREDIT") {
      intrinsic = Math.min(width, Math.max(0, st - inputs.shortStrike));
      sum += (credit - intrinsic) * multiplier * contracts;
    } else if (inputs.side === "PUT_DEBIT") {
      intrinsic = Math.min(width, Math.max(0, inputs.longStrike - st));
      sum += (intrinsic - credit) * multiplier * contracts;
    } else {
      intrinsic = Math.min(width, Math.max(0, st - inputs.longStrike));
      sum += (intrinsic - credit) * multiplier * contracts;
    }
  }

  const ev = sum / paths;
  const evRor = maxLoss > 0 ? ev / maxLoss : null;
  return { ev, evRor, paths, seed, warnings };
}

export function estimateEvIron(
  inputs: ProbInputs &
    IronPayoffInput & {
      paths?: number;
      seedKey: string;
    },
): EvResult {
  const validation = validateInputs(inputs);
  const warnings: string[] = [...validation.warnings];
  if (!validation.ok || validation.sigma == null) {
    return { ev: null, evRor: null, paths: inputs.paths ?? DEFAULT_PATHS, seed: hashSeed(inputs.seedKey), warnings };
  }
  const sigma = validation.sigma;
  const spot = Number(inputs.spot ?? 0);
  const credit = Number(inputs.credit ?? 0);
  const width = Number(inputs.width ?? 0);
  const multiplier = Number(inputs.multiplier ?? DEFAULT_MULTIPLIER);
  const contracts = Number(inputs.contracts ?? 1);
  if (!Number.isFinite(credit) || !Number.isFinite(width) || width <= 0) {
    return { ev: null, evRor: null, paths: inputs.paths ?? DEFAULT_PATHS, seed: hashSeed(inputs.seedKey), warnings: ["Invalid credit/width"] };
  }

  const maxLoss = (width - credit) * multiplier * contracts;
  if (!Number.isFinite(maxLoss) || maxLoss <= 0) {
    return { ev: null, evRor: null, paths: inputs.paths ?? DEFAULT_PATHS, seed: hashSeed(inputs.seedKey), warnings: ["Invalid max loss"] };
  }

  const seed = hashSeed(inputs.seedKey);
  const rng = mulberry32(seed);
  const paths = Math.max(500, Math.min(20000, Number(inputs.paths ?? DEFAULT_PATHS)));
  let sum = 0;

  for (let i = 0; i < paths; i += 1) {
    const st = simulateSt(spot, sigma, normalSample(rng));
    const intrinsicPut = Math.max(0, inputs.shortPutStrike - st);
    const intrinsicCall = Math.max(0, st - inputs.shortCallStrike);
    const intrinsic = Math.min(width, Math.max(intrinsicPut, intrinsicCall));
    sum += (credit - intrinsic) * multiplier * contracts;
  }

  const ev = sum / paths;
  const evRor = maxLoss > 0 ? ev / maxLoss : null;
  return { ev, evRor, paths, seed, warnings };
}
