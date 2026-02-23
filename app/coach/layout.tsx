export default function CoachLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full">
      <div className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-slate-100">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Options Trading Coach</div>
            <div className="text-xs text-slate-400">Plan, execute, review, improve</div>
          </div>
          <nav className="flex flex-wrap gap-2 text-xs text-slate-200">
            <a className="rounded-lg border border-slate-800 px-3 py-1 hover:bg-slate-800" href="/coach/dashboard">
              Dashboard
            </a>
            <a className="rounded-lg border border-slate-800 px-3 py-1 hover:bg-slate-800" href="/coach/setups">
              Setups
            </a>
            <a className="rounded-lg border border-slate-800 px-3 py-1 hover:bg-slate-800" href="/coach/trades/new">
              New Trade
            </a>
            <a className="rounded-lg border border-slate-800 px-3 py-1 hover:bg-slate-800" href="/coach/trades">
              Trades
            </a>
            <a className="rounded-lg border border-slate-800 px-3 py-1 hover:bg-slate-800" href="/coach/weekly-review">
              Weekly Review
            </a>
            <a className="rounded-lg border border-slate-800 px-3 py-1 hover:bg-slate-800" href="/coach/rules">
              Rules
            </a>
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}
