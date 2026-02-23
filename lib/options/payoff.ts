export type CreditSpreadSide = "PUT_CREDIT" | "CALL_CREDIT";

export type CreditSpreadInput = {
  side: CreditSpreadSide;
  shortStrike: number;
  longStrike: number;
  credit: number;
  width: number;
  contracts?: number;
  multiplier?: number;
};

export type PayoffPoint = {
  x: number;
  y: number;
};

export const DEFAULT_MULTIPLIER = 100;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalize(input: CreditSpreadInput) {
  const contracts = Math.max(1, Math.round(Number(input.contracts ?? 1)));
  const multiplier = Math.max(1, Number(input.multiplier ?? DEFAULT_MULTIPLIER));
  const width = Math.max(0, Number(input.width));
  const shortStrike = Number(input.shortStrike);
  const longStrike = Number(input.longStrike);
  const credit = Number(input.credit);
  return {
    side: input.side,
    shortStrike,
    longStrike,
    credit,
    width,
    contracts,
    multiplier,
  };
}

export function computeBreakeven(input: CreditSpreadInput): number {
  const n = normalize(input);
  return n.side === "PUT_CREDIT" ? n.shortStrike - n.credit : n.shortStrike + n.credit;
}

export function computeMaxProfit(input: CreditSpreadInput): number {
  const n = normalize(input);
  return n.credit * n.multiplier * n.contracts;
}

export function computeMaxLoss(input: CreditSpreadInput): number {
  const n = normalize(input);
  return Math.max(0, (n.width - n.credit) * n.multiplier * n.contracts);
}

export function expirationPnl(input: CreditSpreadInput, underlying: number): number {
  const n = normalize(input);
  const intrinsicSpreadValuePerPoint =
    n.side === "PUT_CREDIT"
      ? clamp(n.shortStrike - underlying, 0, n.width)
      : clamp(underlying - n.shortStrike, 0, n.width);

  return (n.credit - intrinsicSpreadValuePerPoint) * n.multiplier * n.contracts;
}

export function buildExpirationPayoffCurve(
  input: CreditSpreadInput,
  spot: number,
  rangePct = 0.12,
  points = 120,
): PayoffPoint[] {
  const safeSpot = Number.isFinite(spot) && spot > 0 ? spot : 1;
  const pCount = Math.max(20, Math.min(500, Math.round(points)));
  const pct = Math.max(0.02, Math.min(0.5, rangePct));
  const start = safeSpot * (1 - pct);
  const end = safeSpot * (1 + pct);
  const step = (end - start) / (pCount - 1);

  const out: PayoffPoint[] = [];
  for (let i = 0; i < pCount; i += 1) {
    const x = Number((start + step * i).toFixed(2));
    out.push({ x, y: expirationPnl(input, x) });
  }
  return out;
}

export function computeCurrentPnlFromMark(input: CreditSpreadInput, currentMark: number): number {
  const n = normalize(input);
  const mark = Number(currentMark);
  if (!Number.isFinite(mark)) return Number.NaN;
  return (n.credit - mark) * n.multiplier * n.contracts;
}

export function inferWidth(shortStrike: number, longStrike: number): number {
  const width = Math.abs(Number(shortStrike) - Number(longStrike));
  return Number.isFinite(width) ? width : 0;
}
