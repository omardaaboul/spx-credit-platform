import { useEffect, useMemo, useState } from "react";
import type { DiagnosticsSection } from "@/lib/readiness";
import type { ChecklistItem } from "@/lib/spx0dte";
import { readinessBadgeClass, readinessIcon, readinessLabel } from "@/app/components/spx0dte/readiness/stateTone";

type DiagnosticsDrawerProps = {
  open: boolean;
  onClose: () => void;
  sections: DiagnosticsSection[];
  initialSectionKey?: string | null;
};

export default function DiagnosticsDrawer({
  open,
  onClose,
  sections,
  initialSectionKey,
}: DiagnosticsDrawerProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    const next: Record<string, boolean> = { global: true, regime: true };
    if (initialSectionKey) next[initialSectionKey] = true;
    setExpanded(next);
    setQuery("");
  }, [open, initialSectionKey]);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredSections = useMemo(() => {
    if (!normalizedQuery) return sections;
    return sections
      .map((section) => {
        const sectionMatch = `${section.title} ${section.strategy ?? ""}`.toLowerCase().includes(normalizedQuery);
        if (sectionMatch) return section;
        const rows = section.rows.filter((row) => matchesRow(row, normalizedQuery));
        return { ...section, rows };
      })
      .filter((section) => section.rows.length > 0);
  }, [sections, normalizedQuery]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/35" aria-label="Close diagnostics" />
      <aside className="absolute right-0 top-0 h-full w-full max-w-3xl border-l border-[var(--spx-border)] bg-[var(--spx-bg)] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--spx-text)]">Diagnostics</h2>
            <p className="text-xs text-[var(--spx-muted)]">Full checklist tree with verbose reasons and thresholds.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn text-xs"
          >
            Close
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--spx-border)] bg-[var(--spx-surface)] p-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search criteria, reason, data key..."
            className="min-w-[220px] flex-1 rounded-md border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2 py-1 text-sm text-[var(--spx-text)]"
          />
          <button
            type="button"
            onClick={() => {
              const next: Record<string, boolean> = {};
              for (const section of filteredSections) next[section.key] = true;
              setExpanded(next);
            }}
            className="btn text-xs"
          >
            Expand all
          </button>
          <button
            type="button"
            onClick={() => setExpanded({})}
            className="btn text-xs"
          >
            Collapse all
          </button>
        </div>

        <div className="h-[calc(100%-132px)] space-y-3 overflow-auto pr-1">
          {filteredSections.map((section) => {
            const openSection = expanded[section.key] ?? false;
            const required = section.rows.filter((row) => row.required !== false).length;
            const pass = section.rows.filter((row) => (row.required ?? true) && row.status === "pass").length;
            return (
              <article key={section.key} className="rounded-xl border border-[var(--spx-border)] bg-[var(--spx-surface)] p-3">
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => ({ ...prev, [section.key]: !openSection }))}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <span className="text-sm font-semibold text-[var(--spx-text)]">{section.title}</span>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`rounded-full border px-2 py-0.5 ${readinessBadgeClass(section.state)}`}>
                      {readinessLabel(section.state)}
                    </span>
                    <span className="text-[var(--spx-muted)]">
                      {pass}/{required}
                    </span>
                    <span className="text-[var(--spx-muted)]">{openSection ? "Hide" : "Show"}</span>
                  </div>
                </button>

                {openSection && (
                  <ul className="mt-3 space-y-2">
                    {section.rows.map((row, idx) => (
                      <li
                        key={`${section.key}-${idx}`}
                        id={`diag-${section.key}-${idx}`}
                        className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-panel)] px-2.5 py-2"
                      >
                        <div className="flex items-start gap-2">
                          <span className="mt-[1px] text-xs font-bold" aria-hidden>
                            {readinessIcon(row.status === "na" ? "na" : row.status)}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm text-[var(--spx-text)]">{row.name}</p>
                            {row.detail && <p className="mt-1 text-xs text-[var(--spx-muted)]">{row.detail}</p>}
                            {row.reason && row.reason !== row.detail && (
                              <p className="mt-1 text-xs text-[var(--spx-muted)]">Reason: {row.reason}</p>
                            )}
                            {row.requires && row.requires.length > 0 && (
                              <p className="mt-1 text-[11px] text-[var(--spx-muted)]">requires: {row.requires.join(", ")}</p>
                            )}
                            {row.dataAgeMs && Object.keys(row.dataAgeMs).length > 0 && (
                              <p className="mt-1 text-[11px] text-[var(--spx-muted)]">
                                data age: {Object.entries(row.dataAgeMs)
                                  .map(([k, v]) => `${k}=${v == null ? "-" : `${Math.round(v)}ms`}`)
                                  .join(" · ")}
                              </p>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}

          {filteredSections.length === 0 && (
            <div className="rounded-lg border border-[var(--spx-border)] bg-[var(--spx-surface)] px-3 py-2 text-sm text-[var(--spx-muted)]">
              No diagnostics rows match your search.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function matchesRow(row: ChecklistItem, query: string): boolean {
  const text = [
    row.name,
    row.detail ?? "",
    row.reason ?? "",
    row.requires?.join(" ") ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(query);
}
