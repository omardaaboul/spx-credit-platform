import type { CandidateCard } from "@/lib/spx0dte";
import type { DecisionMode, RankedCandidate } from "@/lib/contracts/decision";
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

type RankOptions = {
  applyGammaPenalty?: boolean;
};

export function rankCandidatesDeterministic(
  candidates: CandidateCard[],
  mode: DecisionMode = "STRICT",
  opts: RankOptions = {},
): RankedCandidate[] {
  const rows = candidates.map((candidate) => ({
    candidate,
    candidateId: stableCandidateId(candidate),
    deltaFit: absDeltaMidpointFit(candidate),
    creditPerWidth: creditWidth(candidate),
    gamma: gammaPenalty(candidate),
    pop: Number.isFinite(candidate.popPct ?? Number.NaN) ? candidate.popPct : null,
    ror: Number.isFinite(candidate.ror) ? candidate.ror : null,
    evRor: Number.isFinite(candidate.evRor) ? candidate.evRor : null,
  }));

  const applyGamma = opts.applyGammaPenalty !== false;

  rows.sort((a, b) => {
    if (mode === "PROBABILISTIC") {
      const popA = a.pop ?? -1;
      const popB = b.pop ?? -1;
      if (popA !== popB) return popB - popA;
      const rorA = a.ror ?? a.evRor ?? -1;
      const rorB = b.ror ?? b.evRor ?? -1;
      if (rorA !== rorB) return rorB - rorA;
      if (applyGamma && a.gamma !== b.gamma) return a.gamma - b.gamma;
      return a.candidateId.localeCompare(b.candidateId);
    }

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
      pop: row.pop ?? undefined,
      ror: row.ror ?? undefined,
      evRor: row.evRor ?? undefined,
    },
    candidate: row.candidate,
  }));
}
