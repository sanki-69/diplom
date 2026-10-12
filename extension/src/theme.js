import { useCallback, useEffect, useState } from "react";

/* Light / dark theme.
   - index.html sets data-theme on <html> before the first paint.
   - A visitor's explicit choice is saved in localStorage ("theme").
   - Without a saved choice, the site follows the system setting live. */

const KEY = "theme";
const media = () => window.matchMedia?.("(prefers-color-scheme: dark)");

function savedTheme() {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;   // storage blocked (private mode etc.)
  }
}

function systemTheme() {
  return media()?.matches ? "dark" : "light";
}

function apply(theme, animate) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 300);
  }
  root.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0f0f0f" : "#ffffff");
}

export function useTheme() {
  const [theme, setTheme] = useState(
    () => document.documentElement.getAttribute("data-theme") || savedTheme() || systemTheme()
  );

  // Follow system changes until the visitor picks a theme themselves
  useEffect(() => {
    const mq = media();
    if (!mq) return;
    const onChange = () => {
      if (savedTheme()) return;
      const t = systemTheme();
      apply(t, true);
      setTheme(t);
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      apply(next, true);
      try { localStorage.setItem(KEY, next); } catch { /* not saved, still switches */ }
      return next;
    });
  }, []);

  return [theme, toggle];
}
