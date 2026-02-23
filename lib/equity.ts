import { Cashflow } from "@/lib/db";

export type EquityRealizedEvent = {
  date: string;
  month: string;
  amount: number;
  ticker?: string;
  qty: number;
  price: number;
  cost: number;
};

type EquityLot = { qty: number; price: number };

function safeQty(qty?: number) {
  const n = Number(qty ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function inferPrice(c: Cashflow) {
  if (Number.isFinite(c.price ?? NaN) && (c.price as number) > 0) return Number(c.price);
  const qty = safeQty(c.quantity);
  const amt = Number(c.amount ?? 0);
  if (!qty || !Number.isFinite(amt)) return undefined;
  return Math.abs(amt) / qty;
}

export function computeEquityRealized(cashflows: Cashflow[]) {
  const lots = new Map<string, EquityLot[]>();
  const events: EquityRealizedEvent[] = [];

  const equityRows = cashflows
    .filter((c) => c.category === "EQUITY")
    .filter((c) => c.side === "BUY" || c.side === "SELL")
    .filter((c) => c.date);

  const sorted = [...equityRows].sort((a, b) => {
    const da = String(a.date || "");
    const db = String(b.date || "");
    if (da !== db) return da.localeCompare(db);
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

  for (const c of sorted) {
    const qty = safeQty(c.quantity);
    const price = inferPrice(c);
    if (!qty || !price) continue;

    const ticker = (c.ticker ?? "UNKNOWN").toUpperCase();
    const stack = lots.get(ticker) ?? [];

    if (c.side === "BUY") {
      stack.push({ qty, price });
      lots.set(ticker, stack);
      continue;
    }

    let remaining = qty;
    let realized = 0;
    let cost = 0;
    while (remaining > 0) {
      const lot = stack[0];
      if (!lot) {
        // Missing cost basis: assume cost = sell price for zero gain.
        cost += remaining * price;
        remaining = 0;
        break;
      }
      const take = Math.min(remaining, lot.qty);
      cost += take * lot.price;
      realized += (price - lot.price) * take;
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= 0) stack.shift();
    }

    lots.set(ticker, stack);
    const amt = Number(realized.toFixed(2));
    events.push({
      date: String(c.date),
      month: String(c.month || "").slice(0, 7),
      amount: amt,
      ticker,
      qty,
      price,
      cost: Number(cost.toFixed(2)),
    });
  }

  const byMonth = new Map<string, number>();
  for (const e of events) {
    if (!e.month) continue;
    byMonth.set(e.month, Number(((byMonth.get(e.month) ?? 0) + e.amount).toFixed(2)));
  }

  const total = events.reduce((a, e) => a + e.amount, 0);
  return { byMonth, total: Number(total.toFixed(2)), events };
}
