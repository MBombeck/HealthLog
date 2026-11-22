"use client";

/**
 * The app's theme: the stored choice (light, dark, or follow the system) and
 * the theme it resolves to on this device (`resolveTheme` semantics, through
 * `parseThemeChoice` and the device's colour scheme), kept as external stores
 * so every reader agrees on the first paint. Its own module, apart from the
 * root providers, so a control that only reads or sets the theme (the avatar
 * menus, the Display card) does not pull the query client in with it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  applyThemeColor,
  parseThemeChoice,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemeChoice,
} from "@/lib/pwa/theme-color";

// ── Theme Context ────────────────────────────────────

type Theme = ThemeChoice;

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "dark",
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

function getSystemTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(resolved: "dark" | "light") {
  document.documentElement.classList.remove("dark", "light");
  document.documentElement.classList.add(resolved);
  // The browser bar and an installed app's status bar follow the theme the
  // page painted, not the operating system's scheme (see theme-color.ts).
  applyThemeColor(document, resolved);
}

// ── Theme as an external store ───────────────────────
//
// The stored preference lives in localStorage, and the OS preference in
// matchMedia — both browser-only values that must NOT be read in a `useState`
// initializer (server renders "dark", a client with a stored "light"/"system"
// initializes differently → the React #418 hydration seam this repo already
// hit with the sidebar). `useSyncExternalStore` is the sanctioned fix: it reads
// the value with an SSR-stable server snapshot ("system", resolved as "dark"
// because the server cannot see the device) and reconciles to the
// real value after hydration without a setState-in-effect. The nonce-bound
// inline script in layout.tsx stamps the correct class pre-paint, so there is
// no visual FOUC while React reconciles.

const themeListeners = new Set<() => void>();

function notifyThemeListeners() {
  for (const cb of themeListeners) cb();
}

function subscribeStoredTheme(onChange: () => void): () => void {
  themeListeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    themeListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getStoredThemeSnapshot(): Theme {
  // An explicit "light" or "dark" wins; anything else, nothing stored
  // included, follows the system. The same rule as the boot script
  // (`parseThemeChoice`), so the first paint and the hydrated app agree.
  try {
    return parseThemeChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function getServerThemeSnapshot(): Theme {
  return "system";
}

function subscribeSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSystemThemeSnapshot(): "dark" | "light" {
  return getSystemTheme();
}

function getServerSystemSnapshot(): "dark" | "light" {
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(
    subscribeStoredTheme,
    getStoredThemeSnapshot,
    getServerThemeSnapshot,
  );
  const systemTheme = useSyncExternalStore(
    subscribeSystemTheme,
    getSystemThemeSnapshot,
    getServerSystemSnapshot,
  );
  const resolvedTheme = theme === "system" ? systemTheme : theme;

  // Keep the <html> class in sync with the resolved theme. This is a DOM write,
  // not a setState — it runs on mount (reconciling the class the inline script
  // set to any stored preference) and whenever the resolved theme changes.
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((next: Theme) => {
    // Persist every explicit choice, "system" included, so a reload honours
    // it. A fresh visitor with nothing stored also follows the system. The
    // write + notify re-reads the external store; the effect above applies the
    // class, and the matchMedia subscription keeps "system" live.
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage refused: nothing to persist; the stored value stays.
    }
    notifyThemeListeners();
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
