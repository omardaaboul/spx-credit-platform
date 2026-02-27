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

export type VerticalSide = CreditSpreadSide | "PUT_DEBIT" | "CALL_DEBIT";

export type PayoffResult = {
  valid: boolean;
  code?: "INVALID_SPREAD_GEOMETRY";
  maxProfit: number | null;
  maxLoss: number | null;
  ror: number | null;
  breakeven: number | null;
  breakevenLow?: number | null;
  breakevenHigh?: number | null;
  creditPct: number | null;
  width: number | null;
};

type BasePayoffInput = {
  credit: number;
  contracts?: number;
  multiplier?: number;
};

export type VerticalPayoffInput = BasePayoffInput & {
  side: VerticalSide;
  shortStrike: number;
  longStrike: number;
};

export type IronPayoffInput = BasePayoffInput & {
  shortPutStrike: number;
  shortCallStrike: number;
  width: number;
};

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

function invalidResult(): PayoffResult {
  return {
    valid: false,
    code: "INVALID_SPREAD_GEOMETRY",
    maxProfit: null,
    maxLoss: null,
    ror: null,
    breakeven: null,
    breakevenLow: null,
    breakevenHigh: null,
    creditPct: null,
    width: null,
  };
}

export function computeVerticalPayoff(input: VerticalPayoffInput): PayoffResult {
  const contracts = Number(input.contracts ?? 1);
  const multiplier = Number(input.multiplier ?? DEFAULT_MULTIPLIER);
  const credit = Number(input.credit);
  const shortStrike = Number(input.shortStrike);
  const longStrike = Number(input.longStrike);
  if (!Number.isFinite(contracts) || contracts <= 0) return invalidResult();
  if (!Number.isFinite(multiplier) || multiplier <= 0) return invalidResult();
  if (!Number.isFinite(credit) || credit <= 0) return invalidResult();
  if (!Number.isFinite(shortStrike) || !Number.isFinite(longStrike)) return invalidResult();

  const width = Math.abs(shortStrike - longStrike);
  if (!Number.isFinite(width) || width <= 0) return invalidResult();
  if (credit >= width) return invalidResult();

  const creditPct = credit / width;
  const maxProfitPoints = input.side.endsWith("CREDIT") ? credit : width - credit;
  const maxLossPoints = input.side.endsWith("CREDIT") ? width - credit : credit;

  const maxProfit = maxProfitPoints * multiplier * contracts;
  const maxLoss = maxLossPoints * multiplier * contracts;
  const ror = maxLoss > 0 ? maxProfit / maxLoss : null;

  let breakeven: number | null = null;
  if (input.side === "PUT_CREDIT") breakeven = shortStrike - credit;
  if (input.side === "CALL_CREDIT") breakeven = shortStrike + credit;
  if (input.side === "PUT_DEBIT") breakeven = longStrike - credit;
  if (input.side === "CALL_DEBIT") breakeven = longStrike + credit;

  return {
    valid: true,
    maxProfit,
    maxLoss,
    ror,
    breakeven,
    creditPct,
    width,
  };
}

export function computeIronPayoff(input: IronPayoffInput): PayoffResult {
  const contracts = Number(input.contracts ?? 1);
  const multiplier = Number(input.multiplier ?? DEFAULT_MULTIPLIER);
  const credit = Number(input.credit);
  const shortPutStrike = Number(input.shortPutStrike);
  const shortCallStrike = Number(input.shortCallStrike);
  const width = Number(input.width);
  if (!Number.isFinite(contracts) || contracts <= 0) return invalidResult();
  if (!Number.isFinite(multiplier) || multiplier <= 0) return invalidResult();
  if (!Number.isFinite(credit) || credit <= 0) return invalidResult();
  if (!Number.isFinite(shortPutStrike) || !Number.isFinite(shortCallStrike)) return invalidResult();
  if (!Number.isFinite(width) || width <= 0) return invalidResult();
  if (shortPutStrike >= shortCallStrike) return invalidResult();
  if (credit >= width) return invalidResult();

  const creditPct = credit / width;
  const maxProfit = credit * multiplier * contracts;
  const maxLoss = (width - credit) * multiplier * contracts;
  const ror = maxLoss > 0 ? maxProfit / maxLoss : null;
  const breakevenLow = shortPutStrike - credit;
  const breakevenHigh = shortCallStrike + credit;

  return {
    valid: true,
    maxProfit,
    maxLoss,
    ror,
    breakeven: null,
    breakevenLow,
    breakevenHigh,
    creditPct,
    width,
  };
}
