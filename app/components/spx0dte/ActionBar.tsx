"use client";

type ActionBarProps = {
  onRunPreflight: () => void;
  preflightBusy: boolean;
  onTestTelegram: () => void;
  telegramBusy: boolean;
  onToggleTheme: () => void;
  themeLabel: string;
};

export default function ActionBar({
  onRunPreflight,
  preflightBusy,
  onTestTelegram,
  telegramBusy,
  onToggleTheme,
  themeLabel,
}: ActionBarProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 hidden border-t border-[var(--spx-border)] bg-[var(--spx-surface)]/95 backdrop-blur lg:block">
      <div className="mx-auto flex max-w-[1600px] items-center justify-end gap-2 px-5 py-2.5 xl:px-8">
        <button type="button" onClick={onRunPreflight} disabled={preflightBusy} className="btn btn-muted text-xs">
          {preflightBusy ? "Checking..." : "Run Preflight"}
        </button>
        <button type="button" onClick={onTestTelegram} disabled={telegramBusy} className="btn btn-muted text-xs">
          {telegramBusy ? "Sending..." : "Test Telegram"}
        </button>
        <button type="button" onClick={onToggleTheme} className="btn btn-muted text-xs">
          {themeLabel}
        </button>
      </div>
    </div>
  );
}
