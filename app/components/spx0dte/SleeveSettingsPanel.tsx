"use client";

import { useEffect, useState } from "react";
import type { DashboardPayload } from "@/lib/spx0dte";
import Panel from "@/app/components/spx0dte/Panel";

type SleeveSettingsPanelProps = {
  data: DashboardPayload | null;
  onSave: (settings: {
    sleeveCapital: number;
    totalAccount: number;
    maxDrawdownPct: number;
    dailyRealizedPnl: number;
    weeklyRealizedPnl: number;
    dailyLock: boolean;
    weeklyLock: boolean;
  }) => Promise<void>;
  saveState: "idle" | "saving" | "ok" | "error";
};

export default function SleeveSettingsPanel({ data, onSave, saveState }: SleeveSettingsPanelProps) {
  const [form, setForm] = useState({
    sleeveCapital: 10_000,
    totalAccount: 160_000,
    maxDrawdownPct: 15,
    dailyRealizedPnl: 0,
    weeklyRealizedPnl: 0,
    dailyLock: false,
    weeklyLock: false,
  });

  // Sync local form when persisted sleeve settings change.
   
  useEffect(() => {
    if (!data?.sleeveSettings) return;
    setForm(data.sleeveSettings);
  }, [data?.sleeveSettings]);
   

  const limits = data?.sleeveLimits;

  return (
    <Panel as="section" className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--spx-text)]">Sleeve Settings</h2>
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={saveState === "saving"}
          className="btn text-sm"
        >
          {saveState === "saving" ? "Saving..." : "Save"}
        </button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <NumberField label="Sleeve Capital ($)" value={form.sleeveCapital} onChange={(v) => setForm((s) => ({ ...s, sleeveCapital: v }))} />
        <NumberField label="Total Account ($)" value={form.totalAccount} onChange={(v) => setForm((s) => ({ ...s, totalAccount: v }))} />
        <NumberField label="Max Drawdown (%)" value={form.maxDrawdownPct} onChange={(v) => setForm((s) => ({ ...s, maxDrawdownPct: v }))} />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <NumberField label="Daily Realized P/L ($)" value={form.dailyRealizedPnl} onChange={(v) => setForm((s) => ({ ...s, dailyRealizedPnl: v }))} />
        <NumberField label="Weekly Realized P/L ($)" value={form.weeklyRealizedPnl} onChange={(v) => setForm((s) => ({ ...s, weeklyRealizedPnl: v }))} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Toggle label="Daily Lock" checked={form.dailyLock} onChange={(v) => setForm((s) => ({ ...s, dailyLock: v }))} />
        <Toggle label="Weekly Lock" checked={form.weeklyLock} onChange={(v) => setForm((s) => ({ ...s, weeklyLock: v }))} />
      </div>

      <div className="mt-4 grid gap-2 rounded-xl border border-[var(--spx-border)] bg-[var(--spx-panel)] p-3 text-sm text-[var(--spx-muted)] md:grid-cols-2 lg:grid-cols-4">
        <div>Per-Trade Cap: ${Math.round(limits?.maxRiskPerTrade ?? form.sleeveCapital * 0.03)}</div>
        <div>Max Open Risk: ${Math.round(limits?.maxOpenRisk ?? form.sleeveCapital * 0.06)}</div>
        <div>Daily Stop: ${Math.round(limits?.maxDailyLoss ?? form.sleeveCapital * 0.04)}</div>
        <div>Weekly Stop: ${Math.round(limits?.maxWeeklyLoss ?? form.sleeveCapital * 0.08)}</div>
      </div>

      {saveState === "ok" && <p className="mt-2 text-sm text-emerald-400">Saved. Risk engine will apply on next scan.</p>}
      {saveState === "error" && <p className="mt-2 text-sm text-rose-400">Unable to save settings.</p>}
    </Panel>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="text-sm text-[var(--spx-muted)]">
      <div className="mb-1">{label}</div>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-3 py-2 text-[var(--spx-text)] outline-none focus:border-[var(--spx-accent)]"
      />
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-[var(--spx-text)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
