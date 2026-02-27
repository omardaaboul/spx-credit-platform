import type { CandidateCard } from "@/lib/spx0dte";
import { computeIronPayoff, computeVerticalPayoff, type IronPayoffInput, type VerticalSide } from "@/lib/options/payoff";
import { computePopIron, computePopVertical, estimateEvIron, estimateEvVertical } from "@/lib/options/probability";
import { parseDteFromStrategy } from "@/lib/engine/dte";

export type CandidateMetricContext = {
  spot: number | null;
  ivAtm: number | null;
  ivFreshMs?: number | null;
  ivFreshMaxAgeMs?: number;
  decisionMode: "STRICT" | "PROBABILISTIC";
};

export type CandidateMetricResult = {
  candidate: CandidateCard;
  hardBlockCode?: "INVALID_SPREAD_GEOMETRY";
};

function candidateCredit(candidate: CandidateCard): number {
  if (typeof candidate.adjustedPremium === "number") return candidate.adjustedPremium;
  if (typeof candidate.premium === "number") return candidate.premium;
  return candidate.credit;
}

function isDebitStrategy(strategy: string): boolean {
  return /debit/i.test(strategy);
}

function detectVertical(candidate: CandidateCard): { side: VerticalSide; shortStrike: number; longStrike: number; width: number } | null {
  if (!Array.isArray(candidate.legs) || candidate.legs.length !== 2) return null;
  const shortLeg = candidate.legs.find((leg) => leg.action === "SELL");
  const longLeg = candidate.legs.find((leg) => leg.action === "BUY");
  if (!shortLeg || !longLeg) return null;
  if (shortLeg.type !== longLeg.type) return null;
  const width = Math.abs(shortLeg.strike - longLeg.strike);
  if (!Number.isFinite(width) || width <= 0) return null;

  if (shortLeg.type === "PUT") {
    return {
      side: isDebitStrategy(candidate.strategy) ? "PUT_DEBIT" : "PUT_CREDIT",
      shortStrike: shortLeg.strike,
      longStrike: longLeg.strike,
      width,
    };
  }
  return {
    side: isDebitStrategy(candidate.strategy) ? "CALL_DEBIT" : "CALL_CREDIT",
    shortStrike: shortLeg.strike,
    longStrike: longLeg.strike,
    width,
  };
}

function detectIron(candidate: CandidateCard): { shortPut: number; shortCall: number; width: number } | null {
  if (!/iron/i.test(candidate.strategy)) return null;
  if (!Array.isArray(candidate.legs) || candidate.legs.length < 4) return null;
  const shortPut = candidate.legs.find((leg) => leg.action === "SELL" && leg.type === "PUT");
  const shortCall = candidate.legs.find((leg) => leg.action === "SELL" && leg.type === "CALL");
  const longPut = candidate.legs.find((leg) => leg.action === "BUY" && leg.type === "PUT");
  const longCall = candidate.legs.find((leg) => leg.action === "BUY" && leg.type === "CALL");
  if (!shortPut || !shortCall || !longPut || !longCall) return null;
  const widthPut = Math.abs(shortPut.strike - longPut.strike);
  const widthCall = Math.abs(shortCall.strike - longCall.strike);
  const width = Math.min(widthPut, widthCall);
  if (!Number.isFinite(width) || width <= 0) return null;
  return { shortPut: shortPut.strike, shortCall: shortCall.strike, width };
}

function resolveDte(candidate: CandidateCard): number | null {
  if (Number.isFinite(Number(candidate.daysToExpiry)) && Number(candidate.daysToExpiry) >= 0) {
    return Number(candidate.daysToExpiry);
  }
  const parsed = parseDteFromStrategy(candidate.strategy);
  return parsed != null ? parsed : null;
}

