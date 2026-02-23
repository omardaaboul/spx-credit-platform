// lib/strategy.ts
import type { Position } from "./journal";

export type Strategy =
  | "CSP"
  | "CC"
  | "PCS"
  | "CCS"
  | "LEAPS"
  | "SHORT_PUT"
  | "SHORT_CALL"
  | "LONG_PUT"
  | "LONG_CALL"
  | "UNKNOWN";

/**
 * Heuristics:
 * - SHORT puts/calls map to CSP/CC when uncovered info is unknown.
 * - LEAPS: LONG options with expiry >= ~180 days from open (best-effort).
 * - Spreads (PCS/CCS): requires leg pairing; we’ll treat those as UNKNOWN for now
 *   until we implement multi-leg grouping (next step).
 */
export function classifyPosition(p: Position): Strategy {
  if (p.kind === "SPREAD" && p.spreadType) {
    const spread = String(p.spreadType).toUpperCase();
    if (spread === "PCS" || spread === "CCS") {
      return spread;
    }
    return "UNKNOWN";
  }

  // If we later detect multi-leg spreads, we’ll upgrade this.
  const isPut = p.right === "P";
  const isCall = p.right === "C";

  if (p.side === "SHORT") {
    if (isPut) return "CSP"; // assume cash-secured put
    if (isCall) return "CC"; // assume covered call
    return "UNKNOWN";
  }

  // LONG (LEAPS or directional)
  // If we have openedOn we can approximate DTE
  if (p.openedOn) {
    const open = new Date(p.openedOn + "T00:00:00Z").getTime();
    const exp = new Date(p.expiry + "T00:00:00Z").getTime();
    const dte = Math.round((exp - open) / (1000 * 60 * 60 * 24));
    if (dte >= 180) {
      // treat as LEAPS (call or put)
      return "LEAPS";
    }
  }

  if (isCall) return "LONG_CALL";
  if (isPut) return "LONG_PUT";
  return "UNKNOWN";
}

export function displayStrategy(s: Strategy) {
  switch (s) {
    case "CSP":
      return "Cash-Secured Put (CSP)";
    case "CC":
      return "Covered Call (CC)";
    case "PCS":
      return "Put Credit Spread (PCS)";
    case "CCS":
      return "Call Credit Spread (CCS)";
    case "LEAPS":
      return "LEAPS";
    case "SHORT_PUT":
      return "Short Put";
    case "SHORT_CALL":
      return "Short Call";
    case "LONG_PUT":
      return "Long Put";
    case "LONG_CALL":
      return "Long Call";
    default:
      return "Unknown";
  }
}
