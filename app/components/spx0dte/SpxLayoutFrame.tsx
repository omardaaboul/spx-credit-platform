"use client";

import AppNav from "@/app/components/spx0dte/AppNav";
import type { ThemeMode } from "@/app/components/spx0dte/types";

type SpxLayoutFrameProps = {
  theme: ThemeMode;
  title?: string;
  subtitle?: string;
  rightActions?: React.ReactNode;
  unreadAlerts?: number;
  dataQualityWarning?: boolean;
  children: React.ReactNode;
};

export default function SpxLayoutFrame({
  theme,
  title = "SPX Trading Dashboard",
  subtitle = "Manual execution only",
  rightActions,
  unreadAlerts = 0,
  dataQualityWarning = false,
  children,
}: SpxLayoutFrameProps) {
  return (
    <div className="spx-shell relative left-1/2 min-h-screen w-screen -translate-x-1/2" data-theme={theme}>
      <header className="sticky top-0 z-40 border-b border-[var(--spx-border)] bg-[var(--spx-surface)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-5 py-3 xl:px-8">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-[var(--spx-accent)]/15 ring-1 ring-[var(--spx-accent)]/30" aria-hidden />
            <div>
              <p className="text-sm font-semibold tracking-wide text-[var(--spx-text)]">{title}</p>
              <p className="text-xs text-[var(--spx-muted)]">{subtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">{rightActions}</div>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1600px] items-start gap-4 px-5 py-4 pb-24 xl:px-8">
        <AppNav unreadAlerts={unreadAlerts} dataQualityWarning={dataQualityWarning} />
        <div className="min-w-0 flex-1 space-y-4">{children}</div>
      </main>
    </div>
  );
}
