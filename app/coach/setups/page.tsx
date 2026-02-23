"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  CoachSetup,
  CoachSetupType,
  createCoachSetup,
  loadCoachSetups,
  saveCoachSetups,
} from "@/lib/coach-store";

const TYPES: CoachSetupType[] = ["credit", "debit", "long_option", "other"];
const MAX_ACTIVE = 3;

export default function SetupsPage() {
  const [setups, setSetups] = useState<CoachSetup[]>([]);
  const [error, setError] = useState<string>("");
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    setSetups(loadCoachSetups());
  }, []);

  const activeCount = setups.filter((s) => s.active).length;

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setError("missing_name");
      return;
    }
    const active = data.get("active") === "on";
    if (active && activeCount >= MAX_ACTIVE) {
      setError("active_limit");
      return;
    }

    const setup = createCoachSetup({
      name,
      type: (String(data.get("type") ?? "credit") as CoachSetupType) || "credit",
      description: String(data.get("description") ?? "").trim(),
      entryCriteria: String(data.get("entryCriteria") ?? "").trim(),
      exitCriteria: String(data.get("exitCriteria") ?? "").trim(),
      bestMarketConditions: String(data.get("bestMarketConditions") ?? "").trim(),
      active,
    });

    const next = [setup, ...setups];
    saveCoachSetups(next);
    setSetups(next);
    setError("");
    formRef.current?.reset();
  };

  const handleUpdate = (id: string) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      setError("missing_name");
      return;
    }

    const active = data.get("active") === "on";
    const activeElsewhere = setups.filter((s) => s.active && s.id !== id).length;
    if (active && activeElsewhere >= MAX_ACTIVE) {
      setError("active_limit");
      return;
    }

    const next = setups.map((setup) => {
      if (setup.id !== id) return setup;
      return {
        ...setup,
        name,
        type: (String(data.get("type") ?? setup.type) as CoachSetupType) || setup.type,
        description: String(data.get("description") ?? "").trim(),
        entryCriteria: String(data.get("entryCriteria") ?? "").trim(),
        exitCriteria: String(data.get("exitCriteria") ?? "").trim(),
        bestMarketConditions: String(data.get("bestMarketConditions") ?? "").trim(),
        active,
        updatedAt: new Date().toISOString(),
      };
    });

    saveCoachSetups(next);
    setSetups(next);
    setError("");
  };

  const handleDelete = (id: string) => {
    const next = setups.filter((setup) => setup.id !== id);
    saveCoachSetups(next);
    setSetups(next);
    setError("");
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
        <div className="text-sm font-semibold">Create setup</div>
        {error === "active_limit" ? (
          <div className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Active setup limit reached (max {MAX_ACTIVE}).
          </div>
        ) : null}
        {error === "missing_name" ? (
          <div className="mt-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            Setup name is required.
          </div>
        ) : null}
        <form ref={formRef} onSubmit={handleCreate} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input
            name="name"
            placeholder="Setup name"
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            required
          />
          <select
            name="type"
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            defaultValue="credit"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
          <textarea
            name="description"
            placeholder="Description"
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 sm:col-span-2"
            rows={2}
          />
          <textarea
            name="entryCriteria"
            placeholder="Entry criteria"
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            rows={2}
          />
          <textarea
            name="exitCriteria"
            placeholder="Exit criteria"
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
            rows={2}
          />
          <textarea
            name="bestMarketConditions"
            placeholder="Best market conditions"
            className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 sm:col-span-2"
            rows={2}
          />
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" name="active" className="h-4 w-4" /> Mark active
          </label>
          <div className="sm:col-span-2">
            <button className="rounded-xl bg-teal-500/20 px-4 py-2 text-sm text-teal-200">
              Save setup
            </button>
          </div>
        </form>
      </div>

      <div className="space-y-3">
        {setups.length ? (
          setups.map((setup) => (
            <div key={setup.id} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-100">
              <form onSubmit={handleUpdate(setup.id)} className="grid gap-3 sm:grid-cols-2">
                <input
                  name="name"
                  defaultValue={setup.name}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
                />
                <select
                  name="type"
                  defaultValue={setup.type}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace("_", " ")}
                    </option>
                  ))}
                </select>
                <textarea
                  name="description"
                  defaultValue={setup.description}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 sm:col-span-2"
                  rows={2}
                />
                <textarea
                  name="entryCriteria"
                  defaultValue={setup.entryCriteria}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
                  rows={2}
                />
                <textarea
                  name="exitCriteria"
                  defaultValue={setup.exitCriteria}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100"
                  rows={2}
                />
                <textarea
                  name="bestMarketConditions"
                  defaultValue={setup.bestMarketConditions}
                  className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 sm:col-span-2"
                  rows={2}
                />
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" name="active" className="h-4 w-4" defaultChecked={setup.active} /> Active
                </label>
                <div className="flex items-center gap-2 sm:col-span-2">
                  <button className="rounded-xl bg-slate-800 px-4 py-2 text-sm text-slate-100">Update</button>
                </div>
              </form>
              <button
                className="mt-3 text-xs text-rose-300 hover:text-rose-200"
                onClick={() => handleDelete(setup.id)}
              >
                Delete setup
              </button>
            </div>
          ))
        ) : (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-slate-300">
            No setups yet.
          </div>
        )}
      </div>
    </div>
  );
}
