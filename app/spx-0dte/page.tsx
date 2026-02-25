"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Settings, X } from "lucide-react";
import type { CandidateCard, DashboardPayload } from "@/lib/spx0dte";
import { useSpxDashboardData } from "@/app/components/spx0dte/useSpxDashboardData";
import styles from "./Dashboard.module.css";

const POLL_MS = 60_000;
const REFRESH_ALERT_SECONDS = 60;
const SETTINGS_KEY = "spx.minimal.settings.v1";

type LocalSettings = {
  slopeThreshold: number;
};

const DEFAULT_SETTINGS: LocalSettings = {
  slopeThreshold: 0.2,
};

type SpreadSummary = {
  spreadLabel: string;
  shortStrike: number | null;
  longStrike: number | null;
  lowerBreakeven: number | null;
  upperBreakeven: number | null;
};

type CandidateDteContext = {
  targetDte: number | null;
  selectedDte: number | null;
  expiration: string | null;
};

type FeedBadge = {
  key: "spot" | "chain" | "greeks";
  label: string;
  state: "ok" | "warn" | "na";
  detail: string;
};

export default function Spx0DtePage() {
  const { data, loadError, reload, lastSuccessAtMs } = useSpxDashboardData({ pollMs: POLL_MS });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settings, setSettings] = useState<LocalSettings>(DEFAULT_SETTINGS);
  const [entryState, setEntryState] = useState<"idle" | "sending" | "ok" | "error">("idle");
  const [entryMessage, setEntryMessage] = useState("");
  const [opsSaveState, setOpsSaveState] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [opsSaveMsg, setOpsSaveMsg] = useState("");
  const [marketCloseCountdown, setMarketCloseCountdown] = useState("--:--:--");
  const [eventsCollapsed, setEventsCollapsed] = useState(false);
  const [localRefreshAgeSec, setLocalRefreshAgeSec] = useState<number | null>(null);
  const [refreshAlertSent, setRefreshAlertSent] = useState(false);
  const [requireMeasuredMove, setRequireMeasuredMove] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<LocalSettings>;
      setSettings({
        slopeThreshold: asPositiveNumber(parsed.slopeThreshold, DEFAULT_SETTINGS.slopeThreshold),
      });
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const twoDteSettings = (data?.twoDte?.settings ?? {}) as Record<string, unknown>;
    setRequireMeasuredMove(Boolean(twoDteSettings.require_measured_move ?? false));
  }, [data?.twoDte?.settings]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "SPX Trading Dashboard";
  }, []);

  useEffect(() => {
    const isOpen = Boolean(data?.market?.isOpen);
    if (!isOpen) {
      setMarketCloseCountdown("--:--:--");
      return;
    }

    const closeSecondsEt = parseCloseSecondsFromHours(data?.market?.hoursEt);
    const updateCountdown = () => {
      const secondsLeft = closeSecondsEt - getEtSecondsSinceMidnight();
      setMarketCloseCountdown(secondsLeft > 0 ? formatSecondsHms(secondsLeft) : "00:00:00");
    };

    updateCountdown();
    const id = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(id);
  }, [data?.market?.isOpen, data?.market?.hoursEt]);

  useEffect(() => {
    if (!lastSuccessAtMs) {
      setLocalRefreshAgeSec(null);
      return;
    }
    const tick = () => {
      const age = Math.max(0, Math.floor((Date.now() - lastSuccessAtMs) / 1000));
      setLocalRefreshAgeSec(age);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [lastSuccessAtMs]);

  const candidate = useMemo(() => pickPrimaryCreditCandidate(data), [data]);
  const candidateIsReady = Boolean(candidate?.ready) && (data?.decision ? data.decision.status === "READY" : true);
  const spread = useMemo(() => buildSpreadSummary(candidate), [candidate]);
  const candidateDte = useMemo(() => resolveCandidateDteContext(candidate, data), [candidate, data]);
  const candidateExpectedMove = useMemo(() => resolveCandidateExpectedMove(candidate, data), [candidate, data]);
  const candidateMeasuredMoveDetail = useMemo(() => resolveCandidateMeasuredMoveDetail(candidate, data), [candidate, data]);
  const candidateZScore = useMemo(() => resolveCandidateZScore(candidate, data), [candidate, data]);
  const candidateMmcPassed = useMemo(() => resolveCandidateMmcPassed(candidate, data), [candidate, data]);
  const openTrades = useMemo(
    () => (data?.openTrades ?? []).filter((trade) => trade.status === "OPEN" || trade.status === "EXIT_PENDING"),
    [data?.openTrades],
  );
  const upcomingMacro = useMemo(
    () =>
      (data?.upcomingMacroEvents ?? [])
        .filter((event) => Number(event.daysOut) >= 0 && Number(event.daysOut) <= 7)
        .sort((a, b) => Number(a.daysOut) - Number(b.daysOut)),
    [data?.upcomingMacroEvents],
  );
  const feedBadges = useMemo<FeedBadge[]>(() => {
    const feeds = data?.dataContract?.feeds;
    const mapFeed = (dataKey: "underlying_price" | "option_chain" | "greeks", label: string, key: FeedBadge["key"]): FeedBadge => {
      const feed = feeds?.[dataKey];
      if (!feed) {
        return { key, label, state: "na", detail: "n/a" };
      }
      const ageSec = feed.ageMs == null ? null : Math.round(feed.ageMs / 1000);
      const source = feed.source || data?.market?.source || "unknown";
      const ageText = ageSec == null ? "age n/a" : `${ageSec}s`;
      if (feed.isValid) {
        return { key, label, state: "ok", detail: `${source} • ${ageText}` };
      }
      const reason = feed.error ? String(feed.error).replace(/\.$/, "") : "stale/missing";
      return { key, label, state: "warn", detail: `${source} • ${ageText} • ${reason}` };
    };
    return [
      mapFeed("underlying_price", "Spot", "spot"),
      mapFeed("option_chain", "Chain", "chain"),
      mapFeed("greeks", "Greeks", "greeks"),
    ];
  }, [data?.dataContract?.feeds, data?.market?.source]);

  const trend = useMemo(() => deriveTrend(data, settings.slopeThreshold), [data, settings.slopeThreshold]);
  const reasons = useMemo(() => extractBlockReasons(candidate, data), [candidate, data]);
  const gateNotice = useMemo(() => (data?.warnings ?? []).find((w) => /^Gate notice/i.test(String(w))), [data?.warnings]);
  const directionalRegime = data?.regimeSummary?.regime ?? "-";
  const volRegime = data?.decision?.vol?.regime ?? "UNKNOWN";
  const volConfidence = data?.decision?.vol?.confidence ?? "LOW";
  const volWarningText = (data?.decision?.vol?.warnings ?? []).slice(0, 2).join(" • ");
  const dataMode = data?.data_mode ?? "-";
  const timeEt = data?.generatedAtEt ?? "--:--:--";
  const spot = safeNum(data?.metrics?.spx);
  const emr = safeNum(data?.metrics?.emr);
  const vix = safeNum(data?.metrics?.vix);
  const backendAgeSec = data?.staleData?.ageSeconds ?? null;
  const closedOverrideEnabled = Boolean(data?.market_closed_override);
  const closedOverrideMode = data?.data_mode ?? "HISTORICAL";
  const refreshAlertActive = Boolean(data?.market?.isOpen) && (
    (localRefreshAgeSec != null && localRefreshAgeSec > REFRESH_ALERT_SECONDS) ||
    (backendAgeSec != null && backendAgeSec > REFRESH_ALERT_SECONDS)
  );
  const refreshAlertAge = Math.max(localRefreshAgeSec ?? 0, backendAgeSec ?? 0);

  useEffect(() => {
    if (!refreshAlertActive) {
      setRefreshAlertSent(false);
      return;
    }
    if (refreshAlertSent) return;
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
      new Notification("SPX data refresh delayed", {
        body: `No fresh update for ${refreshAlertAge}s (target <= ${REFRESH_ALERT_SECONDS}s).`,
      });
    }
    setRefreshAlertSent(true);
  }, [refreshAlertActive, refreshAlertAge, refreshAlertSent]);

  const confirmEntry = async () => {
    if (!candidate) return;

    setEntryState("sending");
    setEntryMessage("");

    try {
      const dte = candidate.daysToExpiry ?? extractDteFromStrategy(candidate.strategy);

      if (dte === 2 && data?.twoDte?.recommendation) {
        const res = await fetch("/api/spx0dte", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "place_2dte_trade", recommendation: data.twoDte.recommendation }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          setEntryState("error");
          setEntryMessage(String(body.message ?? "2-DTE paper place failed."));
          return;
        }
        setEntryState("ok");
        setEntryMessage(String(body.message ?? "2-DTE paper order submitted."));
        await reload();
        return;
      }

      if ([7, 14, 30, 45].includes(dte)) {
        const res = await fetch("/api/spx0dte", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "place_multidte_trade", candidate, dte }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          setEntryState("error");
          setEntryMessage(String(body.message ?? `${dte}-DTE paper place failed.`));
          return;
        }
        setEntryState("ok");
        setEntryMessage(String(body.message ?? `${dte}-DTE paper order submitted.`));
        await reload();
        return;
      }

      const res = await fetch("/api/spx0dte", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "place_primary_trade", candidate }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setEntryState("error");
        setEntryMessage(String(body.message ?? "Paper place failed."));
        return;
      }
      setEntryState("ok");
      setEntryMessage(String(body.message ?? "Paper order submitted."));
      await reload();
    } catch {
      setEntryState("error");
      setEntryMessage("Network error or invalid response.");
    } finally {
      window.setTimeout(() => setEntryState("idle"), 2200);
    }
  };

  const saveOperationalToggles = async () => {
    try {
      setOpsSaveState("saving");
      setOpsSaveMsg("");
      const base = (data?.twoDte?.settings ?? {}) as Record<string, unknown>;
      const payload = {
        enabled: boolOr(base.enabled, true),
        width: numOr(base.width, 10),
        short_delta_min: numOr(base.short_delta_min, 0.1),
        short_delta_max: numOr(base.short_delta_max, 0.2),
        auto_select_params: boolOr(base.auto_select_params, true),
        min_strike_distance: numOr(base.min_strike_distance, 30),
        max_strike_distance: numOr(base.max_strike_distance, 50),
        min_credit: numOr(base.min_credit, 0.8),
        max_credit: numOr(base.max_credit, 1.0),
        use_delta_stop: boolOr(base.use_delta_stop, true),
        delta_stop: numOr(base.delta_stop, 0.4),
        stop_multiple: numOr(base.stop_multiple, 3),
        profit_take_debit: numOr(base.profit_take_debit, 0.05),
        require_measured_move: requireMeasuredMove,
        allow_catalyst: boolOr(base.allow_catalyst, false),
      };
      const res = await fetch("/api/spx0dte", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_2dte_settings", ...payload }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (!res.ok || !body.ok) {
        setOpsSaveState("error");
        setOpsSaveMsg(body.message ?? "Failed to save toggles.");
        return;
      }
      setOpsSaveState("ok");
      setOpsSaveMsg(body.message ?? "Trading toggles saved.");
      await reload();
    } catch {
      setOpsSaveState("error");
      setOpsSaveMsg("Failed to save toggles.");
    } finally {
      window.setTimeout(() => setOpsSaveState("idle"), 2200);
    }
  };

  return (
    <div className={styles.container}>
      <main className={styles.main}>
        <section className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>SPX Trading Dashboard</h1>
          <p className={styles.pageSubtitle}>Manual execution only</p>
        </section>

        <div className={styles.topRow}>
          <div className={styles.topBar}>
            <Metric label="Time (ET)" value={timeEt} />
            <Metric label="To Close (ET)" value={data?.market?.isOpen ? marketCloseCountdown : "-"} />
            <Metric label="SPX Spot" value={formatNumber(spot, 2)} />
            <Metric label="EMR" value={emr == null ? "-" : formatNumber(emr, 2)} />
            <Metric label="VIX" value={vix == null ? "-" : formatNumber(vix, 2)} />
          </div>
          <button className={styles.settingsButton} onClick={() => setDrawerOpen(true)} aria-label="Open settings">
            <Settings size={18} />
          </button>
        </div>

        <section className={styles.regimeStrip}>
          <div className={styles.regimeChip}>
            <span className={styles.regimeChipLabel}>Directional</span>
            <strong>{directionalRegime}</strong>
          </div>
          <div className={styles.regimeChip}>
            <span className={styles.regimeChipLabel}>Volatility</span>
            <strong>
              {volRegime} ({volConfidence})
            </strong>
          </div>
          <div className={styles.regimeChip}>
            <span className={styles.regimeChipLabel}>Data Mode</span>
            <strong>
              {dataMode} • {timeEt} ET
            </strong>
          </div>
          {(volRegime === "UNKNOWN" || volConfidence === "LOW") && volWarningText && (
            <div className={styles.regimeWarning} title={volWarningText}>
              ⚠ {volWarningText}
            </div>
          )}
        </section>

        <section className={styles.feedRow}>
          {feedBadges.map((badge) => (
            <div
              key={badge.key}
              className={`${styles.feedBadge} ${badge.state === "ok" ? styles.feedBadgeOk : badge.state === "warn" ? styles.feedBadgeWarn : styles.feedBadgeNa}`}
            >
              <span className={styles.feedBadgeLabel}>{badge.label}</span>
              <span className={styles.feedBadgeDetail}>{badge.detail}</span>
            </div>
          ))}
        </section>

        {loadError && <div className={styles.card}>Connection warning: {loadError}</div>}
        {gateNotice && <div className={`${styles.card} ${styles.warningCard}`}>⚠ {gateNotice}</div>}
        {closedOverrideEnabled && (
          <div className={`${styles.card} ${styles.warningCard}`}>
            ⚠ Simulation Mode - Market Closed. Using {closedOverrideMode} data. Not for live trading.
          </div>
        )}
        {refreshAlertActive && (
          <div className={`${styles.card} ${styles.warningCard}`}>
            ⚠ Data refresh delayed: no fresh update for {refreshAlertAge}s (target ≤ {REFRESH_ALERT_SECONDS}s).
          </div>
        )}

        <div className={`${styles.contentWithSidebar} ${eventsCollapsed ? styles.contentWithSidebarCollapsed : ""}`}>
          <div className={styles.contentMain}>
            <div className={styles.columns}>
              <section className={styles.card}>
                <h2 className={styles.heading}>Market Trend</h2>
                <div className={styles.grid3}>
                  <Metric label="Trend" value={trend.direction} />
                  <Metric label="Slope" value={trend.slope == null ? "-" : `${trend.slope.toFixed(2)} pts/min`} />
                  <Metric label="Recommended" value={trend.recommended} />
                </div>
                <p className={styles.small}>Slope threshold: {settings.slopeThreshold.toFixed(2)} pts/min</p>
              </section>

              <section className={styles.card}>
                <h2 className={styles.heading}>Credit Spread Candidate</h2>
                {candidate && candidateIsReady ? (
                  <>
                    <div className={styles.grid2}>
                      <Metric label="Spread" value={spread.spreadLabel} />
                      <Metric
                        label="Strikes"
                        value={
                          spread.shortStrike != null && spread.longStrike != null
                            ? `Short ${Math.round(spread.shortStrike)} / Long ${Math.round(spread.longStrike)}`
                            : "-"
                        }
                      />
                      <Metric label="Credit" value={candidateCredit(candidate).toFixed(2)} />
                      <Metric label="Width" value={`${candidate.width} pts`} />
                      <Metric label="Max Loss" value={`$${Math.round(candidate.maxRisk).toLocaleString("en-US")}`} />
                      <Metric label="POP" value={`${(candidate.popPct * 100).toFixed(1)}%`} />
                    </div>
                    <p className={styles.small}>
                      Breakeven: {formatBreakeven(spread.lowerBreakeven)} to {formatBreakeven(spread.upperBreakeven)}
                    </p>
                    {candidateDte && (
                      <p className={styles.small}>
                        DTE/Expiry:{" "}
                        {formatDteExpiry(candidateDte)}
                      </p>
                    )}
                    {candidateExpectedMove != null && (
                      <p className={styles.small}>Expected Move (1σ): {candidateExpectedMove.toFixed(2)} pts</p>
                    )}
                    {candidateMeasuredMoveDetail && (
                      <p className={styles.small}>Measured move: {candidateMeasuredMoveDetail}</p>
                    )}
                    <button className={styles.button} onClick={confirmEntry} disabled={entryState === "sending"}>
                      {entryState === "sending" ? "Submitting..." : "Confirm Entry"}
                    </button>
                    {entryMessage && <p className={styles.small}>{entryMessage}</p>}
                  </>
                ) : (
                  <>
                    <p>No valid credit spread candidate at the moment.</p>
                    {candidateMeasuredMoveDetail && (
                      <p className={styles.small}>Measured move: {candidateMeasuredMoveDetail}</p>
                    )}
                    {reasons.slice(0, 3).map((reason) => (
                      <p key={reason} className={styles.small}>
                        • {reason}
                      </p>
                    ))}
                  </>
                )}
              </section>
            </div>

            <section className={styles.card}>
              <h2 className={styles.heading}>Open Trades</h2>
              {openTrades.length === 0 ? (
                <p>You have no open trades.</p>
              ) : (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Trade ID</th>
                      <th>Type</th>
                      <th>Entry</th>
                      <th>P/L %</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openTrades.map((trade) => (
                      <tr key={trade.id}>
                        <td>{trade.id}</td>
                        <td>{trade.strategy}</td>
                        <td>{trade.entryEt}</td>
                        <td>{(trade.plPct * 100).toFixed(1)}%</td>
                        <td>{trade.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <aside className={`${styles.eventsSidebar} ${eventsCollapsed ? styles.eventsSidebarCollapsed : ""}`}>
            <div className={styles.eventsSidebarHeader}>
              <h2 className={styles.heading}>Economic Events</h2>
              <button
                type="button"
                className={styles.collapseButton}
                onClick={() => setEventsCollapsed((prev) => !prev)}
                aria-label={eventsCollapsed ? "Expand economic events" : "Collapse economic events"}
              >
                {eventsCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
              </button>
            </div>

            {!eventsCollapsed && (
              <>
                <p className={styles.small}>Upcoming (next 7 days)</p>
                {data?.macroCalendarStatus && (
                  <p className={styles.small}>Calendar freshness: {data.macroCalendarStatus.detail}</p>
                )}
                {upcomingMacro.length === 0 ? (
                  <p className={styles.small}>No scheduled macro events in the next 7 days.</p>
                ) : (
                  <table className={styles.eventsTable}>
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>Type</th>
                        <th>Impact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upcomingMacro.map((event) => (
                        <tr key={`${event.date}-${event.timeEt}-${event.name}`}>
                          <td>
                            <p className={styles.eventTitle}>
                              {formatEventDate(event.date)} – {event.name} ({event.timeEt} ET)
                            </p>
                            {event.info && <p className={styles.eventInfo}>{event.info}</p>}
                            {event.url && (
                              <a className={styles.eventLink} href={event.url} target="_blank" rel="noreferrer">
                                Source
                              </a>
                            )}
                          </td>
                          <td>{event.eventType ?? "Macro"}</td>
                          <td>{event.impact ?? (event.inMarketHours ? "High" : "Medium")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}

            {eventsCollapsed && (
              <div className={styles.eventsCollapsedSummary}>
                <span className={styles.eventsCollapsedCount}>{upcomingMacro.length}</span>
                <span className={styles.eventsCollapsedText}>7d</span>
              </div>
            )}
          </aside>
        </div>
      </main>

      {drawerOpen && <button type="button" className={styles.drawerBackdrop} onClick={() => setDrawerOpen(false)} aria-label="Close settings" />}

      <aside className={`${styles.drawer} ${drawerOpen ? styles.drawerOpen : ""}`}>
        <button className={styles.closeButton} onClick={() => setDrawerOpen(false)} aria-label="Close settings">
          <X size={20} />
        </button>
        <h3 className={styles.heading}>Settings</h3>

        <label className={styles.label}>
          Trend-slope threshold
          <input
            className={styles.input}
            type="number"
            min={0.05}
            max={1}
            step={0.05}
            value={settings.slopeThreshold}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                slopeThreshold: asPositiveNumber(Number(event.target.value), prev.slopeThreshold),
              }))
            }
          />
        </label>

        <div className={styles.toggleRow}>
          <div>
            <p className={styles.toggleTitle}>Measured-move completion</p>
            <p className={styles.toggleHint}>If incomplete, should entries be allowed or blocked?</p>
          </div>
          <div className={styles.segmented}>
            <button
              type="button"
              className={`${styles.segmentBtn} ${!requireMeasuredMove ? styles.segmentBtnActive : ""}`}
              onClick={() => setRequireMeasuredMove(false)}
            >
              Allow
            </button>
            <button
              type="button"
              className={`${styles.segmentBtn} ${requireMeasuredMove ? styles.segmentBtnActive : ""}`}
              onClick={() => setRequireMeasuredMove(true)}
            >
              Block
            </button>
          </div>
        </div>

        <button className={styles.button} onClick={saveOperationalToggles} disabled={opsSaveState === "saving"}>
          {opsSaveState === "saving" ? "Saving..." : "Save Trading Toggles"}
        </button>
        {opsSaveMsg && <p className={styles.small}>{opsSaveMsg}</p>}
      </aside>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function pickPrimaryCreditCandidate(data: DashboardPayload | null): CandidateCard | null {
  const ranked = data?.decision?.ranked ?? [];
  if (ranked.length > 0) {
    const rankedCredit = ranked.map((row) => row.candidate).find((candidate) => isCreditSpread(candidate));
    if (rankedCredit) return rankedCredit;
  }

  const list = data?.candidates ?? [];
  const creditOnly = list.filter((candidate) => isCreditSpread(candidate));
  if (creditOnly.length === 0) return null;
  return creditOnly.find((candidate) => candidate.ready) ?? creditOnly[0];
}

function isCreditSpread(candidate: CandidateCard): boolean {
  if (/debit/i.test(candidate.strategy)) return false;
  if (/credit spread|directional spread/i.test(candidate.strategy)) return true;
  const puts = candidate.legs.filter((leg) => leg.type === "PUT");
  const calls = candidate.legs.filter((leg) => leg.type === "CALL");
  const hasVertical = (puts.length === 2 && calls.length === 0) || (calls.length === 2 && puts.length === 0);
  return hasVertical && candidateCredit(candidate) > 0;
}

function candidateCredit(candidate: CandidateCard): number {
  if (typeof candidate.adjustedPremium === "number") return candidate.adjustedPremium;
  if (typeof candidate.premium === "number") return candidate.premium;
  return candidate.credit;
}

function deriveTrend(data: DashboardPayload | null, slopeThreshold: number): {
  direction: "UP" | "DOWN" | "FLAT" | "-";
  slope: number | null;
  recommended: "Bull Put" | "Bear Call" | "None" | "-";
} {
  if (!data?.market?.isOpen) {
    return {
      direction: "-",
      slope: null,
      recommended: "-",
    };
  }

  const slope = extractSlope(data);

  let direction: "UP" | "DOWN" | "FLAT" = "FLAT";
  if (slope != null) {
    if (slope >= slopeThreshold) direction = "UP";
    else if (slope <= -slopeThreshold) direction = "DOWN";
  } else {
    const regime = (data?.regimeSummary?.regime ?? "").toUpperCase();
    if (regime.includes("TREND_UP")) direction = "UP";
    if (regime.includes("TREND_DOWN")) direction = "DOWN";
  }

  const recommended = direction === "UP" ? "Bull Put" : direction === "DOWN" ? "Bear Call" : "None";
  return { direction, slope, recommended };
}

function extractSlope(data: DashboardPayload | null): number | null {
  const maybeNumber = [
    data?.twoDte?.metrics?.slope_5m,
    ...(data?.multiDte?.targets?.map((target) => target.metrics?.slope_5m) ?? []),
  ]
    .map((value) => (typeof value === "number" ? value : null))
    .find((value): value is number => value != null && Number.isFinite(value));

  return maybeNumber ?? null;
}

function buildSpreadSummary(candidate: CandidateCard | null): SpreadSummary {
  if (!candidate) {
    return {
      spreadLabel: "-",
      shortStrike: null,
      longStrike: null,
      lowerBreakeven: null,
      upperBreakeven: null,
    };
  }

  const shortPut = candidate.legs.find((leg) => leg.action === "SELL" && leg.type === "PUT");
  const longPut = candidate.legs.find((leg) => leg.action === "BUY" && leg.type === "PUT");
  const shortCall = candidate.legs.find((leg) => leg.action === "SELL" && leg.type === "CALL");
  const longCall = candidate.legs.find((leg) => leg.action === "BUY" && leg.type === "CALL");
  const credit = candidateCredit(candidate);

  if (shortPut && longPut && !shortCall && !longCall) {
    return {
      spreadLabel: "Bull Put Spread",
      shortStrike: shortPut.strike,
      longStrike: longPut.strike,
      lowerBreakeven: shortPut.strike - credit,
      upperBreakeven: null,
    };
  }

  if (shortCall && longCall && !shortPut && !longPut) {
    return {
      spreadLabel: "Bear Call Spread",
      shortStrike: shortCall.strike,
      longStrike: longCall.strike,
      lowerBreakeven: null,
      upperBreakeven: shortCall.strike + credit,
    };
  }

  return {
    spreadLabel: candidate.strategy,
    shortStrike: shortPut?.strike ?? shortCall?.strike ?? null,
    longStrike: longPut?.strike ?? longCall?.strike ?? null,
    lowerBreakeven: null,
    upperBreakeven: null,
  };
}

function extractBlockReasons(candidate: CandidateCard | null, data: DashboardPayload | null): string[] {
  const decision = data?.decision;
  if (decision) {
    const explicit = [
      ...(decision.blocks ?? []).map((row) => row.message),
      ...(decision.debug?.stages ?? [])
        .filter((stage) => stage.status !== "PASS")
        .flatMap((stage) => stage.reasons.map((row) => row.message)),
    ].filter(Boolean);
    if (explicit.length > 0) {
      return [...new Set(explicit)].slice(0, 3);
    }
  }

  if (!candidate) {
    const reason =
      data?.strategyEligibility?.find((row) => /credit spread|directional spread/i.test(row.strategy) && row.reason)?.reason ??
      "No candidate generated from current chain.";
    return [reason];
  }

  const reasons: string[] = [];
  if (candidate.reason) reasons.push(candidate.reason);

  for (const row of candidate.checklist?.strategy ?? []) {
    if ((row.status === "fail" || row.status === "blocked") && row.detail) reasons.push(row.detail);
  }

  return [...new Set(reasons.filter(Boolean))];
}

function extractDteFromStrategy(strategy?: string): number {
  if (!strategy) return 0;
  const match = strategy.match(/(\d+)-DTE/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : 0;
}

function resolveCandidateDteContext(candidate: CandidateCard | null, data: DashboardPayload | null): CandidateDteContext | null {
  if (!candidate) return null;
  if (!candidate.ready) return null;

  if (candidate.strategy === "2-DTE Credit Spread") {
    const expiry = toIsoDate(data?.twoDte?.recommendation?.expiry);
    const selectedRaw = Number.isFinite(candidate.daysToExpiry) ? Number(candidate.daysToExpiry) : 2;
    const selected = selectedRaw > 0 ? selectedRaw : null;
    return {
      targetDte: 2,
      selectedDte: selected,
      expiration: expiry,
    };
  }

  const strategyDte = extractDteFromStrategy(candidate.strategy);
  const targets = data?.multiDte?.targets ?? [];
  const targetRow =
    targets.find((row) => row.strategy_label === candidate.strategy) ??
    (strategyDte > 0 ? targets.find((row) => row.target_dte === strategyDte) : undefined);

  if (!targetRow && strategyDte <= 0) return null;

  const targetDte = targetRow?.target_dte ?? strategyDte;
  const selectedDte =
    (targetRow?.selected_dte != null && Number.isFinite(Number(targetRow.selected_dte))
      ? Number(targetRow.selected_dte) > 0
        ? Number(targetRow.selected_dte)
        : null
      : Number.isFinite(candidate.daysToExpiry)
        ? Number(candidate.daysToExpiry) > 0
          ? Number(candidate.daysToExpiry)
          : null
        : null);
  const expiration = toIsoDate(targetRow?.recommendation?.expiry ?? targetRow?.expiration ?? null);

  return {
    targetDte: Number.isFinite(targetDte) && targetDte > 0 ? targetDte : null,
    selectedDte,
    expiration,
  };
}

function resolveCandidateExpectedMove(candidate: CandidateCard | null, data: DashboardPayload | null): number | null {
  if (!candidate) return null;

  if (candidate.strategy === "2-DTE Credit Spread") {
    const rec = data?.twoDte?.recommendation as Record<string, unknown> | null | undefined;
    const metrics = data?.twoDte?.metrics as Record<string, unknown> | undefined;
    return toFiniteNumber(rec?.em_1sd) ?? toFiniteNumber(metrics?.em_1sd) ?? null;
  }

  const strategyDte = extractDteFromStrategy(candidate.strategy);
  const targets = data?.multiDte?.targets ?? [];
  const targetRow =
    targets.find((row) => row.strategy_label === candidate.strategy) ??
    (strategyDte > 0 ? targets.find((row) => row.target_dte === strategyDte) : undefined);

  const rec = (targetRow?.recommendation ?? null) as Record<string, unknown> | null;
  const metrics = (targetRow?.metrics ?? {}) as Record<string, unknown>;
  return toFiniteNumber(rec?.em_1sd) ?? toFiniteNumber(metrics?.em_1sd) ?? null;
}

function resolveCandidateMeasuredMoveDetail(candidate: CandidateCard | null, data: DashboardPayload | null): string | null {
  const fromMetrics = (metrics: Record<string, unknown> | null | undefined): string | null => {
    if (!metrics) return null;
    const explicit = String(metrics.measuredMoveDetail ?? "").trim();
    if (explicit) return explicit;

    const completion = toFiniteNumber(metrics.measuredMoveCompletion);
    const passed = metrics.measuredMovePass;
    if (completion == null) return null;
    const status = typeof passed === "boolean" ? (passed ? "pass" : "fail") : "n/a";
    return `completion ${completion.toFixed(2)} (${status})`;
  };

  const fromChecklist = (rows: Array<{ name: string; detail: string }> | undefined): string | null => {
    if (!rows) return null;
    const row = rows.find((r) => /measured move near completion/i.test(String(r.name)));
    if (!row) return null;
    return String(row.detail ?? "").trim() || "Checklist row present";
  };

  if (!candidate) {
    const twoDteChecklist = fromChecklist((data?.twoDte?.checklist as Array<{ name: string; detail: string }> | undefined));
    if (twoDteChecklist) return `2-DTE: ${twoDteChecklist}`;
    const twoDteMetrics = fromMetrics((data?.twoDte?.metrics ?? null) as Record<string, unknown> | null);
    if (twoDteMetrics) return `2-DTE: ${twoDteMetrics}`;

    const targets = data?.multiDte?.targets ?? [];
    for (const target of targets) {
      const targetChecklist = fromChecklist((target.checklist as Array<{ name: string; detail: string }> | undefined));
      if (targetChecklist) return `${target.target_dte}-DTE: ${targetChecklist}`;
      const targetMetrics = fromMetrics((target.metrics ?? null) as Record<string, unknown> | null);
      if (targetMetrics) return `${target.target_dte}-DTE: ${targetMetrics}`;
    }
    return "Waiting for enough bars + IV to compute measured move";
  }

  const checklistDetail = fromChecklist(candidate.checklist?.strategy as Array<{ name: string; detail: string }> | undefined);
  if (checklistDetail) return checklistDetail;

  if (candidate.strategy === "2-DTE Credit Spread") {
    const twoDteMetrics = (data?.twoDte?.metrics ?? null) as Record<string, unknown> | null;
    return fromMetrics(twoDteMetrics) ?? "Waiting for enough bars + IV to compute measured move";
  }

  const strategyDte = extractDteFromStrategy(candidate.strategy);
  const targets = data?.multiDte?.targets ?? [];
  const targetRow =
    targets.find((row) => row.strategy_label === candidate.strategy) ??
    (strategyDte > 0 ? targets.find((row) => row.target_dte === strategyDte) : undefined);
  const targetMetrics = (targetRow?.metrics ?? null) as Record<string, unknown> | null;
  return fromMetrics(targetMetrics) ?? "Waiting for enough bars + IV to compute measured move";
}

function resolveCandidateZScore(candidate: CandidateCard | null, data: DashboardPayload | null): number | null {
  if (!candidate) return null;
  if (candidate.strategy === "2-DTE Credit Spread") {
    const rec = data?.twoDte?.recommendation as Record<string, unknown> | null | undefined;
    const metrics = data?.twoDte?.metrics as Record<string, unknown> | undefined;
    return toFiniteNumber(rec?.zscore) ?? toFiniteNumber(metrics?.zscore) ?? null;
  }
  const strategyDte = extractDteFromStrategy(candidate.strategy);
  const targets = data?.multiDte?.targets ?? [];
  const targetRow =
    targets.find((row) => row.strategy_label === candidate.strategy) ??
    (strategyDte > 0 ? targets.find((row) => row.target_dte === strategyDte) : undefined);
  const rec = (targetRow?.recommendation ?? null) as Record<string, unknown> | null;
  const metrics = (targetRow?.metrics ?? {}) as Record<string, unknown>;
  return toFiniteNumber(rec?.zscore) ?? toFiniteNumber(metrics?.zscore) ?? null;
}

function resolveCandidateMmcPassed(candidate: CandidateCard | null, data: DashboardPayload | null): boolean | null {
  if (!candidate) return null;
  const row = (candidate.checklist?.strategy ?? []).find((item) => /measured move near completion/i.test(String(item.name)));
  if (row?.status === "pass") return true;
  if (row?.status === "fail" || row?.status === "blocked") return false;

  if (candidate.strategy === "2-DTE Credit Spread") {
    const metrics = data?.twoDte?.metrics as Record<string, unknown> | undefined;
    return typeof metrics?.measuredMovePass === "boolean" ? metrics.measuredMovePass : null;
  }
  const strategyDte = extractDteFromStrategy(candidate.strategy);
  const targets = data?.multiDte?.targets ?? [];
  const targetRow =
    targets.find((row) => row.strategy_label === candidate.strategy) ??
    (strategyDte > 0 ? targets.find((row) => row.target_dte === strategyDte) : undefined);
  const metrics = (targetRow?.metrics ?? {}) as Record<string, unknown>;
  return typeof metrics?.measuredMovePass === "boolean" ? metrics.measuredMovePass : null;
}

function toIsoDate(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function formatDteExpiry(ctx: CandidateDteContext): string {
  const target = ctx.targetDte != null ? `target ${ctx.targetDte}D` : "target -";
  const selected = ctx.selectedDte != null ? `selected ${ctx.selectedDte}D` : "selected -";
  const expiry = ctx.expiration ?? "expiry -";
  return `${target}, ${selected}, ${expiry}`;
}

function formatNumber(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatBreakeven(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
}

function asPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function numOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return fallback;
}

function safeNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCloseSecondsFromHours(hoursEt: unknown): number {
  const text = String(hoursEt ?? "");
  const match = text.match(/(\d{1,2}):(\d{2})\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})/i);
  if (!match) return 16 * 3600;
  const closeH = Number(match[3]);
  const closeM = Number(match[4]);
  if (!Number.isFinite(closeH) || !Number.isFinite(closeM)) return 16 * 3600;
  return Math.max(0, Math.min(24 * 3600 - 1, closeH * 3600 + closeM * 60));
}

function getEtSecondsSinceMidnight(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === "hour" || part.type === "minute" || part.type === "second") {
      map[part.type] = Number(part.value);
    }
  }

  const h = Number.isFinite(map.hour) ? map.hour : 0;
  const m = Number.isFinite(map.minute) ? map.minute : 0;
  const s = Number.isFinite(map.second) ? map.second : 0;
  return h * 3600 + m * 60 + s;
}

function formatSecondsHms(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatEventDate(isoDate: string): string {
  // Anchor at 12:00 UTC so ET formatting never drifts to the previous calendar day.
  const d = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "America/New_York",
  }).format(d);
}
