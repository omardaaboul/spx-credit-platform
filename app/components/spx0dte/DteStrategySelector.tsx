"use client";

import { Calendar } from "lucide-react";

export type DteOption = "2-DTE" | "7-DTE" | "14-DTE" | "30-DTE" | "45-DTE" | "ALL";

type DteStrategySelectorProps = {
  selected: DteOption;
  onChange: (dte: DteOption) => void;
  availableDtes: DteOption[];
};

export default function DteStrategySelector({ selected, onChange, availableDtes }: DteStrategySelectorProps) {
  const options: Array<{ value: DteOption; label: string; color: string }> = [
    { value: "ALL", label: "All DTEs", color: "text-gray-600 dark:text-gray-400" },
    { value: "2-DTE", label: "2 DTE", color: "text-rose-500" },
    { value: "7-DTE", label: "7 DTE", color: "text-orange-500" },
    { value: "14-DTE", label: "14 DTE", color: "text-amber-500" },
    { value: "30-DTE", label: "30 DTE", color: "text-blue-500" },
    { value: "45-DTE", label: "45 DTE", color: "text-purple-500" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Calendar className="h-4 w-4 text-[var(--spx-muted)]" />
      <span className="text-sm text-[var(--spx-muted)]">DTE:</span>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const isAvailable = availableDtes.includes(option.value);
          const isSelected = selected === option.value;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              title={isAvailable ? undefined : "No nearby expiration currently available for this target."}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                isSelected
                  ? "bg-[var(--spx-accent)] text-white"
                  : isAvailable
                    ? `border border-[var(--spx-border)] bg-[var(--spx-panel)] ${option.color} hover:bg-[var(--spx-panel)]/70`
                    : "border border-[var(--spx-border)] bg-[var(--spx-panel)] text-gray-400 dark:text-gray-600"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
