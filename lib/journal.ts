// lib/journal.ts

export type Tx = {
  id: string;
  ticker?: string;
  type?: string; // STO/BTC/BTO/STC or other codes (OASGN/OEXP/OCA)
  openDate?: string; // ISO preferred
  closeDate?: string; // ISO preferred
  activityDate?: string; // optional ISO
  quantity?: number; // contracts or shares (from CSV Quantity)
  totalPL?: number; // signed cashflow (credit +, debit -) for THIS row total
  notes?: string; // e.g. "SOXS 1/16/2026 Put $4.00"
  createdAt?: string; // ISO timestamp
};

export type RealizedEvent = {
  date: string; // ISO YYYY-MM-DD
  amount: number; // realized P/L for this close slice
  qty: number; // contracts closed in this event
};

export type PositionLeg = {
  key?: string;
  side: "SHORT" | "LONG";
  right: "P" | "C";
  strike: number;
  qty?: number;
  openedOn?: string;
};

export type Position = {
  key: string;

  underlying: string;
  expiry: string; // YYYY-MM-DD
  right: "P" | "C";
  strike: number;
  side: "SHORT" | "LONG";

  openedOn?: string;
  closedOn?: string;

  qtyOpened: number;
  qtyClosed: number;
  qtyRemaining: number;

  premiumCollected: number; // credits (total for this position slice)
  costToClose: number; // debits (total for this position slice)

  realizedPL?: number; // only present when CLOSED
  status: "OPEN" | "CLOSED" | "INCOMPLETE";

  // Optional spread metadata used by some UI pages.
  kind?: "SINGLE" | "SPREAD";
  spreadType?: string;
  legs?: PositionLeg[];
  width?: number;
  netCredit?: number;
  maxProfit?: number;
  maxLoss?: number;

  // Close events so the dashboard can bucket by the actual close date.
  realizedEvents?: RealizedEvent[];
};

/* ---------------- helpers ---------------- */

function toISODate(s?: string): string | undefined {
  if (!s) return undefined;
  const str = String(s).trim();
  if (!str) return undefined;

  // Accept ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  // M/D/YY or M/D/YYYY
  const parts = str.split("/");
  if (parts.length !== 3) return undefined;
  const mm = Number(parts[0]);
  const dd = Number(parts[1]);
  let yy = Number(parts[2]);
  if (!mm || !dd || !yy) return undefined;
  if (yy < 100) yy += 2000;

  const d = new Date(Date.UTC(yy, mm - 1, dd));
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10);
}

export function monthKey(isoDate?: string) {
  return isoDate ? String(isoDate).slice(0, 7) : "";
}

function parseAction(type?: string, notes?: string) {
  const s = `${type ?? ""} ${notes ?? ""}`.toUpperCase();
  if (s.includes("STO")) return "STO";
  if (s.includes("BTC")) return "BTC";
  if (s.includes("BTO")) return "BTO";
  if (s.includes("STC")) return "STC";
  return "";
}

function isAssignmentCode(type?: string) {
  const c = String(type ?? "").trim().toUpperCase();
  return ["OASGN", "OEXP", "OCA"].includes(c);
}

/**
 * Robustly parse option contract from Robinhood-like descriptions.
 * Examples:
 *  - "SOXS 1/16/2026 Put $4.00"
 *  - "SOXS 1/16/2026 Put 4.00"   (no $)
 *  - "SPXW 2025-10-30 C 6965"    (already normalized)
 */
