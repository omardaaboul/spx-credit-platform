"use client";

import { useEffect, useMemo, useState } from "react";

type SectionItem = { id: string; label: string };

type SectionNavProps = {
  sections: SectionItem[];
};

export default function SectionNav({ sections }: SectionNavProps) {
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? "");

  const sectionIds = useMemo(() => sections.map((section) => section.id), [sections]);

  useEffect(() => {
    if (sectionIds.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length === 0) return;
        setActiveId(visible[0].target.id);
      },
      {
        root: null,
        rootMargin: "-22% 0px -55% 0px",
        threshold: [0.15, 0.35, 0.6],
      },
    );

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sectionIds]);

  return (
    <>
      <nav className="sticky top-24 hidden w-[170px] shrink-0 lg:block" aria-label="Section navigation">
        <ul className="space-y-0.5 border-l border-[var(--spx-border)] pl-2">
          {sections.map((section) => {
            const active = activeId === section.id;
            return (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={`block rounded-md px-2 py-1.5 text-sm transition ${
                    active
                      ? "bg-[var(--spx-accent)]/10 text-[var(--spx-accent)]"
                      : "text-[var(--spx-muted)] hover:text-[var(--spx-text)]"
                  }`}
                >
                  {section.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--spx-border)] bg-[var(--spx-surface)]/95 px-2 py-1.5 backdrop-blur lg:hidden" aria-label="Section navigation">
        {sections.map((section) => {
          const active = activeId === section.id;
          const icon = mobileIcon(section.id);
          return (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={`inline-flex min-w-[52px] flex-1 items-center justify-center rounded-md border px-2 py-1.5 text-xs ${
                active
                  ? "border-[var(--spx-accent)] bg-[var(--spx-accent)]/10 text-[var(--spx-accent)]"
                  : "border-[var(--spx-border)] bg-[var(--spx-panel)] text-[var(--spx-muted)]"
              }`}
              aria-label={section.label}
              title={section.label}
            >
              {icon}
            </a>
          );
        })}
      </nav>
    </>
  );
}

function mobileIcon(id: string): string {
  if (id === "overview") return "◉";
  if (id === "readiness") return "✓";
  if (id === "strategies") return "⚡";
  if (id === "markets") return "∿";
  if (id === "trades") return "▣";
  if (id === "review") return "◎";
  return "•";
}
