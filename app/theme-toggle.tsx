"use client";

import { useSyncExternalStore } from "react";

// The pre-paint script in layout.tsx resolves the theme onto <html data-theme>
// before React hydrates, so <html> — not React state — is the source of truth.
// useSyncExternalStore is the sanctioned way to read that: the server snapshot
// is null (SSR doesn't know the theme, so the first render shows a neutral
// label and hydration matches), and the client snapshot is re-read after
// hydration and whenever a toggle publishes a change.
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getServerSnapshot(): null {
  return null;
}

export function ThemeToggle() {
  const theme = useSyncExternalStore<"light" | "dark" | null>(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // localStorage can throw (private mode, disabled storage); the in-memory
      // toggle still works for the session, so ignore.
    }
    for (const listener of listeners) listener();
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Toggle color theme">
      {theme === null ? "◐ Theme" : theme === "dark" ? "☀️ Light mode" : "🌙 Dark mode"}
    </button>
  );
}
