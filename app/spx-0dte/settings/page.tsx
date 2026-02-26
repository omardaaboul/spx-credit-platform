"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Save, TrendingUp } from "lucide-react";
import Panel from "@/app/components/spx0dte/Panel";
import SpxLayoutFrame from "@/app/components/spx0dte/SpxLayoutFrame";
import StatusBar from "@/app/components/spx0dte/StatusBar";
import { useSpxDashboardData } from "@/app/components/spx0dte/useSpxDashboardData";
import { useSpxTheme } from "@/app/components/spx0dte/useSpxTheme";

type MultiDteSettingsForm = {
  minDelta: number;
  maxDelta: number;
  minIV: number;
  maxBidAskSpread: number;
  dataFreshnessThreshold: number;
  requireGreeksValidation: boolean;
  dte2MinPremium: number;
  dte7MinPremium: number;
  dte14MinPremium: number;
  dte30MinPremium: number;
  dte45MinPremium: number;
  requireMeasuredMove: boolean;
};

const DEFAULT_FORM: MultiDteSettingsForm = {
  minDelta: 0.1,
  maxDelta: 0.4,
  minIV: 5,
  maxBidAskSpread: 0.8,
  dataFreshnessThreshold: 60,
  requireGreeksValidation: false,
  dte2MinPremium: 25,
  dte7MinPremium: 60,
  dte14MinPremium: 90,
  dte30MinPremium: 130,
  dte45MinPremium: 170,
  requireMeasuredMove: false,
};

