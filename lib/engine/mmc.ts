const Z_THRESHOLD_MAP: Record<number, number> = {
  45: 1.0,
  30: 1.1,
  14: 1.3,
  7: 1.5,
  2: 1.7,
};

const MMC_STRETCH_MAP: Record<number, number> = {
  45: 0.85,
  30: 1.0,
  14: 1.25,
  7: 1.55,
  2: 1.9,
};

export type MmcDirection = "BULL_PUT" | "BEAR_CALL";

export function measuredMoveCompletionPass(input: {
  spot: number;
  prevSpot: number;
  ema20: number;
  prevEma20: number;
  em1sd: number;
  zScore: number;
  macdHist: number;
  macdHistPrev: number;
  direction: MmcDirection;
  dte: number;
  enforceNotStillExtending?: boolean;
}): boolean {
  if (!Number.isFinite(input.spot) || !Number.isFinite(input.ema20) || !Number.isFinite(input.em1sd) || input.em1sd <= 0) {
    return false;
  }
  const bucket = [45, 30, 14, 7, 2].find((x) => x === Math.round(input.dte)) ?? 2;
  const zThreshold = Z_THRESHOLD_MAP[bucket];
  const mmcStretch = MMC_STRETCH_MAP[bucket];

  const stretchRatio = Math.abs(input.spot - input.ema20) / input.em1sd;
  const zOk = Math.abs(input.zScore) >= zThreshold;
  const stretchOk = stretchRatio >= mmcStretch;
  const momentumOk =
    input.direction === "BULL_PUT" ? input.macdHist > input.macdHistPrev : input.macdHist < input.macdHistPrev;
  const zSignOk = input.direction === "BULL_PUT" ? input.zScore <= 0 : input.zScore >= 0;

  if (!(zOk && stretchOk && momentumOk && zSignOk)) return false;
  if (bucket > 7 || !input.enforceNotStillExtending) return true;

  if (!Number.isFinite(input.prevSpot) || !Number.isFinite(input.prevEma20)) return false;
  const stretchNow = Math.abs(input.spot - input.ema20);
  const stretchPrev = Math.abs(input.prevSpot - input.prevEma20);
  return stretchNow <= stretchPrev;
}

