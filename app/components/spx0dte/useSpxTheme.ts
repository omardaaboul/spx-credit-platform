"use client";

import { useEffect, useState } from "react";
import type { ThemeMode } from "@/app/components/spx0dte/types";

export function useSpxTheme() {
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("spx0dte-theme");
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("spx0dte-theme", theme);
  }, [theme]);

  return { theme, setTheme };
}
