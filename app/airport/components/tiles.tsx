import type { ReactNode } from "react";

export function MetricTile({
  label,
  value,
  sublabel,
  tone = "zinc",
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone?: "zinc" | "emerald" | "amber" | "rose";
}) {
  const toneStyles = {
    zinc: "border-zinc-100 text-zinc-900",
    emerald: "border-emerald-100 text-emerald-700",
    amber: "border-amber-100 text-amber-800",
    rose: "border-rose-100 text-rose-700",
  }[tone];

  return (
    <div className={`rounded-2xl border bg-white p-5 ${toneStyles}`}>
      <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">{label}</p>
      <div className="mt-3 text-3xl font-semibold text-zinc-900">{value}</div>
      {sublabel ? <p className="mt-2 text-sm text-zinc-500">{sublabel}</p> : null}
    </div>
  );
}

export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-zinc-100 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-500">{title}</h2>
      </div>
      {children}
    </section>
  );
}
