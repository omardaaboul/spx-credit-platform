export function expectedMove1Sd(spot: number, ivAtm: number, dte: number): number {
  if (!Number.isFinite(spot) || !Number.isFinite(ivAtm) || !Number.isFinite(dte)) return NaN;
  if (spot <= 0 || ivAtm <= 0 || dte <= 0) return NaN;
  return spot * ivAtm * Math.sqrt(dte / 365);
}

