"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, BarChart3, Bell, Home, Settings, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const ITEMS: NavItem[] = [
  { href: "/spx-0dte", label: "Home", icon: Home },
  { href: "/spx-0dte/alerts", label: "Alerts", icon: Bell },
  { href: "/spx-0dte/trades", label: "Trades", icon: TrendingUp },
  { href: "/spx-0dte/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/spx-0dte/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/spx-0dte") {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

type AppNavProps = {
  unreadAlerts?: number;
  dataQualityWarning?: boolean;
};

export default function AppNav({ unreadAlerts = 0, dataQualityWarning = false }: AppNavProps) {
  const pathname = usePathname();

  return (
    <>
      <nav className="sticky top-24 hidden w-20 shrink-0 lg:block" aria-label="SPX navigation">
        <div className="flex flex-col items-center gap-3 border-r border-[var(--spx-border)] py-2">
          {dataQualityWarning && (
            <div className="relative flex h-11 w-11 items-center justify-center rounded-xl border border-amber-500/40 bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500" />
            </div>
          )}
          {ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition ${
                  active
                    ? "bg-[var(--spx-accent)]/10 text-[var(--spx-accent)]"
                    : "text-[var(--spx-muted)] hover:bg-[var(--spx-panel)] hover:text-[var(--spx-text)]"
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="mt-0.5 text-[10px] font-medium leading-none">{item.label}</span>
                {item.label === "Alerts" && unreadAlerts > 0 && (
                  <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-semibold text-white">
                    {unreadAlerts > 9 ? "9+" : unreadAlerts}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--spx-border)] bg-[var(--spx-surface)]/95 px-2 py-1.5 backdrop-blur lg:hidden" aria-label="SPX navigation">
        <div className="flex items-center gap-1">
          {ITEMS.map((item) => {
            const Icon = item.icon;
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`inline-flex min-w-0 flex-1 flex-col items-center justify-center rounded-md border px-1 py-1 text-[11px] ${
                  active
                    ? "border-[var(--spx-accent)] bg-[var(--spx-accent)]/10 text-[var(--spx-accent)]"
                    : "border-[var(--spx-border)] bg-[var(--spx-panel)] text-[var(--spx-muted)]"
                }`}
                aria-label={item.label}
              >
                <Icon className="h-5 w-5" />
                <span className="mt-0.5 leading-none">{item.label}</span>
                {item.label === "Alerts" && unreadAlerts > 0 && (
                  <span className="absolute right-1.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-rose-500 px-0.5 text-[8px] font-semibold text-white">
                    {unreadAlerts > 9 ? "9+" : unreadAlerts}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