export default function SpxSettingsPage() {
  const { theme, setTheme } = useSpxTheme();
  const { data, setData, loadError } = useSpxDashboardData({ pollMs: 10_000 });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string>("");
  const [form, setForm] = useState<MultiDteSettingsForm>(DEFAULT_FORM);

  const weekPnl = data?.sleeveSettings?.weeklyRealizedPnl ?? 0;
  const dayPnl = data?.sleeveSettings?.dailyRealizedPnl ?? 0;

  useEffect(() => {
    const s = data?.multiDteSettings;
    if (!s) return;
    setForm({
      minDelta: Number(s.minDelta ?? DEFAULT_FORM.minDelta),
      maxDelta: Number(s.maxDelta ?? DEFAULT_FORM.maxDelta),
      minIV: Number(s.minIV ?? DEFAULT_FORM.minIV),
      maxBidAskSpread: Number(s.maxBidAskSpread ?? DEFAULT_FORM.maxBidAskSpread),
      dataFreshnessThreshold: Number(s.dataFreshnessThreshold ?? DEFAULT_FORM.dataFreshnessThreshold),
      requireGreeksValidation: Boolean(s.requireGreeksValidation ?? DEFAULT_FORM.requireGreeksValidation),
      dte2MinPremium: Number(s.dteThresholds?.["2"]?.minPremium ?? DEFAULT_FORM.dte2MinPremium),
      dte7MinPremium: Number(s.dteThresholds?.["7"]?.minPremium ?? DEFAULT_FORM.dte7MinPremium),
      dte14MinPremium: Number(s.dteThresholds?.["14"]?.minPremium ?? DEFAULT_FORM.dte14MinPremium),
      dte30MinPremium: Number(s.dteThresholds?.["30"]?.minPremium ?? DEFAULT_FORM.dte30MinPremium),
      dte45MinPremium: Number(s.dteThresholds?.["45"]?.minPremium ?? DEFAULT_FORM.dte45MinPremium),
      requireMeasuredMove: Boolean(
        (data?.twoDte?.settings as Record<string, unknown> | undefined)?.require_measured_move ?? DEFAULT_FORM.requireMeasuredMove,
      ),
    });
  }, [data?.multiDteSettings, data?.twoDte?.settings]);

  const payload = useMemo(
    () => ({
      minDelta: form.minDelta,
      maxDelta: form.maxDelta,
      minIV: form.minIV,
      maxBidAskSpread: form.maxBidAskSpread,
      dataFreshnessThreshold: form.dataFreshnessThreshold,
      requireGreeksValidation: form.requireGreeksValidation,
      dteThresholds: {
        "2": { minPremium: form.dte2MinPremium },
        "7": { minPremium: form.dte7MinPremium },
        "14": { minPremium: form.dte14MinPremium },
        "30": { minPremium: form.dte30MinPremium },
        "45": { minPremium: form.dte45MinPremium },
      },
    }),
    [form],
  );

  const saveSettings = async () => {
    try {
      setSaving(true);
      setSaveMsg("");
      const res = await fetch("/api/spx0dte", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_settings", settings: { multiDte: payload } }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; multiDteSettings?: unknown };
      if (!res.ok || !body.ok) {
        setSaveMsg(body.message ?? "Failed to save settings.");
        return;
      }

      const baseTwoDte = ((data?.twoDte?.settings ?? {}) as Record<string, unknown>);
      const twoDtePayload = {
        enabled: boolOr(baseTwoDte.enabled, true),
        width: numOr(baseTwoDte.width, 10),
        short_delta_min: numOr(baseTwoDte.short_delta_min, 0.08),
        short_delta_max: numOr(baseTwoDte.short_delta_max, 0.25),
        auto_select_params: boolOr(baseTwoDte.auto_select_params, true),
        min_strike_distance: numOr(baseTwoDte.min_strike_distance, 20),
        max_strike_distance: numOr(baseTwoDte.max_strike_distance, 70),
        min_credit: numOr(baseTwoDte.min_credit, 0.45),
        max_credit: numOr(baseTwoDte.max_credit, 1.4),
        use_delta_stop: boolOr(baseTwoDte.use_delta_stop, true),
        delta_stop: numOr(baseTwoDte.delta_stop, 0.5),
        stop_multiple: numOr(baseTwoDte.stop_multiple, 3),
        profit_take_debit: numOr(baseTwoDte.profit_take_debit, 0.05),
        require_measured_move: form.requireMeasuredMove,
        allow_catalyst: boolOr(baseTwoDte.allow_catalyst, false),
      };
      const twoDteRes = await fetch("/api/spx0dte", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_2dte_settings", ...twoDtePayload }),
      });
      const twoDteBody = (await twoDteRes.json().catch(() => ({}))) as { ok?: boolean; message?: string; settings?: unknown };
      if (!twoDteRes.ok || !twoDteBody.ok) {
        setSaveMsg(twoDteBody.message ?? "Multi-DTE saved, but catalyst override failed to save.");
        return;
      }

      setSaveMsg(body.message ?? "Settings saved.");
      if (body.multiDteSettings) {
        setData((prev) => (prev ? { ...prev, multiDteSettings: body.multiDteSettings as never } : prev));
      }
    } catch {
      setSaveMsg("Failed to save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SpxLayoutFrame
      theme={theme}
      title="SPX Trade Center · Settings"
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

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--spx-text)]">Multi-DTE Trading Settings</h1>
        <button type="button" onClick={saveSettings} disabled={saving} className="btn h-9 px-3 text-xs">
          <Save className="mr-1.5 h-4 w-4" />
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
      {saveMsg && <Panel className="px-3 py-2 text-sm text-[var(--spx-muted)]">{saveMsg}</Panel>}

      <Panel className="space-y-4 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-500" />
          <div>
            <h2 className="text-lg font-semibold text-[var(--spx-text)]">Data Quality Requirements</h2>
            <p className="text-sm text-[var(--spx-muted)]">Critical parameters to keep signals reliable.</p>
          </div>
        </div>
        <NumberField label="Max Data Age (seconds)" value={form.dataFreshnessThreshold} onChange={(v) => setForm((s) => ({ ...s, dataFreshnessThreshold: v }))} />
        <NumberField label="Max Bid-Ask Spread ($)" value={form.maxBidAskSpread} step={0.05} onChange={(v) => setForm((s) => ({ ...s, maxBidAskSpread: v }))} />
        <NumberField label="Min Implied Volatility (%)" value={form.minIV} step={0.5} onChange={(v) => setForm((s) => ({ ...s, minIV: v }))} />
        <label className="flex items-center gap-2 text-sm text-[var(--spx-text)]">
          <input
            type="checkbox"
            checked={form.requireGreeksValidation}
            onChange={(e) => setForm((s) => ({ ...s, requireGreeksValidation: e.target.checked }))}
          />
          Require Greeks validation before allowing trades
        </label>
      </Panel>

      <Panel className="space-y-4 p-4">
        <div className="flex items-start gap-3">
          <TrendingUp className="mt-0.5 h-5 w-5 text-[var(--spx-accent)]" />
          <div>
            <h2 className="text-lg font-semibold text-[var(--spx-text)]">Greeks Boundaries</h2>
            <p className="text-sm text-[var(--spx-muted)]">Delta range for credit spread selection.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Min Delta (absolute)" value={form.minDelta} step={0.01} onChange={(v) => setForm((s) => ({ ...s, minDelta: v }))} />
          <NumberField label="Max Delta (absolute)" value={form.maxDelta} step={0.01} onChange={(v) => setForm((s) => ({ ...s, maxDelta: v }))} />
        </div>
      </Panel>

      <Panel className="space-y-3 p-4">
        <h2 className="text-lg font-semibold text-[var(--spx-text)]">DTE-Specific Minimum Premiums</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField label="2-DTE Min Premium ($)" value={form.dte2MinPremium} onChange={(v) => setForm((s) => ({ ...s, dte2MinPremium: v }))} />
          <NumberField label="7-DTE Min Premium ($)" value={form.dte7MinPremium} onChange={(v) => setForm((s) => ({ ...s, dte7MinPremium: v }))} />
          <NumberField label="14-DTE Min Premium ($)" value={form.dte14MinPremium} onChange={(v) => setForm((s) => ({ ...s, dte14MinPremium: v }))} />
          <NumberField label="30-DTE Min Premium ($)" value={form.dte30MinPremium} onChange={(v) => setForm((s) => ({ ...s, dte30MinPremium: v }))} />
          <NumberField label="45-DTE Min Premium ($)" value={form.dte45MinPremium} onChange={(v) => setForm((s) => ({ ...s, dte45MinPremium: v }))} />
        </div>
      </Panel>

      <Panel className="space-y-3 p-4">
        <h2 className="text-lg font-semibold text-[var(--spx-text)]">Operational Filters</h2>
        <label className="flex items-center gap-2 text-sm text-[var(--spx-text)]">
          <input
            type="checkbox"
            checked={form.requireMeasuredMove}
            onChange={(e) => setForm((s) => ({ ...s, requireMeasuredMove: e.target.checked }))}
          />
          Require measured-move completion before allowing entries
        </label>
        <p className="text-xs text-[var(--spx-muted)]">
          Turning this off reduces false “no candidate” outcomes when trend/IV criteria are valid but measured-move completion is lagging.
        </p>
      </Panel>

    </SpxLayoutFrame>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="block text-sm text-[var(--spx-muted)]">
      <span className="mb-1 block">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-3 py-2 text-[var(--spx-text)]"
      />
    </label>
  );
}

function numOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return fallback;
}
