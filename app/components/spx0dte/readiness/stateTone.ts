import type { ReadinessState } from "@/lib/readiness";

export function readinessBadgeClass(state: ReadinessState): string {
  if (state === "pass") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (state === "fail") return "border-rose-500/40 bg-rose-500/10 text-rose-300";
  if (state === "blocked") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  if (state === "degraded") return "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-300";
  return "border-[var(--spx-border)] bg-[var(--spx-panel)] text-[var(--spx-muted)]";
}

export function readinessLabel(state: ReadinessState): string {
  if (state === "pass") return "PASS";
  if (state === "fail") return "FAIL";
  if (state === "blocked") return "BLOCKED";
  if (state === "degraded") return "DEGRADED";
  return "N/A";
}

export function readinessIcon(state: ReadinessState): string {
  if (state === "pass") return "✔";
  if (state === "fail") return "✖";
  if (state === "blocked") return "!";
  if (state === "degraded") return "⚠";
  return "—";
}
