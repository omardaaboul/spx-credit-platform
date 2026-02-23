"use client";

import { useEffect, useMemo, useState } from "react";
import Panel from "@/app/components/spx0dte/Panel";
import SpxLayoutFrame from "@/app/components/spx0dte/SpxLayoutFrame";
import StatusBar from "@/app/components/spx0dte/StatusBar";
import TradeVisualizer, { type TradeVisualizerInput } from "@/app/components/spx0dte/TradeVisualizer";
import { useSpxDashboardData } from "@/app/components/spx0dte/useSpxDashboardData";
import { useSpxTheme } from "@/app/components/spx0dte/useSpxTheme";

type CandidateStatus = "GENERATED" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "INVALIDATED";
type UserDecision = "TAKEN" | "SKIPPED" | "WATCHLIST" | null;
type TradeStatus = "OPEN" | "CLOSED" | "EXPIRED";

type CandidateRow = {
  candidate_id: string;
  created_at: string;
  updated_at: string;
  dte_bucket: number;
  direction: "BULL_PUT" | "BEAR_CALL";
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  quoted_credit: number;
  em_1sd_at_signal: number;
  zscore_at_signal: number;
  mmc_stretch_at_signal: number;
  spot_at_signal?: number;
  atm_iv_at_signal?: number;
  status: CandidateStatus;
  user_decision: UserDecision;
};

type TradeRow = {
  trade_id: string;
  candidate_id: string;
  strategy: string;
  direction: "BULL_PUT" | "BEAR_CALL";
  dte_bucket: number;
  expiration: string;
  short_strike: number;
  long_strike: number;
  width: number;
  opened_at: string;
  filled_credit: number;
  quantity: number;
  fees_estimate: number;
  status: TradeStatus;
  close_price: number | null;
  closed_at: string | null;
  realized_pnl: number | null;
  max_profit: number;
  max_loss: number;
  break_even: number;
  current_mark: number | null;
  unrealized_pnl: number | null;
  pnl_percent_of_risk: number | null;
  last_updated_at: string;
};

type TabKey = "candidates" | "open" | "closed";

