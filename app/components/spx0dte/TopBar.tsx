"use client";

import type { ThemeMode } from "./types";

type TopBarProps = {
  timeParis: string;
  timeEt: string;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onTelegramTest: () => Promise<void> | void;
  telegramTestState?: "idle" | "sending" | "ok" | "error";
};

export default function TopBar({
  timeParis,
  timeEt,
  theme,
  onToggleTheme,
  onTelegramTest,
  telegramTestState = "idle",
}: TopBarProps) {
  const buttonLabel =
    telegramTestState === "sending"
      ? "Sending..."
      : telegramTestState === "ok"
        ? "Sent"
        : telegramTestState === "error"
          ? "Retry"
          : "Telegram Test";

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--spx-border)] bg-[var(--spx-surface)]/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-5 xl:px-8">
        <div className="flex items-center gap-4">
          <div className="h-9 w-9 rounded-lg bg-[var(--spx-accent)]/15 ring-1 ring-[var(--spx-accent)]/30" aria-hidden />
          <div>
            <div className="text-sm font-semibold tracking-wide text-[var(--spx-text)]">SPX Trading Dashboard</div>
            <div className="text-xs text-[var(--spx-muted)]">Manual execution only</div>
          </div>
        </div>

        <div className="hidden md:block" aria-hidden />

        <div className="flex items-center gap-4">
          <div className="hidden text-right lg:block">
            <div className="text-sm text-[var(--spx-text)]">Paris {timeParis}</div>
            <div className="text-xs text-[var(--spx-muted)]">ET {timeEt}</div>
          </div>
          <button
            type="button"
            onClick={onTelegramTest}
            disabled={telegramTestState === "sending"}
            className="btn h-9 px-3 text-sm"
            aria-label="Send Telegram test message"
          >
            {buttonLabel}
          </button>
          <button
            type="button"
            onClick={onToggleTheme}
            className="btn h-9 px-3 text-sm"
            aria-label="Toggle light and dark mode"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--spx-accent)]/15 text-sm font-semibold text-[var(--spx-accent)] ring-1 ring-[var(--spx-accent)]/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--spx-accent)]"
            aria-label="User profile"
          >
            OD
          </button>
        </div>
      </div>
    </header>
  );
}
