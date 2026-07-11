"use client";

import { useEffect, useState } from "react";

// Reads the theme the pre-paint script in layout.tsx already resolved onto <html>.
// SSR doesn't know the theme, so render a neutral label until mounted.
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage can throw (private mode, disabled storage); the in-memory
      // toggle still works for the session, so ignore.
    }
    setTheme(next);
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Toggle color theme">
      {theme === null ? "◐ Theme" : theme === "dark" ? "☀️ Light mode" : "🌙 Dark mode"}
    </button>
  );
}
