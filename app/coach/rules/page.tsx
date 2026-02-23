"use client";

import { useEffect, useState } from "react";
import { DEFAULT_COACH_RULES, loadCoachRules, saveCoachRules } from "@/lib/coach-store";

function safeParseNumber(s: string, fallback = 0) {
  const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

export default function RulesPage() {
  const [rules, setRules] = useState(DEFAULT_COACH_RULES);

  useEffect(() => {
    setRules(loadCoachRules());
  }, []);

  const updateRules = (next: typeof rules) => {
    setRules(next);
    saveCoachRules(next);
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
        <div className="text-sm font-semibold">Risk & Process Rules</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <input
            value={rules.name}
            onChange={(e) => updateRules({ ...rules, name: e.target.value })}
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              step="0.1"
              value={rules.riskPerTradePercentDefault}
              onChange={(e) =>
                updateRules({
                  ...rules,
                  riskPerTradePercentDefault: safeParseNumber(e.target.value, rules.riskPerTradePercentDefault),
                })
              }
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
              placeholder="Risk %"
            />
            <input
              type="number"
              step="0.1"
              value={rules.maxDailyLossPercent}
              onChange={(e) =>
                updateRules({
                  ...rules,
                  maxDailyLossPercent: safeParseNumber(e.target.value, rules.maxDailyLossPercent),
                })
              }
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
              placeholder="Max daily loss %"
            />
          </div>
          <input
            type="number"
            value={rules.maxTradesPerDay}
            onChange={(e) =>
              updateRules({
                ...rules,
                maxTradesPerDay: Math.max(1, Math.round(safeParseNumber(e.target.value, rules.maxTradesPerDay))),
              })
            }
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            placeholder="Max trades per day"
          />
          <div className="flex flex-col gap-2 text-xs text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rules.requireChecklistBeforeEntry}
                onChange={(e) => updateRules({ ...rules, requireChecklistBeforeEntry: e.target.checked })}
              />
              Require checklist before entry
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rules.requireMaxLossDefined}
                onChange={(e) => updateRules({ ...rules, requireMaxLossDefined: e.target.checked })}
              />
              Require max loss defined before entry
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
