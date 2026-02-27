import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

export type AlertDecisionLog = {
  id?: number;
  tsIso: string;
  runId: string;
  decisionMode: string;
  dataMode: string;
  session: string;
  bestCandidateId: string | null;
  bestStrategy: string | null;
  bestPop: number | null;
  bestRor: number | null;
  bestCreditPct: number | null;
  gateCode: string;
  gateMessage: string;
  alertCount: number;
  details?: Record<string, unknown>;
};

const DB_PATH = process.env.ALERT_DECISION_DB_PATH || path.join(process.cwd(), "storage", ".alert_decisions.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_iso TEXT NOT NULL,
      run_id TEXT NOT NULL,
      decision_mode TEXT NOT NULL,
      data_mode TEXT NOT NULL,
      session TEXT NOT NULL,
      best_candidate_id TEXT,
      best_strategy TEXT,
      best_pop REAL,
      best_ror REAL,
      best_credit_pct REAL,
      gate_code TEXT NOT NULL,
      gate_message TEXT NOT NULL,
      alert_count INTEGER NOT NULL,
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_decisions_ts ON alert_decisions(ts_iso);
  `);
  return db;
}

export function recordAlertDecision(entry: AlertDecisionLog): void {
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO alert_decisions (
        ts_iso, run_id, decision_mode, data_mode, session,
        best_candidate_id, best_strategy, best_pop, best_ror, best_credit_pct,
        gate_code, gate_message, alert_count, details_json
      ) VALUES (
        @tsIso, @runId, @decisionMode, @dataMode, @session,
        @bestCandidateId, @bestStrategy, @bestPop, @bestRor, @bestCreditPct,
        @gateCode, @gateMessage, @alertCount, @detailsJson
      )
    `);
    stmt.run({
      tsIso: entry.tsIso,
      runId: entry.runId,
      decisionMode: entry.decisionMode,
      dataMode: entry.dataMode,
      session: entry.session,
      bestCandidateId: entry.bestCandidateId,
      bestStrategy: entry.bestStrategy,
      bestPop: entry.bestPop,
      bestRor: entry.bestRor,
      bestCreditPct: entry.bestCreditPct,
      gateCode: entry.gateCode,
      gateMessage: entry.gateMessage,
      alertCount: entry.alertCount,
      detailsJson: entry.details ? JSON.stringify(entry.details) : null,
    });
  } catch {
    // best effort only
  }
}

export function listAlertDecisions(limit = 20): AlertDecisionLog[] {
  try {
    const db = getDb();
    const stmt = db.prepare(
      "SELECT * FROM alert_decisions ORDER BY id DESC LIMIT ?",
    );
    const rows = stmt.all(Math.max(1, limit));
    return rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      tsIso: String(row.ts_iso),
      runId: String(row.run_id),
      decisionMode: String(row.decision_mode),
      dataMode: String(row.data_mode),
      session: String(row.session),
      bestCandidateId: row.best_candidate_id != null ? String(row.best_candidate_id) : null,
      bestStrategy: row.best_strategy != null ? String(row.best_strategy) : null,
      bestPop: typeof row.best_pop === "number" ? row.best_pop : row.best_pop == null ? null : Number(row.best_pop),
      bestRor: typeof row.best_ror === "number" ? row.best_ror : row.best_ror == null ? null : Number(row.best_ror),
      bestCreditPct:
        typeof row.best_credit_pct === "number"
          ? row.best_credit_pct
          : row.best_credit_pct == null
            ? null
            : Number(row.best_credit_pct),
      gateCode: String(row.gate_code),
      gateMessage: String(row.gate_message),
      alertCount: typeof row.alert_count === "number" ? row.alert_count : Number(row.alert_count ?? 0),
      details: row.details_json ? JSON.parse(String(row.details_json)) : undefined,
    }));
  } catch {
    return [];
  }
}