export function parseContract(desc?: string) {
  if (!desc) return null;
  const s = String(desc).trim();
  if (!s) return null;

  // Underlying
  const u = s.match(/^([A-Z.\-]{1,12})\b/);
  if (!u) return null;
  const underlying = u[1].toUpperCase();

  // Expiry: accept M/D/YYYY or ISO
  let expiry: string | undefined;
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    expiry = iso[1];
  } else {
    const mdY = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (mdY) {
      const mm = Number(mdY[1]);
      const dd = Number(mdY[2]);
      const yy = Number(mdY[3]);
      const d = new Date(Date.UTC(yy, mm - 1, dd));
      expiry = d.toISOString().slice(0, 10);
    }
  }
  if (!expiry) return null;

  // Right
  let right: "P" | "C" | null = null;
  if (/\bPUT\b/i.test(s)) right = "P";
  if (/\bCALL\b/i.test(s)) right = "C";
  if (!right) {
    const rc = s.match(/\b([PC])\b/);
    if (rc) right = rc[1].toUpperCase() as any;
  }
  if (!right) return null;

  // Strike: allow with or without '$'
  let strike: number | undefined;
  const dollar = s.match(/\$\s*([\d,]+(?:\.\d+)?)\b/);
  if (dollar) {
    strike = Number(dollar[1].replace(/,/g, ""));
  } else {
    const after = s.match(/\b(?:PUT|CALL)\b[^\d]*([\d,]+(?:\.\d+)?)\b/i);
    if (after) strike = Number(after[1].replace(/,/g, ""));
    else {
      // fallback for "SPXW 2025-10-30 C 6965"
      const tail = s.match(/\b[PC]\b\s*([\d,]+(?:\.\d+)?)\b/);
      if (tail) strike = Number(tail[1].replace(/,/g, ""));
    }
  }
  if (!Number.isFinite(strike)) return null;

  return { underlying, expiry, right, strike: Number(strike) };
}

function eventDateForAction(t: Tx, act: string) {
  const a = toISODate(t.activityDate);
  if (a) return a;

  if (act === "BTC" || act === "STC") return toISODate(t.closeDate ?? t.openDate);
  if (act === "STO" || act === "BTO") return toISODate(t.openDate ?? t.closeDate);
  return toISODate(t.openDate ?? t.closeDate);
}

function asQty(n: unknown) {
  const q = Number(n ?? 0);
  if (!Number.isFinite(q) || q === 0) return 0;
  return Math.abs(q);
}

function round2(n: number) {
  return Number(n.toFixed(2));
}

/* ---------------- main engine ---------------- */

/**
 * ACCURACY FIX (quantity-aware, partial close aware):
 * - Create a new Position lot on every OPEN (STO/BTO) with qtyOpened.
 * - CLOSE (BTC/STC) consumes qty from most recent open lots (LIFO) until the close qty is satisfied.
 * - If a close only partially closes an open lot, we SPLIT it into:
 *     - a CLOSED slice (new Position row)
 *     - the remaining OPEN slice stays open
 * This prevents under/over counting and fixes cases like SOXS where one BTC closes multiple STO rows.
 */
