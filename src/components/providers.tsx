"use client";

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { VersionPoller } from "@/components/version-poller";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import { prefetchDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { prefetchMedicationsList } from "@/lib/queries/prefetch-medications";
import {
  restorePersistedQueryCache,
  startPersistingQueryCache,
} from "@/lib/pwa/query-persister";
import {
  QUERY_CLIENT_DEFAULT_OPTIONS,
  subscribeToMeaningfulVisibilityRefresh,
} from "@/lib/pwa/query-client-options";

const SHELL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

// ── Theme Context ────────────────────────────────────

type Theme = "dark" | "light" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "dark" | "light";
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
}

// ── Theme as an external store ───────────────────────
//
// The stored preference lives in localStorage, and the OS preference in
// matchMedia — both browser-only values that must NOT be read in a `useState`
// initializer (server renders "dark", a client with a stored "light"/"system"
// initializes differently → the React #418 hydration seam this repo already
// hit with the sidebar). `useSyncExternalStore` is the sanctioned fix: it reads
// the value with an SSR-stable server snapshot ("dark") and reconciles to the
// real value after hydration without a setState-in-effect. The nonce-bound
// inline script in layout.tsx stamps the correct class pre-paint, so there is
// no visual FOUC while React reconciles.

const THEME_STORAGE_KEY = "healthlog-theme";
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
  const saved = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
  // A stored "light"/"dark"/"system" choice wins. With no stored preference the
  // app defaults to dark rather than tracking the OS.
  if (saved === "light" || saved === "dark" || saved === "system") return saved;
  return "dark";
}

function getServerThemeSnapshot(): Theme {
  return "dark";
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

function ThemeProvider({ children }: { children: ReactNode }) {
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
    // Persist every explicit choice, including "system" — the absence of a
    // stored value is reserved for a fresh visitor and defaults to dark.
    // Storing "system" verbatim keeps an explicit OS-tracking choice
    // distinguishable from "never chose", so a reload honours it. The write +
    // notify re-reads the external store; the effect above applies the class.
    localStorage.setItem(THEME_STORAGE_KEY, next);
    notifyThemeListeners();
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// ── Dashboard snapshot preloader ─────────────────────
//
// v1.16.6 first-load waterfall fix: fire the snapshot fetch the moment
// the router commits to "/" instead of waiting for the dashboard page
// chunk to download + mount (~450 ms later on a 4G / 4x-CPU profile).
// The proxy has already enforced auth + onboarding for "/" before any
// client code runs here, so the prefetch cannot fire for an
// unauthenticated visitor; a racing edge case just yields a swallowed
// 401 prefetch and the mounted cell re-resolves normally.
function DashboardSnapshotPreloader() {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/" && isDashboardSnapshotEnabled()) {
      prefetchDashboardSnapshot(queryClient);
    }
    // v1.16.7 — same waterfall cut for the medications page: its list
    // query (which carries the per-medication `nextDueAt` the due cells
    // render) used to fire only after the page chunk mounted. Firing it
    // at route commit rides the data hop in parallel with the chunk
    // download; the nav links additionally prefetch on hover/touch
    // intent, so this is the fallback for direct loads + reloads.
    if (pathname === "/medications") {
      prefetchMedicationsList(queryClient);
    }
  }, [pathname, queryClient]);
  return null;
}

// ── Meaningful PWA resume refresh ────────────────────

function QueryVisibilityRefreshBridge() {
  const queryClient = useQueryClient();
  useEffect(
    () => subscribeToMeaningfulVisibilityRefresh(queryClient),
    [queryClient],
  );
  return null;
}

// ── Offline query persistence ────────────────────────
//
// v1.18.6 — hydrate the last-synced query cache from IndexedDB before the
// first authenticated paint, then debounce-persist successful reads back.
// Combined with the service worker's allowlisted stale-while-revalidate API
// branch, an installed PWA opened offline renders last-known data instead of
// empty skeletons. Build-version + age gated; cleared on logout.
function QueryPersistenceBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void restorePersistedQueryCache(queryClient, SHELL_VERSION).finally(() => {
      if (!cancelled) {
        stop = startPersistingQueryCache(queryClient, SHELL_VERSION);
      }
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient]);
  return null;
}

// ── Offline mutation backstop ────────────────────────

/**
 * F-OFF-1 backstop. With mutations in `always` network mode an offline write
 * rejects immediately (rather than pausing forever), so the individual form's
 * `onError` fires and shows its own message. This subscriber is the safety net
 * for any mutation WITHOUT a call-site error handler: it surfaces one honest,
 * de-duplicated toast whenever a mutation errors while the browser is offline,
 * so a write can never vanish silently. Gated on `navigator.onLine === false`
 * so a normal server-side error (which the form already surfaces) is never
 * double-toasted.
 */
function OfflineMutationToaster() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  useEffect(() => {
    const cache = queryClient.getMutationCache();
    const unsubscribe = cache.subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "error" &&
        typeof navigator !== "undefined" &&
        navigator.onLine === false
      ) {
        toast.error(t("offlineBanner.saveFailed"), {
          id: "offline-mutation-failed",
        });
      }
    });
    return unsubscribe;
  }, [queryClient, t]);
  return null;
}

// ── Root Providers ───────────────────────────────────

export function Providers({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider initialLocale={initialLocale}>
          <QueryPersistenceBridge />
          <QueryVisibilityRefreshBridge />
          <DashboardSnapshotPreloader />
          <OfflineMutationToaster />
          {children}
          <Toaster position="bottom-right" richColors />
          <VersionPoller />
          <ServiceWorkerRegistrar />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
