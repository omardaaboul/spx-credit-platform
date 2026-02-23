"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_COACH_RULES,
  addCoachPlan,
  loadCoachRules,
  loadCoachSetups,
  type CoachDirection,
  type CoachIVContext,
  type CoachPlanStatus,
  type CoachSetup,
} from "@/lib/coach-store";

const MAX_RISK_PERCENT = 2;

export default function TradeWizard() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [setups, setSetups] = useState<CoachSetup[]>([]);
  const [rules, setRules] = useState(DEFAULT_COACH_RULES);
  const [form, setForm] = useState({
    setupId: "",
    symbol: "",
    direction: "bullish" as CoachDirection,
    strategyDetails: "",
    plannedEntryDate: new Date().toISOString().slice(0, 10),
    accountValueAtEntry: 100000,
    riskPercent: DEFAULT_COACH_RULES.riskPerTradePercentDefault,
    maxRiskAmount: 0,
    positionSizeContracts: 1,
    thesis: "",
    catalystsOrContext: "",
    ivContext: "unknown" as CoachIVContext,
    invalidationLevel: "",
    takeProfitPlan: "",
    stopLossPlan: "",
    timeStopPlan: "",
    confidenceScore: 3,
    checklist: {
      maxLossKnown: false,
      exitPlan: false,
      matchesSetup: false,
      emotionalState: false,
    },
  });

  useEffect(() => {
    const loadedSetups = loadCoachSetups();
    const loadedRules = loadCoachRules();
    setSetups(loadedSetups);
    setRules(loadedRules);
    setForm((s) => ({
      ...s,
      setupId: loadedSetups[0]?.id ?? s.setupId,
      riskPercent: loadedRules.riskPerTradePercentDefault,
    }));
  }, []);

  const computedRiskAmount = useMemo(() => {
    if (!form.accountValueAtEntry || !form.riskPercent) return 0;
    return Math.round(form.accountValueAtEntry * (form.riskPercent / 100));
  }, [form.accountValueAtEntry, form.riskPercent]);

  const checklistCompleted =
    form.checklist.maxLossKnown &&
    form.checklist.exitPlan &&
    form.checklist.matchesSetup &&
    form.checklist.emotionalState;

  const planComplete =
    form.symbol.trim() &&
    form.strategyDetails.trim() &&
    form.thesis.trim() &&
    form.catalystsOrContext.trim() &&
    form.invalidationLevel.trim() &&
    form.takeProfitPlan.trim() &&
    form.stopLossPlan.trim() &&
    form.timeStopPlan.trim();

  const canEnter =
    planComplete &&
    (!rules.requireChecklistBeforeEntry || checklistCompleted) &&
    (!rules.requireMaxLossDefined || computedRiskAmount > 0) &&
    form.riskPercent <= MAX_RISK_PERCENT;

  const handleSubmit = (status: CoachPlanStatus) => {
    startTransition(async () => {
      addCoachPlan({
        setupId: form.setupId || null,
        symbol: form.symbol.trim().toUpperCase(),
        direction: form.direction,
        strategyDetails: form.strategyDetails.trim(),
        plannedEntryDate: form.plannedEntryDate,
        enteredAt: status === "entered" ? new Date().toISOString().slice(0, 10) : null,
        closedAt: null,
        status,
        accountValueAtEntry: form.accountValueAtEntry || null,
        maxRiskAmount: computedRiskAmount,
        maxRiskPercent: form.riskPercent,
        positionSizeContracts: form.positionSizeContracts || null,
        thesis: form.thesis.trim(),
        catalystsOrContext: form.catalystsOrContext.trim(),
        ivContext: form.ivContext,
        invalidationLevel: form.invalidationLevel.trim(),
        takeProfitPlan: form.takeProfitPlan.trim(),
        stopLossPlan: form.stopLossPlan.trim(),
        timeStopPlan: form.timeStopPlan.trim(),
        confidenceScore: form.confidenceScore,
        checklistCompleted,
        exitReason: null,
        pnlAmount: null,
        pnlPercent: null,
        notes: null,
        emotionalState: null,
        followedPlan: null,
        mistakes: null,
        lessons: null,
      });
      router.push("/coach/trades?tab=plans");
    });
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
        <div className="text-sm font-semibold">Trade Plan Wizard</div>
        <div className="mt-1 text-xs text-slate-400">Step {step} of 4</div>
      </div>

      {step === 1 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Step 1: Setup + trade details</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <select
              value={form.setupId}
              onChange={(e) => setForm((s) => ({ ...s, setupId: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            >
              {setups.length ? (
                setups.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))
              ) : (
                <option value="">No setups yet</option>
              )}
            </select>
            <input
              placeholder="Symbol"
              value={form.symbol}
              onChange={(e) => setForm((s) => ({ ...s, symbol: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <select
              value={form.direction}
              onChange={(e) => setForm((s) => ({ ...s, direction: e.target.value as CoachDirection }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            >
              <option value="bullish">Bullish</option>
              <option value="bearish">Bearish</option>
              <option value="neutral">Neutral</option>
            </select>
            <input
              type="date"
              value={form.plannedEntryDate}
              onChange={(e) => setForm((s) => ({ ...s, plannedEntryDate: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <textarea
              placeholder="Strategy details (strikes, expiry, legs)"
              value={form.strategyDetails}
              onChange={(e) => setForm((s) => ({ ...s, strategyDetails: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 sm:col-span-2"
              rows={2}
            />
            {!setups.length ? (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 sm:col-span-2">
                Add a setup in the Setups tab to classify your trades.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Step 2: Risk + size</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <input
              type="number"
              placeholder="Account value"
              value={form.accountValueAtEntry}
              onChange={(e) => setForm((s) => ({ ...s, accountValueAtEntry: Number(e.target.value) }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <input
              type="number"
              step="0.1"
              placeholder="Risk %"
              value={form.riskPercent}
              onChange={(e) => setForm((s) => ({ ...s, riskPercent: Number(e.target.value) }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <input
              type="number"
              placeholder="Position size (contracts)"
              value={form.positionSizeContracts}
              onChange={(e) => setForm((s) => ({ ...s, positionSizeContracts: Number(e.target.value) }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100">
              Max risk amount: <span className="text-teal-300">${computedRiskAmount}</span>
            </div>
            {form.riskPercent > MAX_RISK_PERCENT ? (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 sm:col-span-2">
                Risk percent cannot exceed {MAX_RISK_PERCENT}%.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Step 3: Plan</div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <textarea
              placeholder="Thesis"
              value={form.thesis}
              onChange={(e) => setForm((s) => ({ ...s, thesis: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 sm:col-span-2"
              rows={2}
            />
            <textarea
              placeholder="Catalysts or context"
              value={form.catalystsOrContext}
              onChange={(e) => setForm((s) => ({ ...s, catalystsOrContext: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 sm:col-span-2"
              rows={2}
            />
            <select
              value={form.ivContext}
              onChange={(e) => setForm((s) => ({ ...s, ivContext: e.target.value as CoachIVContext }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            >
              <option value="low">Low IV</option>
              <option value="medium">Medium IV</option>
              <option value="high">High IV</option>
              <option value="unknown">Unknown</option>
            </select>
            <input
              placeholder="Invalidation level"
              value={form.invalidationLevel}
              onChange={(e) => setForm((s) => ({ ...s, invalidationLevel: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <input
              placeholder="Take profit plan"
              value={form.takeProfitPlan}
              onChange={(e) => setForm((s) => ({ ...s, takeProfitPlan: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <input
              placeholder="Stop loss plan"
              value={form.stopLossPlan}
              onChange={(e) => setForm((s) => ({ ...s, stopLossPlan: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <input
              placeholder="Time stop plan"
              value={form.timeStopPlan}
              onChange={(e) => setForm((s) => ({ ...s, timeStopPlan: e.target.value }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
            <input
              type="number"
              min={1}
              max={5}
              value={form.confidenceScore}
              onChange={(e) => setForm((s) => ({ ...s, confidenceScore: Number(e.target.value) }))}
              className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            />
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
          <div className="text-sm font-semibold">Step 4: Checklist</div>
          <div className="mt-3 space-y-2 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.checklist.maxLossKnown}
                onChange={(e) => setForm((s) => ({ ...s, checklist: { ...s.checklist, maxLossKnown: e.target.checked } }))}
              />
              I know the max loss.
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.checklist.exitPlan}
                onChange={(e) => setForm((s) => ({ ...s, checklist: { ...s.checklist, exitPlan: e.target.checked } }))}
              />
              I know my exit plan.
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.checklist.matchesSetup}
                onChange={(e) => setForm((s) => ({ ...s, checklist: { ...s.checklist, matchesSetup: e.target.checked } }))}
              />
              This matches one of my setups.
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.checklist.emotionalState}
                onChange={(e) => setForm((s) => ({ ...s, checklist: { ...s.checklist, emotionalState: e.target.checked } }))}
              />
              I am not trading emotionally.
            </label>
            {rules.requireChecklistBeforeEntry && !checklistCompleted ? (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                Checklist must be completed before entering.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-xl border border-slate-800 px-3 py-2 text-sm text-slate-200 disabled:opacity-40"
          onClick={() => setStep((s) => Math.max(1, s - 1))}
          disabled={step === 1 || isPending}
        >
          Back
        </button>
        <button
          className="rounded-xl border border-slate-800 px-3 py-2 text-sm text-slate-200 disabled:opacity-40"
          onClick={() => setStep((s) => Math.min(4, s + 1))}
          disabled={step === 4 || isPending}
        >
          Next
        </button>
        <button
          className="rounded-xl bg-slate-800 px-3 py-2 text-sm text-slate-200 disabled:opacity-40"
          onClick={() => handleSubmit("planned")}
          disabled={!planComplete || isPending}
        >
          Save plan
        </button>
        <button
          className="rounded-xl bg-teal-500/20 px-3 py-2 text-sm text-teal-200 disabled:opacity-40"
          onClick={() => handleSubmit("entered")}
          disabled={!canEnter || isPending}
        >
          Save + Enter
        </button>
      </div>
    </div>
  );
}
