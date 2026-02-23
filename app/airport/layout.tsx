import type { ReactNode } from "react";

export const metadata = {
  title: "Airport Training Readiness (V0)",
  description: "Minimal readiness dashboard for airport training compliance.",
};

export default function AirportLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-400">Airport</p>
          <h1 className="text-2xl font-semibold text-zinc-900">Training Readiness (V0)</h1>
        </div>
        <nav className="flex flex-wrap gap-3 text-sm text-zinc-500">
          <a className="rounded-full border border-transparent px-3 py-1 hover:border-zinc-200 hover:text-zinc-900" href="/airport">
            Dashboard
          </a>
          <a className="rounded-full border border-transparent px-3 py-1 hover:border-zinc-200 hover:text-zinc-900" href="/airport/people">
            People
          </a>
          <a className="rounded-full border border-transparent px-3 py-1 hover:border-zinc-200 hover:text-zinc-900" href="/airport/matrix">
            Training Matrix
          </a>
        </nav>
      </header>
      {children}
    </div>
  );
}
