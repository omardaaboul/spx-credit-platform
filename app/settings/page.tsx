"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DASHBOARD_RANGES,
  DashboardRange,
  loadCapitalByMonth,
  loadDashboardRange,
  loadDefaultCapital,
  loadGoalReturnPct,
  saveCapitalByMonth,
  saveDashboardRange,
  saveDefaultCapital,
  saveGoalReturnPct,
} from "@/lib/settings";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function safeParseNumber(s: string) {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function labelMonth(k: string) {
  const [y, m] = k.split("-");
  return `${MONTH_NAMES[Math.max(0, Number(m) - 1)]} ${y}`;
}

function recentMonths(count: number) {
  const now = new Date();
  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push({ key, label: labelMonth(key) });
  }
  return out;
}

export default function SettingsPage() {
  const [defaultCapital, setDefaultCapital] = useState<number>(190000);
  const [capitalByMonth, setCapitalByMonth] = useState<Record<string, number>>({});
  const [goalReturnPct, setGoalReturnPct] = useState<number>(2);
  const [defaultRange, setDefaultRange] = useState<DashboardRange>("L12M");

  const months = useMemo(() => recentMonths(6), []);

  useEffect(() => {
    const dc = loadDefaultCapital();
    const initial = dc > 0 ? dc : 190000;
    setDefaultCapital(initial);
    setCapitalByMonth(loadCapitalByMonth());
    setGoalReturnPct(loadGoalReturnPct(2));
    setDefaultRange(loadDashboardRange("L12M"));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-900">These settings are saved to this browser.</p>
      </div>

      <Card
        title="Capital settings"
        subtitle="Return % = Realized / Capital. Set default and override months where you withdrew/deposited."
      >
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="border rounded-2xl p-4 bg-zinc-50">
            <div className="text-xs text-zinc-900">Default capital ($)</div>
            <input
              value={defaultCapital ? String(defaultCapital) : ""}
              onChange={(e) => {
                const v = safeParseNumber(e.target.value);
                setDefaultCapital(v);
                saveDefaultCapital(v);
              }}
              placeholder="e.g. 190000"
              className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-700 outline-none"
              inputMode="decimal"
            />
          </div>

          <div className="sm:col-span-2 border rounded-2xl p-4 bg-zinc-50">
            <div className="text-xs text-zinc-900">Month overrides (last 6)</div>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {months.map((m) => (
                <div key={m.key} className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2">
                  <div className="text-sm text-zinc-900">{m.label}</div>
                  <input
                    value={(capitalByMonth[m.key] ?? "") as any}
                    onChange={(e) => {
                      const v = safeParseNumber(e.target.value);
                      const next = { ...capitalByMonth };
                      if (!v) delete next[m.key];
                      else next[m.key] = v;
                      setCapitalByMonth(next);
                      saveCapitalByMonth(next);
                    }}
                    placeholder={defaultCapital ? String(defaultCapital) : "capital"}
                    className="w-32 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-sm text-zinc-900 placeholder:text-zinc-700 outline-none text-right"
                    inputMode="decimal"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card title="Performance goal" subtitle="Used for Monthly performance status on the dashboard.">
        <div className="max-w-xs">
          <div className="text-xs text-zinc-900">Goal return (%)</div>
          <input
            value={Number.isFinite(goalReturnPct) ? String(goalReturnPct) : ""}
            onChange={(e) => {
              const v = safeParseNumber(e.target.value);
              setGoalReturnPct(v);
              saveGoalReturnPct(v);
            }}
            placeholder="e.g. 2"
            className="mt-2 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-700 outline-none"
            inputMode="decimal"
          />
        </div>
      </Card>

      <Card title="Dashboard defaults" subtitle="Choose the default range when you open the dashboard.">
        <div className="flex flex-wrap gap-2">
          {DASHBOARD_RANGES.map((r) => (
            <button
              key={r}
              className={`px-3 py-2 rounded-lg text-sm border ${defaultRange === r ? "bg-zinc-900 text-white border-zinc-900" : "text-zinc-900 border-zinc-200"}`}
              onClick={() => {
                setDefaultRange(r);
                saveDashboardRange(r);
              }}
            >
              {r}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-2xl p-4 bg-white shadow-sm">
      <div>
        <div className="font-medium">{title}</div>
        {subtitle ? <div className="text-xs text-zinc-900 mt-0.5">{subtitle}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}
