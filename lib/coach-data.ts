"use client";

import { useEffect, useMemo, useState } from "react";
import { db, Cashflow, Trade } from "@/lib/db";
import { buildPositionsFromTransactions, monthKey, Position } from "@/lib/journal";
import { classifyPosition } from "@/lib/strategy";
import { computeEquityRealized, type EquityRealizedEvent } from "@/lib/equity";
import type { CoachTrade } from "@/lib/coach-tips";

type RealizedEvent = {
  date: string;
  month: string;
  amount: number;
  ticker: string;
};

export type CoachData = {
  trades: Trade[];
  cashflows: Cashflow[];
  positions: Position[];
  closedPositions: Position[];
  realizedEvents: RealizedEvent[];
  equityEvents: EquityRealizedEvent[];
  coachTrades: CoachTrade[];
};

function asISODate(value?: string) {
  if (!value) return "";
  return value.slice(0, 10);
}

export function useCoachData(): CoachData {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);

  useEffect(() => {
    (async () => {
      const allTrades = await db.trades.toArray();
      setTrades(allTrades);
      const allCashflows = await db.cashflows.toArray();
      setCashflows(allCashflows);
    })();
  }, []);

  const positions = useMemo(() => buildPositionsFromTransactions(trades as any), [trades]);

  const closedPositions = useMemo(() => positions.filter((p) => p.status === "CLOSED"), [positions]);

  const realizedEvents = useMemo(() => {
    return positions
      .flatMap((p) =>
        (p.realizedEvents ?? []).map((e) => ({
          date: String(e.date || ""),
          month: monthKey(String(e.date || "")),
          amount: Number(e.amount ?? 0),
          ticker: String(p.underlying || "").toUpperCase(),
        }))
      )
      .filter((e) => e.date && Number.isFinite(e.amount));
  }, [positions]);

  const equityRealized = useMemo(() => computeEquityRealized(cashflows), [cashflows]);

  const coachTrades = useMemo<CoachTrade[]>(() => {
    const optionTrades = closedPositions.map((p) => ({
      setupId: classifyPosition(p),
      status: "closed",
      pnlAmount: Number(p.realizedPL ?? 0),
      enteredAt: asISODate(p.openedOn),
      plannedEntryDate: asISODate(p.openedOn),
      exitReason: "other",
    }));

    const equityTrades = equityRealized.events.map((e) => ({
      setupId: "EQUITY",
      status: "closed",
      pnlAmount: Number(e.amount ?? 0),
      enteredAt: asISODate(e.date),
      plannedEntryDate: asISODate(e.date),
      exitReason: "other",
    }));

    return [...optionTrades, ...equityTrades];
  }, [closedPositions, equityRealized.events]);

  return {
    trades,
    cashflows,
    positions,
    closedPositions,
    realizedEvents,
    equityEvents: equityRealized.events,
    coachTrades,
  };
}
