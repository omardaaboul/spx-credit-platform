const TARGET_BUCKETS = [2, 7, 14, 30, 45];

export function parseDteFromStrategy(strategy: string): number | null {
  const match = String(strategy ?? "").match(/(\d+)-DTE/i);
  if (!match) return null;
  const dte = Number(match[1]);
  return Number.isFinite(dte) && dte > 0 ? dte : null;
}

export function resolveNearestDteBuckets(availableDtes: number[], targets: number[] = TARGET_BUCKETS): Array<{
  targetDte: number;
  selectedDte: number | null;
  distance: number | null;
}> {
  const clean = Array.from(
    new Set(
      availableDtes
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.round(value)),
    ),
  ).sort((a, b) => a - b);

  return targets.map((targetDte) => {
    if (clean.length === 0) {
      return {
        targetDte,
        selectedDte: null,
        distance: null,
      };
    }
    let best = clean[0];
    for (const dte of clean) {
      const bestDist = Math.abs(best - targetDte);
      const nextDist = Math.abs(dte - targetDte);
      if (nextDist < bestDist) {
        best = dte;
        continue;
      }
      if (nextDist === bestDist && dte < best) {
        best = dte;
      }
    }
    return {
      targetDte,
      selectedDte: best,
      distance: Math.abs(best - targetDte),
    };
  });
}

