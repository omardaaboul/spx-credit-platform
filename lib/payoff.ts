export const DEFAULT_CONTRACT_MULTIPLIER = 100;

export type PayoffLeg = {
  action: "BUY" | "SELL";
  right: "CALL" | "PUT";
  strike: number;
  qty?: number;
  premium: number;
  impliedVol?: number | null;
};

export type PayoffCandidate = {
  strategyName: string;
  spot: number;
  emr: number;
  legs: PayoffLeg[];
  netCredit: number;
  maxRisk?: number;
  popEstimate?: number | null;
  width?: number;
  baseIv?: number | null;
  timeToExpiryYears?: number | null;
  riskFreeRate?: number;
  step?: number;
};

export type PayoffSeries = {
  x: number[];
  y: number[];
};

export type BreakevenPoint = {
  price: number;
};

export function computeExpirationPayoff(
  legs: PayoffLeg[],
  underlyingAtExpiry: number,
  multiplier = DEFAULT_CONTRACT_MULTIPLIER,
): number {
  return legs.reduce((total, leg) => {
    const qty = Math.max(1, leg.qty ?? 1);
    const intrinsic =
      leg.right === "CALL"
        ? Math.max(underlyingAtExpiry - leg.strike, 0)
        : Math.max(leg.strike - underlyingAtExpiry, 0);
    const legPnlPerContract =
      leg.action === "BUY" ? intrinsic - leg.premium : leg.premium - intrinsic;
    return total + qty * multiplier * legPnlPerContract;
  }, 0);
}

export function buildPayoffSeries(
  candidate: Pick<PayoffCandidate, "spot" | "emr" | "legs">,
  multiplier = DEFAULT_CONTRACT_MULTIPLIER,
): PayoffSeries {
  const spot = candidate.spot;
  const emr = Math.max(candidate.emr, 1);
  const rawStart = spot - 2 * emr;
  const rawEnd = spot + 2 * emr;
  const start = Math.max(100, Math.floor(rawStart));
  const end = Math.max(start + 10, Math.ceil(rawEnd));
  const step = emr < 40 ? 2 : 5;

  const x: number[] = [];
  for (let price = start; price <= end; price += step) {
    x.push(Number(price.toFixed(2)));
  }
  if (x[x.length - 1] !== end) {
    x.push(end);
  }

  const y = x.map((price) => computeExpirationPayoff(candidate.legs, price, multiplier));
  return { x, y };
}

export function buildPayoffSeriesWithConfig(
  candidate: Pick<PayoffCandidate, "spot" | "emr" | "legs" | "step">,
  multiplier = DEFAULT_CONTRACT_MULTIPLIER,
): PayoffSeries {
  const spot = candidate.spot;
  const emr = Math.max(candidate.emr, 1);
  const rawStart = spot - 2 * emr;
  const rawEnd = spot + 2 * emr;
  const start = Math.max(100, Math.floor(rawStart));
  const end = Math.max(start + 10, Math.ceil(rawEnd));
  const defaultStep = emr < 40 ? 2 : 5;
  const step = Math.max(1, Math.floor(candidate.step ?? defaultStep));

  const x: number[] = [];
  for (let price = start; price <= end; price += step) {
    x.push(Number(price.toFixed(2)));
  }
  if (x[x.length - 1] !== end) {
    x.push(end);
  }

  const y = x.map((price) => computeExpirationPayoff(candidate.legs, price, multiplier));
  return { x, y };
}

export function computeBreakevens(x: number[], y: number[]): BreakevenPoint[] {
  if (x.length !== y.length || x.length < 2) return [];
  const points: BreakevenPoint[] = [];

  for (let i = 1; i < x.length; i += 1) {
    const x0 = x[i - 1];
    const x1 = x[i];
    const y0 = y[i - 1];
    const y1 = y[i];

    if (y0 === 0) {
      points.push({ price: x0 });
      continue;
    }
    if ((y0 > 0 && y1 > 0) || (y0 < 0 && y1 < 0)) {
      continue;
    }
    const denom = y1 - y0;
    if (denom === 0) continue;
    const t = -y0 / denom;
    const price = x0 + t * (x1 - x0);
    points.push({ price: Number(price.toFixed(2)) });
  }

  const deduped: BreakevenPoint[] = [];
  for (const point of points) {
    const exists = deduped.some((p) => Math.abs(p.price - point.price) < 0.05);
    if (!exists) deduped.push(point);
  }
  return deduped;
}

export function computeMaxProfitLoss(y: number[]): { maxProfit: number; maxLoss: number } {
  if (y.length === 0) return { maxProfit: 0, maxLoss: 0 };
  const maxProfit = Math.max(...y);
  const maxLoss = Math.min(...y);
  return { maxProfit, maxLoss };
}

export function buildTodayPayoffSeries(
  candidate: Pick<PayoffCandidate, "legs" | "spot" | "emr" | "baseIv" | "timeToExpiryYears" | "riskFreeRate" | "step">,
  multiplier = DEFAULT_CONTRACT_MULTIPLIER,
): PayoffSeries | null {
  const timeToExpiryYears = candidate.timeToExpiryYears;
  if (timeToExpiryYears == null || !Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) {
    return null;
  }

  const series = buildPayoffSeriesWithConfig(candidate, multiplier);
  const riskFreeRate = candidate.riskFreeRate ?? 0.045;
  const hasAnyIv = candidate.legs.some(
    (leg) => Number.isFinite(leg.impliedVol ?? Number.NaN) || Number.isFinite(candidate.baseIv ?? Number.NaN),
  );
  if (!hasAnyIv) return null;

  const y = series.x.map((underlying) =>
    candidate.legs.reduce((total, leg) => {
      const sigma = sanitizeSigma(leg.impliedVol ?? candidate.baseIv ?? null);
      if (sigma == null) return Number.NaN;
      const theo = blackScholesPrice({
        right: leg.right,
        spot: underlying,
        strike: leg.strike,
        sigma,
        timeToExpiryYears,
        riskFreeRate,
      });
      const qty = Math.max(1, leg.qty ?? 1);
      const pnlPerContract = leg.action === "BUY" ? theo - leg.premium : leg.premium - theo;
      return total + qty * multiplier * pnlPerContract;
    }, 0),
  );

  if (y.some((v) => Number.isNaN(v))) return null;
  return { x: series.x, y };
}

function sanitizeSigma(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  // Accept both decimal IV (0.18) and percentage format (18.0)
  return value > 3 ? value / 100 : value;
}

type BlackScholesInput = {
  right: "CALL" | "PUT";
  spot: number;
  strike: number;
  sigma: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
};

function blackScholesPrice(input: BlackScholesInput): number {
  const { right, spot, strike, sigma, timeToExpiryYears, riskFreeRate } = input;
  if (timeToExpiryYears <= 0 || sigma <= 0) {
    return right === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }
  if (spot <= 0 || strike <= 0) return 0;

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * sigma * sigma) * timeToExpiryYears) /
    (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  if (right === "CALL") {
    return spot * normalCdf(d1) - strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normalCdf(d2);
  }
  return strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normalCdf(-d2) - spot * normalCdf(-d1);
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
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
