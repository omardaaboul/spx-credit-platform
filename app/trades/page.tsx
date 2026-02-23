"use client";

import { useEffect, useMemo, useState } from "react";
import { db, Trade, Cashflow } from "@/lib/db";
import { buildPositionsFromTransactions, monthKey, Position } from "@/lib/journal";
import { computeEquityRealized } from "@/lib/equity";

/* ---------------- helpers ---------------- */

type EquityRowWithRealized = Cashflow & { realizedPL?: number };

function money(n?: number) {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtDate(iso?: string) {
  return iso ? iso : "—";
}

function daysBetween(aIso?: string, bIso?: string) {
  if (!aIso || !bIso) return undefined;
  const a = new Date(aIso + "T00:00:00Z").getTime();
  const b = new Date(bIso + "T00:00:00Z").getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function dte(expiryIso?: string) {
  if (!expiryIso) return undefined;
  const now = new Date();
  const todayIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  return daysBetween(todayIso, expiryIso);
}

function labelPosition(p: Position) {
  const ymd = p.expiry;
  const right = p.right;

  if (p.kind === "SPREAD") {
    const legs = (p.legs ?? []).slice().sort((a, b) => b.strike - a.strike);
    const hi = legs[0]?.strike ?? p.strike;
    const lo = legs[1]?.strike;
    const strikes = typeof lo === "number" ? `${hi}/${lo}` : `${hi}`;
    const tag = p.spreadType ?? (right === "P" ? "PCS" : "CCS");
    return `${p.underlying} ${ymd} ${tag} ${strikes}`;
  }

  return `${p.underlying} ${ymd} ${right} ${p.strike}`;
}

function statusPill(s: Position["status"]) {
  if (s === "CLOSED") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (s === "OPEN") return "bg-blue-50 text-blue-700 border-blue-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

function estimateCapitalAtRisk(p: Position) {
  // Conservative, accuracy-first estimates based only on contract terms.
  // SINGLE short: CSP uses strike*100; short call is undefined without shares/margin rules.
  // SPREAD: uses maxLoss when present.
  if (p.kind === "SPREAD") {
    return typeof p.maxLoss === "number" ? p.maxLoss : undefined;
  }
  if (p.side === "SHORT" && p.right === "P") {
    return p.strike * 100;
  }
  return undefined;
}

function rocPercent(p: Position) {
  const risk = estimateCapitalAtRisk(p);
  if (!risk || risk <= 0) return undefined;

  const pl = p.status === "CLOSED" ? (p.realizedPL ?? 0) : (p.premiumCollected ?? 0);
  return (pl / risk) * 100;
}

function annualizedRocPercent(p: Position) {
  const roc = rocPercent(p);
  if (typeof roc !== "number") return undefined;
  const hold = daysBetween(p.openedOn, p.closedOn ?? new Date().toISOString().slice(0, 10));
  if (!hold || hold <= 0) return undefined;
  return (roc * 365) / hold;
}

function monthBucketForPosition(p: Position) {
  // For accuracy: realized P/L belongs to the close month; open positions belong to open month.
  if (p.status === "CLOSED") return monthKey(p.closedOn);
  return monthKey(p.openedOn);
}

function yearKey(iso?: string) {
  return iso ? iso.slice(0, 4) : "";
}

function isOptionFillRow(t: any) {
  const type = String(t?.type ?? "").toUpperCase();
  const notes = String(t?.notes ?? "").toUpperCase();
  const isAction = ["STO", "BTC", "BTO", "STC"].some((a) => type.includes(a) || notes.includes(a));
  // Robinhood option descriptions contain Put/Call and a strike-like number
  const hasPutCall = /\b(PUT|CALL)\b/.test(notes);
  const hasStrike = /\b(PUT|CALL)\b[^\n\r]*?\b\$?\d{1,6}(?:,\d{3})*(?:\.\d+)?\b/.test(notes);
  return isAction && hasPutCall && hasStrike;
}

/* ---------------- page ---------------- */

export default function TradesPage() {
  const [tx, setTx] = useState<Trade[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [instrument, setInstrument] = useState<"OPTIONS" | "STOCKS">("OPTIONS");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"ALL" | "OPEN" | "CLOSED">("ALL");
  const [kind, setKind] = useState<"ALL" | "SINGLE" | "SPREAD">("ALL");
  const [equitySide, setEquitySide] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [selectedMonth, setSelectedMonth] = useState<string>("");
  const [selected, setSelected] = useState<Position | null>(null);

  useEffect(() => {
    (async () => {
      const all = await db.trades.toArray();
      setTx(all);
      const allCashflows = await db.cashflows.toArray();
      setCashflows(allCashflows);
    })();
  }, []);

  const positions = useMemo(() => buildPositionsFromTransactions(tx as any), [tx]);

  const selectedYear = useMemo(() => {
    if (selectedMonth) return selectedMonth.slice(0, 4);
    const now = new Date();
    return String(now.getFullYear());
  }, [selectedMonth]);

  const months = useMemo(() => {
    const s = new Set<string>();
    for (const p of positions) {
      const k = monthBucketForPosition(p);
      if (k) s.add(k);
    }
    for (const c of cashflows) {
      if (c.month) s.add(c.month);
    }
    return Array.from(s.values()).sort((a, b) => b.localeCompare(a));
  }, [positions, cashflows]);

  useEffect(() => {
    if (!selectedMonth && months.length) setSelectedMonth(months[0]);
  }, [months, selectedMonth]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();

    return positions.filter((p) => {
      if (tab !== "ALL" && p.status !== tab) return false;
      if (kind !== "ALL" && (p.kind ?? "SINGLE") !== kind) return false;

      if (selectedMonth) {
        const k = monthBucketForPosition(p);
        if (k !== selectedMonth) return false;
      }

      if (!query) return true;
      const text = `${labelPosition(p)} ${p.kind ?? ""} ${p.spreadType ?? ""} ${p.status}`.toLowerCase();
      return text.includes(query);
    });
  }, [positions, q, tab, kind, selectedMonth]);

  const openPositions = useMemo(() => filtered.filter((p) => p.status === "OPEN"), [filtered]);
  const closedPositions = useMemo(() => filtered.filter((p) => p.status === "CLOSED"), [filtered]);
  const contractsCount = useMemo(() => {
    return filtered.reduce((a, p) => a + (p.status === "CLOSED" ? p.qtyClosed : p.qtyOpened), 0);
  }, [filtered]);
  const capitalUsed = useMemo(() => {
    return filtered.reduce((a, p) => {
      const risk = estimateCapitalAtRisk(p);
      return a + (typeof risk === "number" ? risk : 0);
    }, 0);
  }, [filtered]);

  const realizedSum = useMemo(
    () => closedPositions.reduce((a, p) => a + (p.realizedPL ?? 0), 0),
    [closedPositions]
  );

  // Journal realized P/L for the selected YEAR (based on close date)
  const realizedYear = useMemo(() => {
    return positions
      .filter((p) => p.status === "CLOSED" && yearKey(p.closedOn) === selectedYear)
      .reduce((a, p) => a + (p.realizedPL ?? 0), 0);
  }, [positions, selectedYear]);

  // Raw option cashflow for the selected YEAR (sum of imported option fill Amounts)
  // This often matches what brokers show as "net options activity" better than position matching.
  const optionCashflowYear = useMemo(() => {
    return tx
      .filter((t: any) => {
        const d = String(t.activityDate ?? t.openDate ?? t.closeDate ?? "");
        return d && d.startsWith(selectedYear) && isOptionFillRow(t);
      })
      .reduce((a: number, t: any) => a + Number(t.totalPL ?? 0), 0);
  }, [tx, selectedYear]);

  // How many imported trades look like option fills but did NOT turn into positions (parsing/matching gaps)
  const optionRowCount = useMemo(() => {
    return tx.filter((t: any) => {
      const d = String(t.activityDate ?? t.openDate ?? t.closeDate ?? "");
      return d && d.startsWith(selectedYear) && isOptionFillRow(t);
    }).length;
  }, [tx, selectedYear]);

  const equityRows = useMemo(() => {
    return cashflows.filter((c) => c.category === "EQUITY");
  }, [cashflows]);

  const equityFiltered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return equityRows.filter((c) => {
      if (selectedMonth && c.month !== selectedMonth) return false;
      if (equitySide !== "ALL" && c.side !== equitySide) return false;
      if (!query) return true;
      const text = `${c.ticker ?? ""} ${c.notes ?? ""}`.toLowerCase();
      return text.includes(query);
    });
  }, [equityRows, q, selectedMonth, equitySide]);

  const equityRealized = useMemo(() => computeEquityRealized(cashflows), [cashflows]);

  const equityRowsWithRealized = useMemo<EquityRowWithRealized[]>(() => {
    const buckets = new Map<string, number[]>();
    for (const e of equityRealized.events) {
      const key = `${e.date}|${e.ticker}`;
      const list = buckets.get(key) ?? [];
      list.push(e.amount);
      buckets.set(key, list);
    }
    return equityFiltered.map((row) => {
      if (row.side !== "SELL") return { ...row, realizedPL: undefined };
      const key = `${row.date}|${String(row.ticker ?? "").toUpperCase()}`;
      const list = buckets.get(key);
      const realized = list?.length ? list.shift() : undefined;
      return { ...row, realizedPL: realized };
    });
  }, [equityFiltered, equityRealized.events]);

  const equitySummary = useMemo(() => {
    const buys = equityFiltered.filter((c) => c.side === "BUY");
    const sells = equityFiltered.filter((c) => c.side === "SELL");
    const shares = equityFiltered.reduce((a, c) => a + Math.abs(Number(c.quantity ?? 0)), 0);
    const net = equityFiltered.reduce((a, c) => a + Number(c.amount ?? 0), 0);
    const realized = selectedMonth ? equityRealized.byMonth.get(selectedMonth) ?? 0 : equityRealized.total;
    return {
      buys: buys.length,
      sells: sells.length,
      shares,
      net,
      realized,
    };
  }, [equityFiltered, equityRealized.byMonth, equityRealized.total, selectedMonth]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold">Trades</h1>
          <p className="text-sm text-zinc-600">
            Realized P/L shows when a position is closed. Equity trades are included when you switch to Stocks.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-zinc-600">Instrument</div>
          <div className="flex gap-1 border rounded-xl p-1 bg-white">
            <button
              className={`px-3 py-2 rounded-lg text-sm ${instrument === "OPTIONS" ? "bg-zinc-900 text-white" : ""}`}
              onClick={() => setInstrument("OPTIONS")}
            >
              Options
            </button>
            <button
              className={`px-3 py-2 rounded-lg text-sm ${instrument === "STOCKS" ? "bg-zinc-900 text-white" : ""}`}
              onClick={() => setInstrument("STOCKS")}
            >
              Stocks
            </button>
          </div>
          <div className="text-xs text-zinc-600">
            {instrument === "OPTIONS" ? "Month (close month for realized)" : "Month"}
          </div>
          <select
            className="border rounded-lg px-3 py-2 bg-white"
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          {instrument === "OPTIONS" ? (
            <div className="flex gap-1 border rounded-xl p-1 bg-white">
              <button
                className={`px-3 py-2 rounded-lg text-sm ${tab === "ALL" ? "bg-zinc-900 text-white" : ""}`}
                onClick={() => setTab("ALL")}
              >
                All
              </button>
              <button
                className={`px-3 py-2 rounded-lg text-sm ${tab === "OPEN" ? "bg-zinc-900 text-white" : ""}`}
                onClick={() => setTab("OPEN")}
              >
                Open
              </button>
              <button
                className={`px-3 py-2 rounded-lg text-sm ${tab === "CLOSED" ? "bg-zinc-900 text-white" : ""}`}
                onClick={() => setTab("CLOSED")}
              >
                Closed
              </button>
            </div>
          ) : (
            <select
              className="border rounded-lg px-3 py-2 bg-white text-sm"
              value={equitySide}
              onChange={(e) => setEquitySide(e.target.value as any)}
            >
              <option value="ALL">All sides</option>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </select>
          )}

          {instrument === "OPTIONS" ? (
            <select
              className="border rounded-lg px-3 py-2 bg-white text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value as any)}
              title="Instrument type"
            >
              <option value="ALL">All types</option>
              <option value="SINGLE">Single legs</option>
              <option value="SPREAD">Spreads</option>
            </select>
          ) : null}

          <input
            className="border rounded-xl px-4 py-2 w-[320px] max-w-[70vw]"
            placeholder={instrument === "OPTIONS" ? "Search (SPX, 2025-10-30, PCS, strike…)" : "Search (ticker, notes…)"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {instrument === "OPTIONS" ? (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-8 gap-3">
            <Kpi title="Rows (month)" value={`${filtered.length}`} />
            <Kpi title="Open (month)" value={`${openPositions.length}`} />
            <Kpi title="Closed (month)" value={`${closedPositions.length}`} />
            <Kpi title="Contracts (month)" value={`${Math.round(contractsCount)}`} />
            <Kpi title="Capital used (est.)" value={money(capitalUsed)} />
            <Kpi title="Realized P/L (month)" value={money(realizedSum)} tone={realizedSum >= 0 ? "good" : "bad"} />

            <Kpi
              title={`Option cashflow (raw) ${selectedYear}`}
              value={money(optionCashflowYear)}
              tone={optionCashflowYear >= 0 ? "good" : "bad"}
            />
            <Kpi
              title={`Realized P/L (journal) ${selectedYear}`}
              value={money(realizedYear)}
              tone={realizedYear >= 0 ? "good" : "bad"}
            />
          </div>

          <div className="text-xs text-zinc-600">
            Reconciliation: broker reports often align closer to <b>Option cashflow (raw)</b> (sum of CSV option fill amounts). The journal <b>Realized P/L</b> depends on correctly matching opens/closes across time and quantity.
            For {selectedYear}, detected {optionRowCount} option fill rows in your imported trades.
          </div>

          <div className="border rounded-2xl bg-white overflow-hidden shadow-sm">
            <div className="grid grid-cols-[1.8fr_.7fr_.8fr_.8fr_.7fr_.7fr] gap-2 px-4 py-3 text-xs text-zinc-600 border-b bg-zinc-50">
              <div>Position</div>
              <div>Status</div>
              <div>Opened</div>
              <div>Closed</div>
              <div className="text-right">Premium</div>
              <div className="text-right">Realized P/L</div>
            </div>

            {filtered.length === 0 ? (
              <div className="p-6 text-sm text-zinc-600">No positions match your filters.</div>
            ) : (
              <div>
                {filtered.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => setSelected(p)}
                    className="w-full text-left grid grid-cols-[1.8fr_.7fr_.8fr_.8fr_.7fr_.7fr] gap-2 px-4 py-3 border-b hover:bg-zinc-50 focus:outline-none focus:bg-zinc-50"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{labelPosition(p)}</div>
                      <div className="text-xs text-zinc-500">
                        {(p.kind ?? "SINGLE") === "SPREAD" ? "Spread" : "Option"} • {p.side}
                        {p.kind === "SPREAD" && p.spreadType ? ` • ${p.spreadType}` : ""}
                      </div>
                    </div>

                    <div>
                      <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs border ${statusPill(p.status)}`}>
                        {p.status}
                      </span>
                    </div>

                    <div className="text-sm">{fmtDate(p.openedOn)}</div>
                    <div className="text-sm">{fmtDate(p.closedOn)}</div>

                    <div className="text-right tabular-nums">{money(p.premiumCollected)}</div>
                    <div
                      className={`text-right tabular-nums ${
                        p.status === "CLOSED"
                          ? (p.realizedPL ?? 0) >= 0
                            ? "text-emerald-700"
                            : "text-red-700"
                          : "text-zinc-400"
                      }`}
                    >
                      {p.status === "CLOSED" ? money(p.realizedPL) : "—"}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <Kpi title="Rows (month)" value={`${equityFiltered.length}`} />
            <Kpi title="Buys" value={`${equitySummary.buys}`} />
            <Kpi title="Sells" value={`${equitySummary.sells}`} />
            <Kpi title="Shares" value={`${Math.round(equitySummary.shares)}`} />
            <Kpi title="Net cashflow (month)" value={money(equitySummary.net)} tone={equitySummary.net >= 0 ? "good" : "bad"} />
            <Kpi title="Realized P/L (month)" value={money(equitySummary.realized)} tone={equitySummary.realized >= 0 ? "good" : "bad"} />
          </div>

          <div className="border rounded-2xl bg-white overflow-hidden shadow-sm">
            <div className="grid grid-cols-[.9fr_.7fr_.7fr_.7fr_.7fr_.7fr_.7fr] gap-2 px-4 py-3 text-xs text-zinc-600 border-b bg-zinc-50">
              <div>Date</div>
              <div>Side</div>
              <div>Ticker</div>
              <div className="text-right">Qty</div>
              <div className="text-right">Price</div>
              <div className="text-right">Amount</div>
              <div className="text-right">Realized P/L</div>
            </div>

            {equityRowsWithRealized.length === 0 ? (
              <div className="p-6 text-sm text-zinc-600">No equity trades match your filters.</div>
            ) : (
              <div>
                {equityRowsWithRealized.map((row) => (
                  <div
                    key={row.id}
                    className="grid grid-cols-[.9fr_.7fr_.7fr_.7fr_.7fr_.7fr_.7fr] gap-2 px-4 py-3 text-sm border-b"
                  >
                    <div>{row.date}</div>
                    <div>{row.side ?? "—"}</div>
                    <div>{row.ticker ?? "—"}</div>
                    <div className="text-right tabular-nums">
                      {Number.isFinite(row.quantity) ? Number(row.quantity).toFixed(0) : "—"}
                    </div>
                    <div className="text-right tabular-nums">
                      {Number.isFinite(row.price) ? Number(row.price).toFixed(2) : "—"}
                    </div>
                    <div
                      className={`text-right tabular-nums ${
                        (row.amount ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"
                      }`}
                    >
                      {money(row.amount)}
                    </div>
                    <div
                      className={`text-right tabular-nums ${
                        typeof row.realizedPL === "number" && row.realizedPL >= 0
                          ? "text-emerald-700"
                          : "text-red-700"
                      }`}
                    >
                      {typeof row.realizedPL === "number" ? money(row.realizedPL) : "—"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Details drawer */}
      {instrument === "OPTIONS" && selected && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSelected(null)} />
          <div className="absolute right-0 top-0 h-full w-full max-w-[520px] bg-white shadow-xl border-l overflow-auto">
            <div className="p-4 border-b flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-zinc-500">Details</div>
                <div className="text-lg font-semibold truncate">{labelPosition(selected)}</div>
                <div className="text-sm text-zinc-600">
                  {(selected.kind ?? "SINGLE") === "SPREAD" ? "Spread" : "Option"} • {selected.side}
                  {selected.kind === "SPREAD" && selected.spreadType ? ` • ${selected.spreadType}` : ""}
                  {selected.status ? ` • ${selected.status}` : ""}
                </div>
              </div>
              <button className="px-3 py-2 rounded-lg border hover:bg-zinc-50" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <KpiSmall title="Opened" value={fmtDate(selected.openedOn)} />
                <KpiSmall title="Closed" value={fmtDate(selected.closedOn)} />
                <KpiSmall title="DTE" value={selected.expiry ? `${dte(selected.expiry) ?? "—"}` : "—"} />
                <KpiSmall
                  title="Hold (days)"
                  value={
                    selected.openedOn
                      ? `${daysBetween(selected.openedOn, selected.closedOn ?? new Date().toISOString().slice(0, 10)) ?? "—"}`
                      : "—"
                  }
                />
                <KpiSmall title="Premium" value={money(selected.premiumCollected)} />
                <KpiSmall title="Cost to close" value={money(selected.costToClose)} />
                <KpiSmall title="Realized P/L" value={selected.status === "CLOSED" ? money(selected.realizedPL) : "—"} />
                <KpiSmall
                  title="Capital at risk (est.)"
                  value={typeof estimateCapitalAtRisk(selected) === "number" ? money(estimateCapitalAtRisk(selected)!) : "—"}
                />
                <KpiSmall title="RoR (est.)" value={typeof rocPercent(selected) === "number" ? `${rocPercent(selected)!.toFixed(2)}%` : "—"} />
                <KpiSmall
                  title="Annualized RoR (est.)"
                  value={typeof annualizedRocPercent(selected) === "number" ? `${annualizedRocPercent(selected)!.toFixed(2)}%` : "—"}
                />
              </div>

              {selected.kind === "SPREAD" && (
                <Card title="Spread legs">
                  <div className="space-y-2 text-sm">
                    {(selected.legs ?? []).map((l, idx) => (
                      <div key={idx} className="flex items-center justify-between">
                        <div className="text-zinc-700">
                          <span className="font-medium">{l.side}</span> • Strike {l.strike}
                        </div>
                        <div className="text-zinc-500">{l.key}</div>
                      </div>
                    ))}

                    <div className="grid grid-cols-2 gap-2 pt-2">
                      <KpiSmall title="Width" value={typeof selected.width === "number" ? `${selected.width}` : "—"} />
                      <KpiSmall title="Net credit" value={typeof selected.netCredit === "number" ? money(selected.netCredit) : "—"} />
                      <KpiSmall title="Max profit" value={typeof selected.maxProfit === "number" ? money(selected.maxProfit) : "—"} />
                      <KpiSmall title="Max loss" value={typeof selected.maxLoss === "number" ? money(selected.maxLoss) : "—"} />
                    </div>

                    <div className="text-xs text-zinc-500 pt-2">
                      Note: Spread metrics are estimated from legs on the same opened date. If a leg opened in a different month, it may appear as INCOMPLETE until both months are imported.
                    </div>
                  </div>
                </Card>
              )}

              {selected.status === "INCOMPLETE" && (
                <div className="border rounded-xl p-3 bg-amber-50 text-amber-800 text-sm">
                  This position is marked <b>INCOMPLETE</b> (we saw a close without a matching open in the imported range).
                  Import surrounding months to let the journal pair the open and close correctly.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- UI ---------------- */

function Kpi({ title, value, tone }: { title: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="border rounded-2xl p-4 bg-white shadow-sm">
      <div className="text-xs text-zinc-600">{title}</div>
      <div className={`text-2xl font-semibold ${tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-700" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function KpiSmall({ title, value }: { title: string; value: string }) {
  return (
    <div className="border rounded-xl p-3 bg-white">
      <div className="text-[11px] text-zinc-500">{title}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-2xl p-4 bg-white">
      <div className="mb-2 font-medium">{title}</div>
      {children}
    </div>
  );
}
