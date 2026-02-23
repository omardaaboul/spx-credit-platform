import type { CandidateCard } from "@/lib/spx0dte";
import type { RankedCandidate } from "@/lib/contracts/decision";
import { parseDteFromStrategy } from "@/lib/engine/dte";

const DELTA_BANDS: Record<number, [number, number]> = {
  45: [0.18, 0.28],
  30: [0.16, 0.26],
  14: [0.12, 0.2],
  7: [0.06, 0.12],
  2: [0.03, 0.07],
};

function absDeltaMidpointFit(candidate: CandidateCard): number {
  const dte = parseDteFromStrategy(candidate.strategy) ?? 2;
  const band = DELTA_BANDS[dte] ?? DELTA_BANDS[2];
  const midpoint = (band[0] + band[1]) / 2;
  const shortLeg = candidate.legs.find((leg) => leg.action === "SELL");
  const absDelta = Math.abs(Number(shortLeg?.delta ?? 0));
  return Math.abs(absDelta - midpoint);
}

function creditWidth(candidate: CandidateCard): number {
  const premium = typeof candidate.adjustedPremium === "number"
    ? candidate.adjustedPremium
    : typeof candidate.premium === "number"
      ? candidate.premium
      : candidate.credit;
  if (!Number.isFinite(premium) || !Number.isFinite(candidate.width) || candidate.width <= 0) return 0;
  return premium / candidate.width;
}

function gammaPenalty(candidate: CandidateCard): number {
  const dte = parseDteFromStrategy(candidate.strategy) ?? 2;
  const absGamma = Math.abs(Number(candidate.greeks?.gamma ?? 0));
  if (!Number.isFinite(absGamma)) return Number.POSITIVE_INFINITY;
  return dte <= 14 ? absGamma : absGamma * 0.5;
}

function stableCandidateId(candidate: CandidateCard): string {
  return String(candidate.candidateId ?? `${candidate.strategy}:${candidate.width}:${candidate.maxRisk}`);
}

export function rankCandidatesDeterministic(candidates: CandidateCard[]): RankedCandidate[] {
  const rows = candidates.map((candidate) => ({
    candidate,
    candidateId: stableCandidateId(candidate),
    deltaFit: absDeltaMidpointFit(candidate),
    creditPerWidth: creditWidth(candidate),
    gamma: gammaPenalty(candidate),
  }));

  rows.sort((a, b) => {
    if (a.deltaFit !== b.deltaFit) return a.deltaFit - b.deltaFit;
    if (a.creditPerWidth !== b.creditPerWidth) return b.creditPerWidth - a.creditPerWidth;
    if (a.gamma !== b.gamma) return a.gamma - b.gamma;
    return a.candidateId.localeCompare(b.candidateId);
  });

  return rows.map((row, idx) => ({
    candidateId: row.candidateId,
    strategy: row.candidate.strategy,
    rank: idx + 1,
    score: {
      deltaMidpointFit: Number(row.deltaFit.toFixed(6)),
      creditWidth: Number(row.creditPerWidth.toFixed(6)),
      gammaPenalty: Number(row.gamma.toFixed(6)),
    },
    candidate: row.candidate,
  }));
}