export default function SpxTradesPage() {
  const { theme, setTheme } = useSpxTheme();
  const { data, loadError } = useSpxDashboardData({ pollMs: 10_000 });
  const [tab, setTab] = useState<TabKey>("candidates");
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [openTrades, setOpenTrades] = useState<TradeRow[]>([]);
  const [closedTrades, setClosedTrades] = useState<TradeRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [visualizerOpen, setVisualizerOpen] = useState(false);
  const [visualizerInput, setVisualizerInput] = useState<TradeVisualizerInput | null>(null);

  const weekPnl = data?.sleeveSettings?.weeklyRealizedPnl ?? 0;
  const dayPnl = data?.sleeveSettings?.dailyRealizedPnl ?? 0;

  const reloadBlotter = async () => {
    try {
      const [candRes, openRes, closedRes] = await Promise.all([
        fetch("/api/spx0dte/candidates?limit=250"),
        fetch("/api/spx0dte/trades?status=OPEN&limit=250"),
        fetch("/api/spx0dte/trades?status=CLOSED&limit=250"),
      ]);
      const candBody = (await candRes.json().catch(() => ({}))) as { candidates?: CandidateRow[] };
      const openBody = (await openRes.json().catch(() => ({}))) as { trades?: TradeRow[] };
      const closedBody = (await closedRes.json().catch(() => ({}))) as { trades?: TradeRow[] };
      setCandidates(Array.isArray(candBody.candidates) ? candBody.candidates : []);
      setOpenTrades(Array.isArray(openBody.trades) ? openBody.trades : []);
      setClosedTrades(Array.isArray(closedBody.trades) ? closedBody.trades : []);
    } catch {
      // keep previous rows
    }
  };

  useEffect(() => {
    reloadBlotter();
    const id = window.setInterval(reloadBlotter, 10_000);
    return () => window.clearInterval(id);
  }, []);

  const activeCandidates = useMemo(
    () => candidates.filter((row) => row.status === "GENERATED" || row.user_decision === "WATCHLIST"),
    [candidates],
  );
  const candidateById = useMemo(() => {
    const map = new Map<string, CandidateRow>();
    for (const row of candidates) map.set(row.candidate_id, row);
    return map;
  }, [candidates]);
  const currentSpot = Number.isFinite(Number(data?.metrics?.spx)) ? Number(data?.metrics?.spx) : null;
  const currentIv = Number.isFinite(Number(data?.metrics?.iv)) ? Number(data?.metrics?.iv) : null;

  const takeCandidate = async (candidate: CandidateRow) => {
    try {
      setBusyId(candidate.candidate_id);
      setNotice("");
      const res = await fetch("/api/spx0dte/trades/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: candidate.candidate_id, quantity: 1 }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setNotice(body.message ?? (res.ok ? "Trade opened." : "Failed to open trade."));
      await reloadBlotter();
    } finally {
      setBusyId(null);
    }
  };

  const rejectCandidate = async (candidate: CandidateRow, decision: "SKIPPED" | "WATCHLIST") => {
    try {
      setBusyId(candidate.candidate_id);
      setNotice("");
      const res = await fetch("/api/spx0dte/trades/reject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate_id: candidate.candidate_id, decision }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setNotice(body.message ?? (res.ok ? "Candidate updated." : "Update failed."));
      await reloadBlotter();
    } finally {
      setBusyId(null);
    }
  };

  const closeOpenTrade = async (trade: TradeRow) => {
    try {
      setBusyId(trade.trade_id);
      setNotice("");
      const res = await fetch("/api/spx0dte/trades/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trade_id: trade.trade_id }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      setNotice(body.message ?? (res.ok ? "Trade closed." : "Close failed."));
      await reloadBlotter();
    } finally {
      setBusyId(null);
    }
  };

  const openCandidateGraph = (row: CandidateRow) => {
    const side = row.direction === "BULL_PUT" ? "PUT_CREDIT" : "CALL_CREDIT";
    setVisualizerInput({
      id: row.candidate_id,
      label: `${row.dte_bucket}-DTE ${row.direction === "BULL_PUT" ? "Bull Put" : "Bear Call"} Candidate`,
      side,
      shortStrike: row.short_strike,
      longStrike: row.long_strike,
      credit: row.quoted_credit,
      width: row.width,
      contracts: 1,
      dte: row.dte_bucket,
      expiry: row.expiration,
      ivAtm: Number.isFinite(Number(row.atm_iv_at_signal)) ? Number(row.atm_iv_at_signal) : currentIv,
      entryUnderlying: Number.isFinite(Number(row.spot_at_signal)) ? Number(row.spot_at_signal) : currentSpot,
      currentSpot,
      currentMark: null,
    });
    setVisualizerOpen(true);
  };

  const openTradeGraph = (row: TradeRow) => {
    const side = row.direction === "BULL_PUT" ? "PUT_CREDIT" : "CALL_CREDIT";
    const sourceCandidate = candidateById.get(row.candidate_id);
    setVisualizerInput({
      id: row.trade_id,
      label: `${row.strategy} · ${row.short_strike}/${row.long_strike}`,
      side,
      shortStrike: row.short_strike,
      longStrike: row.long_strike,
      credit: row.filled_credit,
      width: row.width,
      contracts: row.quantity,
      dte: row.dte_bucket,
      expiry: row.expiration,
      ivAtm: Number.isFinite(Number(sourceCandidate?.atm_iv_at_signal))
        ? Number(sourceCandidate?.atm_iv_at_signal)
        : currentIv,
      entryUnderlying: Number.isFinite(Number(sourceCandidate?.spot_at_signal))
        ? Number(sourceCandidate?.spot_at_signal)
        : currentSpot,
      currentSpot,
      currentMark: Number.isFinite(Number(row.current_mark)) ? Number(row.current_mark) : null,
    });
    setVisualizerOpen(true);
  };

  return (
    <SpxLayoutFrame
      theme={theme}
      title="SPX Trade Center · Trade Blotter"
      unreadAlerts={data?.alerts?.length ?? 0}
      dataQualityWarning={Boolean(data?.staleData?.active || data?.dataContract?.status === "degraded")}
      rightActions={
        <button type="button" onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))} className="btn h-8 px-3 text-xs">
          {theme === "dark" ? "Light" : "Dark"}
        </button>
      }
    >
      <StatusBar
        marketOpen={Boolean(data?.market?.isOpen)}
        dataAgeSeconds={data?.staleData?.ageSeconds}
        dayPnl={dayPnl}
        weekPnl={weekPnl}
        dataContractStatus={data?.dataContract?.status}
        alertCount={data?.alerts?.length ?? 0}
        onOpenAlerts={() => undefined}
      />

      {loadError && <Panel className="border-rose-500/35 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{loadError}</Panel>}
      {notice && <Panel className="border-[var(--spx-accent)]/40 bg-[var(--spx-accent)]/10 px-3 py-2 text-sm text-[var(--spx-text)]">{notice}</Panel>}

      <Panel className="p-3">
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className={`btn h-8 px-3 text-xs ${tab === "candidates" ? "" : "opacity-70"}`} onClick={() => setTab("candidates")}>
            Candidates ({activeCandidates.length})
          </button>
          <button type="button" className={`btn h-8 px-3 text-xs ${tab === "open" ? "" : "opacity-70"}`} onClick={() => setTab("open")}>
            Open Trades ({openTrades.length})
          </button>
          <button type="button" className={`btn h-8 px-3 text-xs ${tab === "closed" ? "" : "opacity-70"}`} onClick={() => setTab("closed")}>
            Closed Trades ({closedTrades.length})
          </button>
        </div>

        {tab === "candidates" && (
          <div className="space-y-2">
            {activeCandidates.length === 0 ? (
              <p className="text-sm text-[var(--spx-muted)]">No active candidates.</p>
            ) : (
              activeCandidates.map((row) => (
                <article key={row.candidate_id} className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-[var(--spx-text)]">
                      {row.dte_bucket}-DTE {row.direction === "BULL_PUT" ? "Bull Put" : "Bear Call"} · {row.short_strike}/{row.long_strike}
                    </p>
                    <p className="text-xs text-[var(--spx-muted)]">{row.expiration}</p>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-[var(--spx-muted)] md:grid-cols-6">
                    <span>Credit {row.quoted_credit.toFixed(2)}</span>
                    <span>Width {row.width}</span>
                    <span>EM {row.em_1sd_at_signal.toFixed(2)}</span>
                    <span>Z {row.zscore_at_signal.toFixed(2)}</span>
                    <span>MMC {row.mmc_stretch_at_signal.toFixed(2)}</span>
                    <span>Status {row.status}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn h-7 px-2 text-xs"
                      disabled={busyId === row.candidate_id}
                      onClick={() => takeCandidate(row)}
                    >
                      {busyId === row.candidate_id ? "Taking..." : "Take"}
                    </button>
                    <button
                      type="button"
                      className="btn h-7 px-2 text-xs"
                      disabled={busyId === row.candidate_id}
                      onClick={() => rejectCandidate(row, "SKIPPED")}
                    >
                      Skip
                    </button>
                    <button
                      type="button"
                      className="btn h-7 px-2 text-xs"
                      disabled={busyId === row.candidate_id}
                      onClick={() => rejectCandidate(row, "WATCHLIST")}
                    >
                      Watchlist
                    </button>
                    <button type="button" className="btn h-7 px-2 text-xs" onClick={() => openCandidateGraph(row)}>
                      View Graph
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        )}

        {tab === "open" && (
          <div className="space-y-2">
            {openTrades.length === 0 ? (
              <p className="text-sm text-[var(--spx-muted)]">No open trades.</p>
            ) : (
              openTrades.map((row) => (
                <article key={row.trade_id} className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-[var(--spx-text)]">
                      {row.strategy} · {row.short_strike}/{row.long_strike}
                    </p>
                    <p className="text-xs text-[var(--spx-muted)]">DTE {row.dte_bucket} · exp {row.expiration}</p>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-[var(--spx-muted)] md:grid-cols-6">
                    <span>Entry {row.filled_credit.toFixed(2)}</span>
                    <span>Mark {row.current_mark == null ? "-" : row.current_mark.toFixed(2)}</span>
                    <span>Unrlzd {row.unrealized_pnl == null ? "-" : `$${row.unrealized_pnl.toFixed(0)}`}</span>
                    <span>Risk {row.max_loss.toFixed(0)}</span>
                    <span>%Risk {row.pnl_percent_of_risk == null ? "-" : `${row.pnl_percent_of_risk.toFixed(1)}%`}</span>
                    <span>Qty {row.quantity}</span>
                  </div>
                  <div className="mt-2">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn h-7 px-2 text-xs"
                        disabled={busyId === row.trade_id}
                        onClick={() => closeOpenTrade(row)}
                      >
                        {busyId === row.trade_id ? "Closing..." : "Close"}
                      </button>
                      <button type="button" className="btn h-7 px-2 text-xs" onClick={() => openTradeGraph(row)}>
                        View Graph
                      </button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
        )}

        {tab === "closed" && (
          <div className="space-y-2">
            {closedTrades.length === 0 ? (
              <p className="text-sm text-[var(--spx-muted)]">No closed trades yet.</p>
            ) : (
              closedTrades.map((row) => (
                <article key={row.trade_id} className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-[var(--spx-text)]">
                      {row.strategy} · {row.short_strike}/{row.long_strike}
                    </p>
                    <p className="text-xs text-[var(--spx-muted)]">
                      {row.closed_at ? new Date(row.closed_at).toLocaleString("en-US", { hour12: false }) : "-"}
                    </p>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2 text-xs text-[var(--spx-muted)] md:grid-cols-5">
                    <span>Entry {row.filled_credit.toFixed(2)}</span>
                    <span>Exit {row.close_price == null ? "-" : row.close_price.toFixed(2)}</span>
                    <span>Realized {row.realized_pnl == null ? "-" : `$${row.realized_pnl.toFixed(0)}`}</span>
                    <span>MaxRisk {row.max_loss.toFixed(0)}</span>
                    <span>Status {row.status}</span>
                  </div>
                  <div className="mt-2">
                    <button type="button" className="btn h-7 px-2 text-xs" onClick={() => openTradeGraph(row)}>
                      View Graph
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        )}
      </Panel>
      <TradeVisualizer open={visualizerOpen} onClose={() => setVisualizerOpen(false)} input={visualizerInput} />
    </SpxLayoutFrame>
  );
}
