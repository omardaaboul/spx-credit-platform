"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardPayload } from "@/lib/spx0dte";
import { computePollingInterval, mergeMmcEvents, toPollingState, type MmcEvent } from "@/app/components/spx0dte/adaptivePolling";

const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 120_000;
const DEBUG_UI = process.env.NEXT_PUBLIC_SPX0DTE_DEBUG === "true";

type UseSpxDashboardDataOptions = {
  pollMs?: number;
  adaptivePolling?: boolean;
};

export function useSpxDashboardData(options: UseSpxDashboardDataOptions = {}) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const adaptivePolling = options.adaptivePolling ?? true;
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSuccessAtMs, setLastSuccessAtMs] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/spx0dte", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(`API unavailable (${res.status})`);
        if (DEBUG_UI) {
          console.warn("[spx0dte-ui] api_non_ok", { status: res.status, url: "/api/spx0dte" });
        }
        return null;
      }
      const payload = (await res.json()) as DashboardPayload;
      setData(payload);
      setLoadError(null);
      setLastSuccessAtMs(Date.now());
      return payload;
    } catch {
      setLoadError("API request failed");
      if (DEBUG_UI) {
        console.warn("[spx0dte-ui] api_fetch_failed", { url: "/api/spx0dte" });
      }
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timeoutId: number | null = null;
    let mmcEvents: MmcEvent[] = [];
    let prevCandidates: DashboardPayload["candidates"] = [];
    let currentPollMs = Math.max(MIN_POLL_MS, pollMs);

    const load = async (): Promise<void> => {
      const payload = await reload();
      if (!active) return;

      if (payload != null && adaptivePolling) {
        mmcEvents = mergeMmcEvents({
          previousEvents: mmcEvents,
          previousCandidates: prevCandidates,
          currentCandidates: payload.candidates ?? [],
        });
        prevCandidates = payload.candidates ?? [];

        const pollingState = toPollingState(payload);
        const intervalSec = computePollingInterval({ ...pollingState, mmcEvents });
        currentPollMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, intervalSec * 1000));
      } else if (!adaptivePolling) {
        currentPollMs = Math.max(MIN_POLL_MS, pollMs);
      }

      if (!active) return;
      timeoutId = window.setTimeout(load, currentPollMs);
    };

    load();
    return () => {
      active = false;
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [reload, pollMs, adaptivePolling]);

  return { data, setData, loadError, reload, lastSuccessAtMs };
}