export function attachCandidateMetrics(candidate: CandidateCard, ctx: CandidateMetricContext): CandidateMetricResult {
  const credit = candidateCredit(candidate);
  const dte = resolveDte(candidate);
  const seedKey = String(candidate.candidateId ?? `${candidate.strategy}:${credit}:${candidate.width}:${dte ?? "na"}`);
  const baseCandidate: CandidateCard = { ...candidate };

  const iron = detectIron(candidate);
  if (iron) {
    const payoff = computeIronPayoff({
      shortPutStrike: iron.shortPut,
      shortCallStrike: iron.shortCall,
      width: iron.width,
      credit,
      multiplier: 100,
      contracts: 1,
    });
    if (!payoff.valid) {
      return { candidate: baseCandidate, hardBlockCode: "INVALID_SPREAD_GEOMETRY" };
    }
    const pop = computePopIron({
      breakevenLow: Number(payoff.breakevenLow ?? 0),
      breakevenHigh: Number(payoff.breakevenHigh ?? 0),
      shortPutStrike: iron.shortPut,
      shortCallStrike: iron.shortCall,
      spot: ctx.spot,
      iv: ctx.ivAtm ?? candidate.greeks?.iv ?? null,
      dte,
      ivFreshMs: ctx.ivFreshMs,
      ivFreshMaxAgeMs: ctx.ivFreshMaxAgeMs,
    });
    const ev = estimateEvIron({
      shortPutStrike: iron.shortPut,
      shortCallStrike: iron.shortCall,
      width: iron.width,
      credit,
      spot: ctx.spot,
      iv: ctx.ivAtm ?? candidate.greeks?.iv ?? null,
      dte,
      ivFreshMs: ctx.ivFreshMs,
      ivFreshMaxAgeMs: ctx.ivFreshMaxAgeMs,
      seedKey,
    });

    const warnings = [...(candidate.warnings ?? []), ...pop.warnings, ...ev.warnings].filter(Boolean);
    return {
      candidate: {
        ...baseCandidate,
        maxProfit: payoff.maxProfit,
        maxLoss: payoff.maxLoss,
        ror: payoff.ror,
        breakevenLow: payoff.breakevenLow,
        breakevenHigh: payoff.breakevenHigh,
        creditPct: payoff.creditPct,
        popPct: pop.pop ?? null,
        probTouch: pop.probTouch ?? undefined,
        popConfidence: pop.confidence,
        ev: ev.ev,
        evRor: ev.evRor,
        warnings: warnings.length > 0 ? Array.from(new Set(warnings)).slice(0, 3) : candidate.warnings,
      },
    };
  }

  const vertical = detectVertical(candidate);
  if (vertical) {
    const payoff = computeVerticalPayoff({
      side: vertical.side,
      shortStrike: vertical.shortStrike,
      longStrike: vertical.longStrike,
      credit,
      multiplier: 100,
      contracts: 1,
    });
    if (!payoff.valid) {
      return { candidate: baseCandidate, hardBlockCode: "INVALID_SPREAD_GEOMETRY" };
    }
    const pop = computePopVertical({
      side: vertical.side,
      breakeven: Number(payoff.breakeven ?? 0),
      shortStrike: vertical.shortStrike,
      spot: ctx.spot,
      iv: ctx.ivAtm ?? candidate.greeks?.iv ?? null,
      dte,
      ivFreshMs: ctx.ivFreshMs,
      ivFreshMaxAgeMs: ctx.ivFreshMaxAgeMs,
    });
    const ev = estimateEvVertical({
      side: vertical.side,
      shortStrike: vertical.shortStrike,
      longStrike: vertical.longStrike,
      width: vertical.width,
      breakeven: Number(payoff.breakeven ?? 0),
      credit,
      spot: ctx.spot,
      iv: ctx.ivAtm ?? candidate.greeks?.iv ?? null,
      dte,
      ivFreshMs: ctx.ivFreshMs,
      ivFreshMaxAgeMs: ctx.ivFreshMaxAgeMs,
      seedKey,
    });
    const warnings = [...(candidate.warnings ?? []), ...pop.warnings, ...ev.warnings].filter(Boolean);
    return {
      candidate: {
        ...baseCandidate,
        maxProfit: payoff.maxProfit,
        maxLoss: payoff.maxLoss,
        ror: payoff.ror,
        breakeven: payoff.breakeven,
        creditPct: payoff.creditPct,
        popPct: pop.pop ?? null,
        probTouch: pop.probTouch ?? undefined,
        popConfidence: pop.confidence,
        ev: ev.ev,
        evRor: ev.evRor,
        warnings: warnings.length > 0 ? Array.from(new Set(warnings)).slice(0, 3) : candidate.warnings,
      },
    };
  }

  return { candidate: baseCandidate };
}
