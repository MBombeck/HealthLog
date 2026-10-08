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
import { KeyboardInsetBridge } from "@/components/keyboard-inset-bridge";
import { VersionPoller } from "@/components/version-poller";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import { SharedRecordGrantLossBridge } from "@/components/layout/shared-record-grant-loss-bridge";
import { RecordSessionFenceBridge } from "@/components/layout/record-session-fence-bridge";
import { useAuth, type AccountAccessStatus } from "@/hooks/use-auth";
import { useRecordSessionTransition } from "@/hooks/use-record-session-transition";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import {
  discardDashboardSnapshotPreload,
  prefetchDashboardSnapshot,
} from "@/lib/queries/use-dashboard-snapshot";
import {
  getRecordSessionTransition,
  subscribeToRecordSessionTransition,
} from "@/lib/query-keys/record-session-transition";
import {
  forgetMedicationsPrefetch,
  prefetchMedicationsList,
} from "@/lib/queries/prefetch-medications";
import {
  getRecordScope,
  subscribeToRecordScope,
} from "@/lib/query-keys/record-scope";
import {
  restorePersistedQueryCache,
  startPersistingQueryCache,
} from "@/lib/pwa/query-persister";
import {
  QUERY_CLIENT_DEFAULT_OPTIONS,
  subscribeToMeaningfulVisibilityRefresh,
} from "@/lib/pwa/query-client-options";

const SHELL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

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
// client code runs here. It does not, however, resolve the active shared
// record: that verdict arrives from `/api/auth/me`. Do not begin a record read
// until that answer and the local cache scope agree.
export function isRecordPreloadReady({
  isLoading,
  accountAccessStatus,
  activeAccountId = null,
}: {
  isLoading: boolean;
  accountAccessStatus: AccountAccessStatus | undefined;
  activeAccountId?: string | null;
}): boolean {
  return (
    !isLoading &&
    (accountAccessStatus === "absent" || accountAccessStatus === "valid") &&
    getRecordScope() === activeAccountId
  );
}

function subscribeToClientRecordScope(onStoreChange: () => void): () => void {
  return subscribeToRecordScope(onStoreChange);
}

function getClientRecordScope(): string | null {
  return getRecordScope();
}

function getServerRecordScope(): string | null {
  return null;
}

function DashboardSnapshotPreloader() {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const { user, isLoading } = useAuth();
  const transition = useRecordSessionTransition();
  const recordScope = useSyncExternalStore(
    subscribeToClientRecordScope,
    getClientRecordScope,
    getServerRecordScope,
  );
  const ready =
    transition.phase === "ready" &&
    isRecordPreloadReady({
      isLoading,
      accountAccessStatus: user?.accountAccessStatus,
      activeAccountId: user?.accountAccess?.active?.accountId ?? null,
    });

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    if (pathname === "/" && isDashboardSnapshotEnabled()) {
      prefetchDashboardSnapshot(queryClient, controller.signal);
    }
    // v1.16.7 — same waterfall cut for the medications page: its list
    // query (which carries the per-medication `nextDueAt` the due cells
    // render) used to fire only after the page chunk mounted. Firing it
    // at route commit rides the data hop in parallel with the chunk
    // download; the nav links additionally prefetch on hover/touch
    // intent, so this is the fallback for direct loads + reloads.
    if (pathname === "/medications") {
      prefetchMedicationsList(queryClient, controller.signal);
    } else {
      // Off the page: a later prefetch starts a new visit, and an earlier one
      // must not excuse the next mount's re-verification.
      forgetMedicationsPrefetch();
    }
    // A transition to an unresolved, refused, or different record scope must
    // abort a preloader before its response can be adopted by the next route.
    return () => controller.abort();
  }, [pathname, queryClient, ready, recordScope, transition.phase]);
  return null;
}

// ── Meaningful PWA resume refresh ────────────────────

function QueryVisibilityRefreshBridge() {
  const queryClient = useQueryClient();
  const transition = useRecordSessionTransition();
  useEffect(
    () =>
      transition.phase === "ready"
        ? subscribeToMeaningfulVisibilityRefresh(queryClient)
        : undefined,
    [queryClient, transition.phase],
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
  const transition = useRecordSessionTransition();
  useEffect(() => {
    if (transition.phase !== "ready") return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void restorePersistedQueryCache(
      queryClient,
      SHELL_VERSION,
      () => !cancelled,
    ).finally(() => {
      if (!cancelled) {
        stop = startPersistingQueryCache(queryClient, SHELL_VERSION);
      }
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [queryClient, transition.phase]);
  return null;
}

/**
 * Clear tab-local reads immediately whenever the browser-wide transition
 * store enters its hold. The AuthShell consumes the same store synchronously,
 * so protected children unmount while this bridge cancels their observers.
 */
function RecordSessionTransitionBridge() {
  const queryClient = useQueryClient();
  const { refetch } = useAuth();
  const transition = useRecordSessionTransition();

  useEffect(() => {
    const clearForTransition = () => {
      if (getRecordSessionTransition().phase === "ready") return;
      discardDashboardSnapshotPreload();
      void queryClient.cancelQueries();
      queryClient.clear();
    };
    // A tab opened while another tab is already switching needs the same
    // cache purge even though it has no future broadcast to receive.
    clearForTransition();
    return subscribeToRecordSessionTransition(clearForTransition);
  }, [queryClient]);

  useEffect(() => {
    if (
      transition.phase === "resolving" ||
      (transition.phase === "ready" && transition.id !== null)
    ) {
      void refetch();
    }
  }, [refetch, transition.id, transition.phase]);

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
          <RecordSessionTransitionBridge />
          <QueryVisibilityRefreshBridge />
          <DashboardSnapshotPreloader />
          <OfflineMutationToaster />
          {/* v1.36.0 — a grant that ends while a browser is inside the record
              leaves the session stamped and every read refused. One cache
              subscriber notices the stable errorCode and puts the browser back
              in its own account, rather than asking every call site to. */}
          <SharedRecordGrantLossBridge />
          <RecordSessionFenceBridge />
          {children}
          <Toaster position="bottom-right" richColors />
          <KeyboardInsetBridge />
          <VersionPoller />
          <ServiceWorkerRegistrar />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
