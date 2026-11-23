"use client";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { I18nProvider, useTranslations } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import { showErrorToast } from "@/lib/errors/error-toast";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { confirmsSaved } from "@/lib/api/mutation-feedback";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { KeyboardInsetBridge } from "@/components/keyboard-inset-bridge";
import { VersionPoller } from "@/components/version-poller";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import { SharedRecordGrantLossBridge } from "@/components/layout/shared-record-grant-loss-bridge";
import { RecordSessionFenceBridge } from "@/components/layout/record-session-fence-bridge";
import { OidcReproofReturnBridge } from "@/components/auth/oidc-reproof-return";
import { LocaleServerSyncBridge } from "@/components/layout/locale-server-sync-bridge";
import { useAuth, type AccountAccessStatus } from "@/hooks/use-auth";
import { useRecordSessionTransition } from "@/hooks/use-record-session-transition";
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
  createAppQueryClient,
  subscribeToMeaningfulVisibilityRefresh,
} from "@/lib/pwa/query-client-options";

const SHELL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

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

/**
 * Whether arriving on `pathname` warms the medications list: on a navigation
 * to `/medications`, never on the document's own load there (`loadedOn`, the
 * path the document loaded on until the first navigation), whose server
 * render already carries the list.
 */
export function preloadsMedicationsList(
  pathname: string | null,
  loadedOn: string | null,
): boolean {
  return pathname === "/medications" && loadedOn !== pathname;
}

function DashboardSnapshotPreloader() {
  const queryClient = useQueryClient();
  const pathname = usePathname();
  const { user, isLoading } = useAuth();
  const transition = useRecordSessionTransition();
  // The path the document itself loaded on, until the first navigation.
  const loadedOn = useRef<string | null>(pathname);
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
    if (pathname === "/") {
      prefetchDashboardSnapshot(queryClient, controller.signal);
    }
    // v1.16.7 — same waterfall cut for the medications page: its list
    // query (which carries the per-medication `nextDueAt` the due cells
    // render) used to fire only after the page chunk mounted. Firing it
    // at route commit rides the data hop in parallel with the chunk
    // download; the nav links additionally prefetch on hover/touch
    // intent, so this is the fallback for direct loads + reloads.
    if (loadedOn.current !== pathname) loadedOn.current = null;
    if (pathname === "/medications") {
      // Not on the document's own load: the server render already carries
      // the list (`app/medications/page.tsx`). A prefetch here creates the
      // query before the page's HydrationBoundary renders, which then hydrates
      // the list in an effect instead, so the first client render paints the
      // skeleton over the server's cards (React #418).
      if (preloadsMedicationsList(pathname, loadedOn.current)) {
        prefetchMedicationsList(queryClient, controller.signal);
      }
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

// ── Dashboard snapshot persistence ───────────────────
//
// Fill the dashboard reads from the IndexedDB snapshot as a warm start, then
// debounce-persist them back. The restore waits for `/api/auth/me`: the
// snapshot belongs to one account, and only a known account can be compared
// with its owner. Build-version + age gated; cleared at every session end.
function QueryPersistenceBridge() {
  const queryClient = useQueryClient();
  const transition = useRecordSessionTransition();
  const userId = useAuth().user?.id ?? null;
  useEffect(() => {
    if (transition.phase !== "ready" || userId === null) return;
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
  }, [queryClient, transition.phase, userId]);
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
        showErrorToast(t("offlineBanner.saveFailed"), {
          id: "offline-mutation-failed",
        });
      }
    });
    return unsubscribe;
  }, [queryClient, t]);
  return null;
}

// ── Save confirmation ────────────────────────────────

/**
 * The one place a change confirms itself (`src/lib/api/mutation-feedback.ts`).
 * A mutation that declares `meta: CONFIRM_SAVED` gets "Saved" once it
 * succeeds, unless its call site raised a toast of its own meanwhile (an
 * Undo toast, a named confirmation): the newest toast is compared before and
 * shortly after, so a call site that toasts after `await mutateAsync()` is
 * not answered twice.
 */
function MutationSavedToaster() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  useEffect(() => {
    const cache = queryClient.getMutationCache();
    const lastToastAt = new Map<number, unknown>();
    const newestToast = () => toast.getHistory().at(-1)?.id;
    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== "updated") return;
      const mutation = event.mutation;
      if (!confirmsSaved(mutation.options.meta)) return;
      if (event.action.type === "pending") {
        lastToastAt.set(mutation.mutationId, newestToast());
      } else if (event.action.type === "success") {
        const before = lastToastAt.get(mutation.mutationId);
        lastToastAt.delete(mutation.mutationId);
        setTimeout(() => {
          if (newestToast() === before) {
            toastWrittenOutcome("success", t("common.saved"));
          }
        }, 250);
      } else if (event.action.type === "error") {
        lastToastAt.delete(mutation.mutationId);
      }
    });
    return unsubscribe;
  }, [queryClient, t]);
  return null;
}

// ── Root Providers ───────────────────────────────────

/**
 * The app-wide toaster.
 *
 * Its theme is the one the page painted, not `"system"`: the app's theme is
 * its own setting (following the system unless a person chose), and a phone
 * in light mode showed light toasts over an app set to dark.
 *
 * Below 600 px Sonner lays toasts across the bottom edge, 16 px up, which on
 * a phone is on top of the bottom bar: the "new version" hint sat over the
 * tabs and the add button until it was dismissed. The mobile offset lifts
 * them above the bar and the home indicator. Sonner applies it below 600 px
 * only, while the bar follows the shell (up to `md`, and a phone held
 * sideways), so `globals.css` repeats the lift under `shell-mobile`.
 */
function AppToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="bottom-right"
      richColors
      theme={resolvedTheme}
      mobileOffset={{
        bottom: "calc(var(--chrome-bottom) + 0.75rem)",
      }}
    />
  );
}

export function Providers({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  // On the server this client lives for one render; `createAppQueryClient`
  // keeps its entries from holding that render past the response.
  const [queryClient] = useState(createAppQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <I18nProvider initialLocale={initialLocale}>
          <QueryPersistenceBridge />
          <RecordSessionTransitionBridge />
          <QueryVisibilityRefreshBridge />
          <DashboardSnapshotPreloader />
          <OfflineMutationToaster />
          <MutationSavedToaster />
          {/* v1.36.0 — a grant that ends while a browser is inside the record
              leaves the session stamped and every read refused. One cache
              subscriber notices the stable errorCode and puts the browser back
              in its own account, rather than asking every call site to. */}
          <SharedRecordGrantLossBridge />
          <RecordSessionFenceBridge />
          <OidcReproofReturnBridge />
          <LocaleServerSyncBridge />
          {children}
          <AppToaster />
          <KeyboardInsetBridge />
          <VersionPoller />
          <ServiceWorkerRegistrar />
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
