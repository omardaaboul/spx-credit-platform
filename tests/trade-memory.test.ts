import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { DashboardPayload } from "@/lib/spx0dte";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "spx0dte-trademem-"));
process.env.SPX0DTE_CANDIDATE_STORE_PATH = path.join(tempDir, "candidates.json");
process.env.SPX0DTE_TRADE_STORE_PATH = path.join(tempDir, "trades.json");
process.env.SPX0DTE_TRADE_EVENT_LOG_PATH = path.join(tempDir, "events.jsonl");

import {
  acceptCandidateAsTrade,
  closeTrade,
  listCandidates,
  listTradeEvents,
  listTrades,
  upsertCandidatesFromDashboard,
} from "@/lib/server/tradeMemory";

function payloadFixture(): DashboardPayload {
  return {
    generatedAtEt: "10:00:00",
    generatedAtParis: "16:00:00",
    market: { isOpen: true, hoursEt: "09:30-16:00 ET", source: "test" },
    metrics: { spx: 5000, emr: 50, vix: 18, putCall: null, range15mPctEm: null, atr1m: null, vwap: null, iv: null },
    regimeSummary: {
      regime: "TREND_UP",
      favored: "2-DTE Credit Spread",
      reason: "",
      volExpansion: false,
      macroActive: false,
      riskBlocked: false,
      slippageSummary: "",
      strategyEligibility: [],
    },
    staleData: { active: false, ageSeconds: 1, thresholdSeconds: 90, detail: "ok" },
    dataContract: { status: "healthy", reason: "ok", feeds: {}, checkedAtIso: new Date().toISOString() },
    startupHealth: { telegramConfigured: true, tastySdkInstalled: true, tastyCredsPresent: true, summary: "ok" },
    readinessSummary: { health: "pass", global: "pass", regime: "pass", liquidity: "pass", volatility: "pass", reasons: [] },
    checklistNavigator: [],
    strategyEligibility: [],
    candidates: [],
    alerts: [],
    openTrades: [],
    priceSeries: [],
    volSeries: [],
    symbolValidation: { dte0: [], dte2: [], bwb: [] },
    warnings: [],
    multiDte: {
      targets: [
        {
          strategy_label: "7-DTE Credit Spread",
          target_dte: 7,
          selected_dte: 6,
          expiration: "2026-03-06",
          ready: true,
          reason: "ok",
          checklist: [],
          recommendation: {
            type: "Bull Put Credit Spread",
            right: "PUT",
            expiry: "2026-03-06",
            short_strike: 4920,
            long_strike: 4910,
            width: 10,
            credit: 1.2,
            max_loss_points: 8.8,
            max_loss_dollars: 880,
            stop_debit: 2.4,
            liquidity_ratio: 0.1,
            profit_take_debit: 0.4,
            delta_stop: 0.3,
            use_delta_stop: true,
            legs: [],
            candidate_id: "cand_fixture_7d",
            em_1sd: 70,
            iv_atm: 0.2,
          },
          metrics: {
            zscore: -1.6,
            measuredMoveCompletion: 1.8,
            ema20: 4980,
            macd_hist: -0.1,
            macd_hist_prev: -0.2,
          },
        },
      ],
    },
  } as DashboardPayload;
}

describe("trade memory", () => {
  beforeEach(() => {
    fs.writeFileSync(process.env.SPX0DTE_CANDIDATE_STORE_PATH!, "[]\n", "utf8");
    fs.writeFileSync(process.env.SPX0DTE_TRADE_STORE_PATH!, "[]\n", "utf8");
    fs.writeFileSync(process.env.SPX0DTE_TRADE_EVENT_LOG_PATH!, "", "utf8");
  });

  it("upserts candidates idempotently", () => {
    const payload = payloadFixture();
    const first = upsertCandidatesFromDashboard(payload, "2026-02-22T10:00:00.000Z");
    const second = upsertCandidatesFromDashboard(payload, "2026-02-22T10:05:00.000Z");

    const rows = listCandidates({ limit: 20 });
    expect(first.inserted).toBe(1);
    expect(second.updated).toBe(1);
    expect(rows.length).toBe(1);
    expect(rows[0]?.candidate_id).toBe("cand_fixture_7d");
    expect(rows[0]?.status).toBe("GENERATED");

    const createdEvents = listTradeEvents(50, "CANDIDATE_CREATED").filter((row) => row.candidate_id === "cand_fixture_7d");
    expect(createdEvents.length).toBe(1);
  });

  it("computes realized pnl with SPX x100 multiplier", () => {
    upsertCandidatesFromDashboard(payloadFixture(), "2026-02-22T10:00:00.000Z");
    const accepted = acceptCandidateAsTrade({
      candidate_id: "cand_fixture_7d",
      quantity: 1,
      filled_credit: 1.2,
      fees_estimate: 2,
    });
    expect(accepted.ok).toBe(true);
    const tradeId = accepted.row?.trade_id;
    expect(tradeId).toBeTruthy();

    const closed = closeTrade({ trade_id: String(tradeId), close_price: 0.4 });
    expect(closed.ok).toBe(true);
    expect(closed.row?.realized_pnl).toBeCloseTo(78, 6); // (1.2 - 0.4) * 100 - 2
    expect(closed.row?.status).toBe("CLOSED");

    const closedRows = listTrades({ status: "CLOSED" });
    expect(closedRows.length).toBe(1);
    expect(closedRows[0]?.realized_pnl).toBeCloseTo(78, 6);

    const events = listTradeEvents(50);
    expect(events.some((row) => row.type === "TRADE_TAKEN")).toBe(true);
    expect(events.some((row) => row.type === "POSITION_OPENED")).toBe(true);
    expect(events.some((row) => row.type === "POSITION_CLOSED")).toBe(true);
  });
});
