"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";

export default function AppHeader() {
  const pathname = usePathname();
  if (pathname?.startsWith("/airport") || pathname?.startsWith("/spx-0dte")) {
    return null;
  }

  const links = [
    { href: "/", label: "Dashboard" },
    { href: "/trades", label: "Trades" },
    { href: "/import", label: "Import" },
    { href: "/coach", label: "Coach" },
    { href: "/cashflows", label: "Cashflows" },
    { href: "/settings", label: "Settings" },
    { href: "/spx-0dte", label: "SPX 0DTE" },
    { href: "/airport", label: "Airport" },
  ];

  return (
    <header className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="text-sm font-semibold tracking-tight">Options Log</div>
        <nav className="flex gap-3 text-sm text-zinc-600">
          {links.map((link) => (
            <Link key={link.href} className="hover:text-zinc-900" href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
