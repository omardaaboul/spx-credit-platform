// lib/campaigns.ts
import type { Position } from "./journal";
import { classifyPosition } from "./strategy";

export type CampaignLeg = {
  key: string;
  openedOn?: string;
  closedOn?: string;
  realizedPL?: number;
  premiumCollected: number;
  kind?: "SINGLE" | "SPREAD";
  spreadType?: string;
  strike: number;
  expiry: string;
  right: "P" | "C";
  side: "SHORT" | "LONG";
};

export type Campaign = {
  id: string;
  underlying: string;
  strategy: string;
  start: string; // openedOn
  end?: string; // closedOn
  status: "OPEN" | "CLOSED";
  rolls: number;
  legs: CampaignLeg[];

  realizedTotal: number;     // closed-only legs sum
  premiumTotal: number;      // opening credits sum (approx)
  estRiskMax: number;        // estimated max capital at risk during campaign
  rocPct: number;            // realizedTotal / estRiskMax
  annRocPct: number;         // annualized using campaign duration
  daysInTrade: number;
};

function isoToMs(iso?: string) {
  if (!iso) return null;
  const t = Date.parse(iso + "T00:00:00Z");
  return Number.isFinite(t) ? t : null;
}

function daysBetween(aIso?: string, bIso?: string) {
  const a = isoToMs(aIso);
  const b = isoToMs(bIso);
  if (a == null || b == null) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function estRisk(p: Position) {
  // Conservative proxy; spreads become accurate thanks to width/maxLoss if present.
  if (p.kind === "SPREAD") {
    if (typeof p.maxLoss === "number") return Math.max(0, p.maxLoss);
    if (typeof p.width === "number" && typeof p.netCredit === "number") {
      return Math.max(0, p.width * 100 - p.netCredit);
    }
    // fallback
    return Math.max(0, (p.strike ?? 0) * 100);
  }

  // SINGLE
  if (p.side === "SHORT") return Math.max(0, (p.strike ?? 0) * 100);
  return Math.max(0, p.costToClose ?? 0);
}

/**
 * Roll/campaign grouping heuristic:
 * - Group by underlying + strategy class (CSP/CC/PCS/CCS/LEAPS/etc.)
 * - A new leg belongs to the same campaign if it opens within `gapDays` of the previous leg’s close
 *   (handles same-day rolls and next-day rolls).
 * - Supports different expirations (roll out) naturally.
 */
export function buildCampaigns(positions: Position[], gapDays = 1): Campaign[] {
  const sorted = [...positions].sort((a, b) => {
    const da = a.openedOn ?? "";
    const db = b.openedOn ?? "";
    if (da !== db) return da.localeCompare(db);
    return (a.key ?? "").localeCompare(b.key ?? "");
  });

  // Group streams by underlying + strategy
  type StreamKey = string;
  const streams = new Map<StreamKey, Position[]>();

  for (const p of sorted) {
    if (!p.openedOn) continue; // if no open date, we can’t chain reliably
    const strat = classifyPosition(p);
    const sk = `${p.underlying}|${strat}`;
    const arr = streams.get(sk) ?? [];
    arr.push(p);
    streams.set(sk, arr);
  }

  const campaigns: Campaign[] = [];

  for (const [sk, arr] of streams.entries()) {
    // build campaigns for this stream
    let current: Position[] = [];

    const pushCampaign = (legs: Position[]) => {
      if (!legs.length) return;

      const underlying = legs[0].underlying;
      const strat = classifyPosition(legs[0]);
      const start = legs[0].openedOn!;
      const last = legs[legs.length - 1];
      const end = last.status === "CLOSED" ? last.closedOn : undefined;
      const status: "OPEN" | "CLOSED" = end ? "CLOSED" : "OPEN";

      const realizedTotal = Number(
        legs.reduce((a, p) => a + (p.status === "CLOSED" ? (p.realizedPL ?? 0) : 0), 0).toFixed(2)
      );
      const premiumTotal = Number(
        legs.reduce((a, p) => a + (p.premiumCollected ?? 0), 0).toFixed(2)
      );

      const estRiskMax = Number(
        Math.max(...legs.map((p) => estRisk(p))).toFixed(2)
      );

      const endForDuration = end ?? last.openedOn ?? start;
      const days = Math.max(1, daysBetween(start, endForDuration) ?? 1);

      const roc = estRiskMax > 0 ? realizedTotal / estRiskMax : 0;
      const ann = roc * (365 / days);

      const legsOut: CampaignLeg[] = legs.map((p) => ({
        key: p.key,
        openedOn: p.openedOn,
        closedOn: p.closedOn,
        realizedPL: p.realizedPL,
        premiumCollected: p.premiumCollected ?? 0,
        kind: p.kind,
        spreadType: p.spreadType,
        strike: p.strike,
        expiry: p.expiry,
        right: p.right,
        side: p.side,
      }));

      campaigns.push({
        id: `CAMP|${sk}|${start}|${legs.length}`,
        underlying,
        strategy: String(strat),
        start,
        end,
        status,
        rolls: Math.max(0, legs.length - 1),
        legs: legsOut,
        realizedTotal,
        premiumTotal,
        estRiskMax,
        rocPct: Number((roc * 100).toFixed(2)),
        annRocPct: Number((ann * 100).toFixed(2)),
        daysInTrade: days,
      });
    };

    // Sort by open date then chain
    const legs = [...arr].sort((a, b) => (a.openedOn ?? "").localeCompare(b.openedOn ?? ""));
    for (const p of legs) {
      if (!current.length) {
        current = [p];
        continue;
      }

      const prev = current[current.length - 1];

      // if prev isn't closed, we stop chaining (open campaign)
      if (prev.status !== "CLOSED" || !prev.closedOn) {
        pushCampaign(current);
        current = [p];
        continue;
      }

      const gap = daysBetween(prev.closedOn, p.openedOn) ?? 9999;
      const sameStream = true; // already in same underlying+strategy stream

      if (sameStream && gap >= 0 && gap <= gapDays) {
        current.push(p);
      } else {
        pushCampaign(current);
        current = [p];
      }
    }

    pushCampaign(current);
  }

  // Sort newest first by end/start
  campaigns.sort((a, b) => (b.end || b.start).localeCompare(a.end || a.start));
  return campaigns;
}