export function buildPositionsFromTransactions(tx: Tx[]): Position[] {
  // Sort by event date then createdAt for deterministic matching
  const sorted = [...tx].sort((a, b) => {
    const aa = parseAction(a.type, a.notes);
    const bb = parseAction(b.type, b.notes);
    const da = eventDateForAction(a, aa) ?? "";
    const dbb = eventDateForAction(b, bb) ?? "";
    if (da !== dbb) return da.localeCompare(dbb);
    return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
  });

  // Stack of OPEN lots per contractId
  const openStacks = new Map<string, Position[]>();
  const out: Position[] = [];

  function contractId(
    c: { underlying: string; expiry: string; right: "P" | "C"; strike: number },
    side: "SHORT" | "LONG"
  ) {
    return `${c.underlying}|${c.expiry}|${c.right}|${c.strike}|${side}`;
  }

  function makeKey(prefix: string, c: any, side: string, seed: string) {
    return `${prefix}|${c.underlying}|${c.expiry}|${c.right}|${c.strike}|${side}|${seed}`;
  }

  function makeOpenLot(
    c: { underlying: string; expiry: string; right: "P" | "C"; strike: number },
    side: "SHORT" | "LONG",
    openedOn: string | undefined,
    qtyOpened: number,
    premiumCollected: number,
    costToClose: number,
    seed: string
  ): Position {
    return {
      key: makeKey("POS", c, side, seed),
      underlying: c.underlying,
      expiry: c.expiry,
      right: c.right,
      strike: c.strike,
      side,
      openedOn,
      closedOn: undefined,
      qtyOpened,
      qtyClosed: 0,
      qtyRemaining: qtyOpened,
      premiumCollected: round2(premiumCollected),
      costToClose: round2(costToClose),
      status: "OPEN",
      realizedEvents: [],
    };
  }

  function pushOpen(id: string, p: Position) {
    const s = openStacks.get(id) ?? [];
    s.push(p);
    openStacks.set(id, s);
    out.push(p);
  }

  function peekOpen(id: string): Position | undefined {
    const s = openStacks.get(id);
    if (!s || !s.length) return undefined;
    return s[s.length - 1];
  }

  function popOpen(id: string): Position | undefined {
    const s = openStacks.get(id);
    if (!s || !s.length) return undefined;
    const p = s.pop();
    if (!s.length) openStacks.delete(id);
    else openStacks.set(id, s);
    return p;
  }

  function replaceTop(id: string, p: Position) {
    const s = openStacks.get(id);
    if (!s || !s.length) return;
    s[s.length - 1] = p;
    openStacks.set(id, s);
  }

  for (const t of sorted) {
    const c = parseContract(t.notes || "");
    if (!c) continue;

    const act = parseAction(t.type, t.notes);
    const assignment = isAssignmentCode(t.type);
    const effectiveAct = act || (assignment ? "ASSIGN" : "");
    if (!effectiveAct) continue;

    // Assignments/expirations only apply to SHORT options lifecycle.
    const side: "SHORT" | "LONG" =
      effectiveAct === "STO" || effectiveAct === "BTC" || effectiveAct === "ASSIGN" ? "SHORT" : "LONG";

    const id = contractId(c, side);
    const date =
      eventDateForAction(t, act || (assignment ? "BTC" : "")) ||
      toISODate(t.openDate) ||
      toISODate(t.closeDate);

    const rowQtyRaw = asQty((t as any).quantity);

    // Default qty:
    // - If CSV quantity is present, use it
    // - If missing, assume 1 contract for options
    const qty = rowQtyRaw > 0 ? rowQtyRaw : 1;

    const rowCash = Number(t.totalPL ?? 0);

    // ---------- OPEN ----------
    if (effectiveAct === "STO" || effectiveAct === "BTO") {
      // Row cash is total for the row; keep totals on the lot.
      let prem = 0;
      let cost = 0;
      if (side === "SHORT") prem = Math.max(0, rowCash);
      else cost = Math.abs(rowCash);

      const p = makeOpenLot(c, side, date, qty, prem, cost, `${t.id}`);
      pushOpen(id, p);
      continue;
    }

    // ---------- CLOSE / ASSIGN ----------
    if (effectiveAct === "BTC" || effectiveAct === "STC" || effectiveAct === "ASSIGN") {
      // ASSIGN rows often have $0 amount; treat as a close with zero cashflow.
      const closeQty = qty;
      let remaining = closeQty;

      // Allocate the close cash across consumed qty.
      const absRowCash = Math.abs(rowCash);

      while (remaining > 0) {
        const open = peekOpen(id);
        if (!open) {
          // No open found: create an incomplete slice for visibility.
          const p: Position = {
            key: makeKey("INC", c, side, `missing-open-${t.id}-${remaining}`),
            underlying: c.underlying,
            expiry: c.expiry,
            right: c.right,
            strike: c.strike,
            side,
            openedOn: toISODate(t.openDate),
            closedOn: date,
            qtyOpened: 0,
            qtyClosed: 0,
            qtyRemaining: 0,
            premiumCollected: side === "LONG" && effectiveAct === "STC" ? round2(Math.max(0, rowCash)) : 0,
            costToClose: side === "SHORT" && effectiveAct === "BTC" ? round2(absRowCash) : 0,
            status: "INCOMPLETE",
            realizedEvents: [],
          };
          out.push(p);
          break;
        }

        const consume = Math.min(remaining, open.qtyRemaining);
        const frac = closeQty > 0 ? consume / closeQty : 1;

        // Portion of OPEN premium/cost that belongs to this consumed slice
        const openPremPortion = open.qtyOpened > 0 ? (open.premiumCollected * consume) / open.qtyRemaining : 0;
        const openCostPortion = open.qtyOpened > 0 ? (open.costToClose * consume) / open.qtyRemaining : 0;

        // Portion of CLOSE cash applied to this slice
        const closeCashPortion = effectiveAct === "ASSIGN" ? 0 : absRowCash * frac;

        // If fully consuming this open lot, we close it in-place.
        if (consume === open.qtyRemaining) {
          if (side === "SHORT") {
            if (effectiveAct === "BTC") open.costToClose = round2(open.costToClose + closeCashPortion);
          } else {
            if (effectiveAct === "STC") open.premiumCollected = round2(open.premiumCollected + closeCashPortion);
          }

          open.qtyClosed = open.qtyOpened;
          open.qtyRemaining = 0;
          open.closedOn = date || open.closedOn;
          open.status = "CLOSED";
          open.realizedPL = round2(open.premiumCollected - open.costToClose);

          if (open.closedOn) {
            open.realizedEvents = (open.realizedEvents ?? []).concat([
              { date: open.closedOn, amount: open.realizedPL ?? 0, qty: open.qtyClosed },
            ]);
          }

          popOpen(id);
        } else {
          // Partial close: split into a CLOSED slice + keep remaining OPEN on the stack.
          const seed = `slice-${t.id}-${open.key}-${open.qtyRemaining}-${consume}`;

          // Closed slice starts with proportional open premium/cost.
          const closedSlice: Position = {
            key: makeKey("SLICE", c, side, seed),
            underlying: open.underlying,
            expiry: open.expiry,
            right: open.right,
            strike: open.strike,
            side: open.side,
            openedOn: open.openedOn,
            closedOn: date,
            qtyOpened: consume,
            qtyClosed: consume,
            qtyRemaining: 0,
            premiumCollected: round2(openPremPortion),
            costToClose: round2(openCostPortion),
            status: "CLOSED",
            realizedEvents: [],
          };

          // Apply the close cashflow portion to the closed slice
          if (side === "SHORT") {
            if (effectiveAct === "BTC") closedSlice.costToClose = round2(closedSlice.costToClose + closeCashPortion);
          } else {
            if (effectiveAct === "STC") closedSlice.premiumCollected = round2(closedSlice.premiumCollected + closeCashPortion);
          }

          closedSlice.realizedPL = round2(closedSlice.premiumCollected - closedSlice.costToClose);
          if (closedSlice.closedOn) {
            closedSlice.realizedEvents = [{ date: closedSlice.closedOn, amount: closedSlice.realizedPL, qty: consume }];
          }

          out.push(closedSlice);

          // Reduce the OPEN lot totals proportionally for remaining qty
          const remainingQtyAfter = open.qtyRemaining - consume;

          // Remove proportional amounts from the open lot
          open.premiumCollected = round2(open.premiumCollected - openPremPortion);
          open.costToClose = round2(open.costToClose - openCostPortion);
          open.qtyRemaining = remainingQtyAfter;
          open.qtyClosed = open.qtyOpened - open.qtyRemaining;
          open.status = "OPEN";
          open.realizedPL = undefined;

          // keep open lot on stack (already on top), just ensure updated
          replaceTop(id, open);
        }

        remaining -= consume;
      }

      continue;
    }
  }

  // newest first (closedOn preferred)
  return out
    .slice()
    .sort((a, b) => {
      const da = a.closedOn || a.openedOn || "";
      const dbb = b.closedOn || b.openedOn || "";
      return dbb.localeCompare(da);
    });
}
