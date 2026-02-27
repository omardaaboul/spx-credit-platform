import type { DecisionCode } from "@/lib/contracts/decision";
import type { CandidateCard } from "@/lib/spx0dte";

export type ProbThresholds = {
  minPop: number;
  minRor: number;
  minCreditPct: number;
};

export type ProbEligibilityResult = {
  ok: boolean;
  reasonCode?: DecisionCode;
  reasonMessage?: string;
  pop: number | null;
  ror: number | null;
  creditPct: number | null;
};

export function isCreditSpreadVerticalCandidate(candidate: CandidateCard): boolean {
  if (/debit|butterfly|condor|fly/i.test(candidate.strategy)) return false;
  const puts = candidate.legs.filter((leg) => leg.type === "PUT");
  const calls = candidate.legs.filter((leg) => leg.type === "CALL");
  const isVertical = (puts.length === 2 && calls.length === 0) || (calls.length === 2 && puts.length === 0);
  if (!isVertical) return false;
  const premium = Number(candidate.adjustedPremium ?? candidate.premium ?? candidate.credit ?? 0);
  return Number.isFinite(premium) && premium > 0;
}

export function resolveCandidateCreditPct(candidate: CandidateCard): number | null {
  if (Number.isFinite(candidate.creditPct ?? Number.NaN)) {
    return Number(candidate.creditPct);
  }
  const credit = Number(candidate.adjustedPremium ?? candidate.premium ?? candidate.credit ?? 0);
  const width = Number(candidate.width ?? 0);
  if (!Number.isFinite(credit) || !Number.isFinite(width) || width <= 0) return null;
  return credit / width;
}

export function resolveCandidateRor(candidate: CandidateCard): number | null {
  if (Number.isFinite(candidate.ror ?? Number.NaN)) return Number(candidate.ror);
  const maxProfit = Number(candidate.maxProfit ?? Number.NaN);
  const maxLoss = Number(candidate.maxLoss ?? Number.NaN);
  if (!Number.isFinite(maxProfit) || !Number.isFinite(maxLoss) || maxLoss <= 0) return null;
  return maxProfit / maxLoss;
}

export function evaluateProbabilisticEligibility(
  candidate: CandidateCard,
  thresholds: ProbThresholds,
): ProbEligibilityResult {
  if (!isCreditSpreadVerticalCandidate(candidate)) {
    return {
      ok: false,
      reasonCode: "NO_CREDIT_SPREAD_CANDIDATE",
      reasonMessage: "Not a credit spread candidate.",
      pop: null,
      ror: null,
      creditPct: null,
    };
  }
  if (candidate.hardBlockCode === "INVALID_SPREAD_GEOMETRY") {
    return {
      ok: false,
      reasonCode: "INVALID_SPREAD_GEOMETRY",
      reasonMessage: candidate.hardBlockReason ?? "Invalid spread geometry.",
      pop: null,
      ror: null,
      creditPct: null,
    };
  }

  const pop = Number.isFinite(candidate.popPct ?? Number.NaN) ? Number(candidate.popPct) : null;
  const ror = resolveCandidateRor(candidate);
  const creditPct = resolveCandidateCreditPct(candidate);

  if (pop == null) {
    return {
      ok: false,
      reasonCode: "POP_UNAVAILABLE",
      reasonMessage: "PoP unavailable (missing IV/DTE).",
      pop,
      ror,
      creditPct,
    };
  }
  if (pop < thresholds.minPop) {
    return {
      ok: false,
      reasonCode: "POP_TOO_LOW",
      reasonMessage: `PoP ${pop.toFixed(2)} below ${thresholds.minPop.toFixed(2)}.`,
      pop,
      ror,
      creditPct,
    };
  }
  if (ror == null || ror < thresholds.minRor) {
    return {
      ok: false,
      reasonCode: "ROR_TOO_LOW",
      reasonMessage: `RoR ${ror == null ? "-" : ror.toFixed(2)} below ${thresholds.minRor.toFixed(2)}.`,
      pop,
      ror,
      creditPct,
    };
  }
  if (creditPct == null || creditPct < thresholds.minCreditPct) {
    return {
      ok: false,
      reasonCode: "CREDIT_PCT_TOO_LOW",
      reasonMessage: `Credit/width ${creditPct == null ? "-" : creditPct.toFixed(2)} below ${thresholds.minCreditPct.toFixed(2)}.`,
      pop,
      ror,
      creditPct,
    };
  }

  return { ok: true, pop, ror, creditPct };
}
