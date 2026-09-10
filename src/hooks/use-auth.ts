"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiFetchRaw, ApiError } from "@/lib/api/api-fetch";
import { adoptRecordFenceState } from "@/lib/api/record-fence";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import type {
  TimeFormatPreference,
  DateFormatPreference,
} from "@/lib/format-locale";
import { isTimeFormatPreference, storeTimeFormat } from "@/lib/time-format";
import { isDateFormatPreference, storeDateFormat } from "@/lib/date-format";
import { storeTimezone } from "@/lib/timezone-mirror";
import type { ModuleKey } from "@/lib/modules/registry";
import type { ModuleAccessState } from "@/lib/sharing/module-disclosure";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { TourProgress } from "@/lib/onboarding/tour-progress";
import { clearOfflineCachesForSessionEnd } from "@/lib/pwa/query-persister";
import {
  setRecordScope,
  setRefusedRecordScope,
} from "@/lib/query-keys/record-scope";
import {
  settleRecordSessionTransition,
  settleRefusedRecordSessionTransition,
} from "@/lib/query-keys/record-session-transition";
import type { AccountAccess } from "@/lib/sharing/account-access-view";
import { parseAccountAccess } from "@/lib/sharing/account-access-schema";

/**
 * v1.36.0 — an account with no sharing at all. The shape `fetchMe` falls back
 * to when the payload carries no block, so every consumer reads a real object
 * and none of them has to spell out what a missing block would mean.
 */
export const NO_ACCOUNT_ACCESS: AccountAccess = {
  accounts: [],
  active: null,
  recordKind: "self",
  canSwitch: false,
};

/** Whether the account-access block was absent, valid, or refused as malformed. */
export type AccountAccessStatus = "absent" | "valid" | "invalid";

/**
 * v1.18.6 — resume point for the module tour as the client sees it on
 * `/api/auth/me`. Mirrors the server-side `TourProgress` shape.
 */
export type AuthTourProgress = TourProgress;

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  heightCm: number | null;
  dateOfBirth: string | null;
  gender: string | null;
  timezone: string;
  onboardingCompletedAt: string | null;
  /**
   * v1.4.15 Phase B5: whether the user has finished or dismissed
   * the spotlight tour overlaid on the dashboard. Distinct from
   * `onboardingCompletedAt` (the wizard at /onboarding) — see the
   * `<TourLauncher>` component for the gating logic.
   */
  onboardingTourCompleted: boolean;
  /**
   * v1.18.6 — resumable module-tour progress, or null when the user
   * has not started the tour. The `<TourLauncher>` seeds its resume
   * index from `lastStopId`. Distinct from the coarse
   * `onboardingTourCompleted` boolean, which stays the auto-launch gate.
   */
  onboardingTourProgress: AuthTourProgress | null;
  /**
   * v1.39 (C1) — the needs-based setup flow's state for the record the payload
   * describes — the active one under a switch: the nine ordered steps with
   * their `pending | done | skipped` status, the answers as given, the flow's
   * own completion stamp (distinct from `onboardingCompletedAt` above, which
   * stays the first-run redirect's gate) and the one task the flow offered.
   * Under a scoped grant the answers come back empty.
   *
   * Optional in the type so a stale /me payload — an older server image, or a
   * test fixture written before the field existed — coerces to "no flow" in
   * the mapper below rather than failing the shape.
   */
  onboarding?: OnboardingStateDto | null;
  /**
   * v1.18.6 (DISC-02) — ISO timestamp of the one-time medical-disclaimer
   * acknowledgment, or null when never acknowledged. The onboarding welcome
   * step gates "Get started" on a non-null value for a fresh account.
   * Optional in the type so a stale /me payload (older server image without
   * the field) and existing test fixtures coerce to "never acknowledged"
   * rather than failing the shape.
   */
  disclaimerAcknowledgedAt?: string | null;
  /**
   * The disclaimer version that acknowledgment was given for. The welcome
   * gate compares it against the current `DISCLAIMER_VERSION` so a revised
   * disclaimer re-prompts instead of riding an old acknowledgment. Optional
   * for the same stale-payload reason as the timestamp above.
   */
  disclaimerAcknowledgedVersion?: string | null;
  /**
   * v1.5.5 — relative URL of the user's self-hosted avatar, served
   * from `/api/user/avatar/{id}?v={updatedAtMs}`. Replaces the
   * Gravatar leak; null when the user has not uploaded an avatar
   * yet (clients paint the username-initials fallback).
   */
  avatarUrl: string | null;
  glucoseUnit: string | null;
  /**
   * v1.7.0 — global metric/imperial display preference. Canonical
   * storage stays SI; this selects the display-time transform branch
   * (km/h vs mph, km vs mi). Null on a stale /me payload coerces to
   * "metric" in `fetchMe`.
   */
  unitPreference: "metric" | "imperial";
  /**
   * Hour-cycle display preference. AUTO follows the locale convention
   * (en → AM/PM, de → 24h); H12 / H24 pin the cycle regardless of locale.
   * Mirrored into localStorage by `fetchMe` so `useFormatters()` and the
   * legacy `src/lib/format.ts` helpers render the same clock. Coerced to
   * "AUTO" against a stale /me payload.
   */
  timeFormat: TimeFormatPreference;
  /**
   * Date-order display preference. AUTO follows the locale convention
   * (de → dd.MM.yyyy, en → MM/dd/yyyy); DMY / MDY / YMD pin the field order
   * regardless of locale. Mirrored into localStorage by `fetchMe` so
   * `useFormatters()` and the `<DateField>` primitive render the same order.
   * Coerced to "AUTO" against a stale /me payload.
   */
  dateFormat: DateFormatPreference;
  /**
   * v1.4.47 W3 — per-user Coach opt-out. When `true`, every Coach
   * mount point (`<LayoutCoachFab>`, `<LayoutCoachMount>`, the
   * inline `<CoachLaunchButton>` pill, the `/targets` page CTA)
   * renders nothing. The gate sits BELOW the operator-level
   * `flags.coach` short-circuit — both must agree to render the
   * affordance. Defaults to `false` when the field is absent (e.g.
   * stale /me payload from a partial-deploy rollback).
   */
  disableCoach: boolean;
  /**
   * v1.7.0 — optional patient-identity fields used by the health-record
   * export (PDF cover + FHIR Patient). All optional; `insuranceNumber`
   * is the German KVNR, decrypted server-side for the form prefill.
   */
  fullName: string | null;
  insurerName: string | null;
  /**
   * v1.8.6 — optional German insurer institution number (IKNR, 9 digits).
   * Surfaced on the FHIR `Coverage` resource's payor Organization.
   */
  insurerIkNumber: string | null;
  insuranceNumber: string | null;
  /**
   * Practice / clinic name from the last health-record export, so the export
   * panel opens pre-filled instead of asking for it again every month. The
   * export route persists it after a successful generation; `null` means the
   * user has never set one, or deliberately cleared the line.
   */
  lastReportPracticeName: string | null;
  /**
   * The saved report selection blob (`{ v, leaves, format, rangeDays,
   * includeCharts }`), or `null` when the account has never saved one. Parsed
   * through `parseSavedProfile` at the one place that reads it, so a drifted
   * shape resolves to "never saved" rather than to a partial scope.
   */
  reportSelection: unknown;
  /**
   * v1.15.0 — cycle-tracking feature gate, resolved server-side from gender
   * + the per-user opt-in. The cycle nav entry + page hide when false; every
   * `/api/cycle/*` route also enforces the gate. Coerced to `false` against a
   * stale /me payload (older server image without the field) in `fetchMe`.
   */
  cycleTrackingEnabled: boolean;
  /**
   * v1.18.0 — the resolved per-user module enable/disable map. Each
   * toggleable module key (mood, sleep, glucose, workouts, recovery, labs,
   * achievements, coach, insights, doctorReport, cycle) is `true` when the
   * module is enabled for this account, `false` when disabled. `cycle` and
   * `coach` are delegated server-side (gender + opt-in / operator flag +
   * opt-out) and already reflected here, so nav + Insights pill gates read
   * this map rather than re-deriving. Coerced to `{}` against a stale /me
   * payload (older server image without the field) so every gate fails open
   * — a missing map never blanks the nav. Optional so existing `AuthUser`
   * test fixtures stay valid; `fetchMe` always populates it (empty map when
   * absent), so live code reads a real map.
   */
  modules?: Partial<Record<ModuleKey, boolean>>;
  /**
   * v1.18.0 — operator-layer availability per toggleable module. `false`
   * ⇒ the operator disabled the module server-wide (off for every account,
   * regardless of personal preference). Distinct from `modules`, which is
   * the already-AND-ed effective state and cannot tell operator-off from
   * user-off apart. Only the Modules hub needs this distinction (to render
   * an operator-disabled module as a read-only "disabled server-wide" row);
   * every other gate reads `modules`. Coerced to `{}` against a stale /me
   * payload so a missing map reads as all-available.
   */
  moduleAvailability?: Partial<Record<ModuleKey, boolean>>;
  /**
   * Why each module is or is not available for the record this browser is
   * inside — `"enabled"`, `"disabled"` (the record has it switched off),
   * `"not_granted"` (the active grant does not open the module's section) or
   * `"unavailable"` (the operator switched it off for the whole instance).
   * Precedence outside-in: unavailable > not_granted > disabled > enabled.
   *
   * Additive beside `modules`, never instead of it: `modules[key]` is exactly
   * `moduleAccess[key] === "enabled"`, so every gate keeps reading the boolean
   * and only the surfaces that have to EXPLAIN a missing module read this. A
   * client holding the boolean alone has to guess between three different
   * reasons, which is how an empty state ends up offering a delegate a switch
   * they cannot reach. Coerced to `{}` against a stale /me payload, and a
   * missing key falls back to the boolean.
   */
  moduleAccess?: Partial<Record<ModuleKey, ModuleAccessState>>;
  /**
   * v1.36.0 — account sharing, resolved server-side. `accounts` is the
   * switcher's menu, `active` is the record this browser is inside (null when
   * it is in its own), `canSwitch` and per-entry `canWrite` are booleans to
   * bind, never to compute.
   *
   * Nothing in the UI may derive a permission from this block: the server
   * publishes what the caller may do and the client renders it, because two
   * programs deciding one person's access is how they end up disagreeing.
   *
   * Optional so existing `AuthUser` test fixtures stay valid; `fetchMe`
   * always populates it, coercing an absent block (an older server image) to
   * the empty one — no accounts, no active record, no switcher.
   */
  accountAccess?: AccountAccess;
  /**
   * The parser outcome for `accountAccess`. An absent block is the only
   * owner-compatible fallback: it is how older server images answered before
   * sharing existed. A present malformed block stays explicitly refused so a
   * server-side switch cannot paint owner controls in the target record.
   */
  accountAccessStatus?: AccountAccessStatus;
  /**
   * v1.37.0 — the record-session context the server says this browser is in.
   *
   * `epoch` counts how many times this session's record selector has moved and
   * `scope` names the record it is pointed at (null for one's own). Adopted by
   * `fetchMe` and then attached to every same-origin request, so a request
   * formed under a context that has since moved is refused rather than served
   * against the wrong record.
   *
   * Null on the Bearer transport, which carries no such state. Optional so
   * existing `AuthUser` fixtures stay valid; an absent field is an older server
   * image and leaves the client unadopted, which the `bootstrap` sentinel makes
   * safe.
   */
  recordSession?: { epoch: number; scope: string | null } | null;
}

/**
 * Non-sensitive "a session existed here" marker (localStorage boolean, no
 * identity data). A cold offline launch cannot reach `/api/auth/me`, so the
 * auth query errors without ever answering the session question — the marker
 * is the last-known state that lets the shell render the cached app chrome
 * instead of bouncing to the login gate and wiping the offline caches. Set on
 * every successful `/api/auth/me`, cleared on every session END (logout and
 * true 401/403).
 */
const WAS_AUTHENTICATED_KEY = "healthlog-was-authenticated";

export function readWasAuthenticated(): boolean {
  try {
    return localStorage.getItem(WAS_AUTHENTICATED_KEY) === "1";
  } catch {
    return false;
  }
}

function storeWasAuthenticated(): void {
  try {
    localStorage.setItem(WAS_AUTHENTICATED_KEY, "1");
  } catch {
    /* storage unavailable — the marker is best-effort */
  }
}

function clearWasAuthenticated(): void {
  try {
    localStorage.removeItem(WAS_AUTHENTICATED_KEY);
  } catch {
    /* best effort */
  }
}

/**
 * True when an `/api/auth/me` failure carries NO verdict on the session —
 * a network-level failure (fetch `TypeError` offline, abort/timeout), the
 * service worker's synthetic 503 offline envelope (`meta.offline`), the
 * browser reporting itself offline, or a server-side 5xx. None of these mean
 * "logged out"; only an explicit 401/403 does. Treating them as session end
 * used to redirect an offline relaunch to /auth/login and wipe the offline
 * caches — destroying exactly the installed-PWA-opened-offline scenario the
 * SW + query persister exist for.
 */
export function isAuthVerdictUnknown(error: unknown): boolean {
  if (error instanceof ApiError) {
    // 5xx (incl. the SW's synthetic 503 with `meta.offline: true`) and any
    // other non-auth status: the server never ruled on the session. Only an
    // explicit 401/403 is a verdict.
    return error.status !== 401 && error.status !== 403;
  }
  // Everything below the HTTP layer is transport-level by construction:
  // fetch `TypeError` (offline / DNS / connection refused), `AbortError` /
  // `TimeoutError` DOMException from the 15 s default signal.
  return true;
}

export async function fetchMe(): Promise<AuthUser> {
  // v1.16.4 — routed through the typed wrapper; a non-OK /me (401)
  // throws `ApiError`, which `useAuth` treats as "not authenticated"
  // exactly like the old hand-rolled throw.
  //
  // v1.4.47 W3 — coerce `disableCoach` against `undefined` so a stale
  // /me payload from a partial-deploy rollback (older server image
  // without the field) keeps the Coach surface visible by default.
  const data = await apiGet<
    Partial<AuthUser> & {
      id: string;
      username: string;
      role: string;
      timezone: string;
    }
  >("/api/auth/me");
  // Hour-cycle preference: coerce against a stale /me payload, then mirror
  // into localStorage so `useFormatters()` and the legacy format helpers
  // (which cannot reach the query cache) render the same clock.
  const timeFormat: TimeFormatPreference = isTimeFormatPreference(
    data.timeFormat,
  )
    ? data.timeFormat
    : "AUTO";
  storeTimeFormat(timeFormat);
  // Date-order preference: coerce against a stale /me payload, then mirror
  // into localStorage so `useFormatters()` and the `<DateField>` primitive
  // (which cannot reach the query cache) render the same field order.
  const dateFormat: DateFormatPreference = isDateFormatPreference(
    data.dateFormat,
  )
    ? data.dateFormat
    : "AUTO";
  storeDateFormat(dateFormat);
  // Profile timezone (issue #490): mirror into localStorage so
  // `useFormatters()` and the legacy format helpers render timestamps in
  // the user's zone. `storeTimezone` validates the IANA name and CLEARS
  // the mirror on garbage, so a poison value falls back to Berlin instead
  // of reaching `Intl.DateTimeFormat` (RangeError).
  storeTimezone(typeof data.timezone === "string" ? data.timezone : "");
  // A confirmed session: refresh the non-sensitive offline-relaunch marker.
  storeWasAuthenticated();
  // v1.36.0 — the record this browser is reading, straight from the server's
  // resolved answer. This is the correcting write for the cache-scope mirror:
  // whatever the switch flow stamped before its reload, the block is what the
  // resolver will actually honour on the next request, so the mirror tracks it
  // rather than the client's memory of what it asked for.
  // v1.37.0 — adopt the record-session context BEFORE anything releases a
  // hold. `/api/auth/me` is one of exactly two responses a client may learn
  // its context from, and a hold released onto an unadopted context would put
  // the shell back on screen with every subsequent request still asserting
  // `bootstrap`. Adoption first means a released hold is always released onto
  // a context the next request can prove.
  adoptRecordFenceState(data.recordSession);
  const { accountAccess, status: accountAccessStatus } =
    resolveAccountAccess(data);
  if (accountAccessStatus === "invalid") {
    setRefusedRecordScope();
  } else {
    setRecordScope(accountAccess.active?.accountId ?? null);
  }
  // A cross-tab switch holds the shell until this server-resolved payload
  // confirms the record the transition committed. The malformed branch has
  // already installed its refusal sentinel, so it may release only into the
  // refusal door rather than being mistaken for the caller's own record.
  if (accountAccessStatus === "invalid") {
    settleRefusedRecordSessionTransition();
  } else {
    settleRecordSessionTransition(accountAccess.active?.accountId ?? null);
  }
  return {
    ...(data as AuthUser),
    disableCoach: data.disableCoach ?? false,
    // v1.18.6 — coerce against a stale /me payload (older server image
    // without the field) to null so the tour starts from the top.
    onboardingTourProgress: data.onboardingTourProgress ?? null,
    // v1.39 (C1) — coerce against a stale /me payload (an older server image
    // without the field) to null, which every reader treats as "no flow was
    // ever run" rather than as an unfinished one.
    onboarding: data.onboarding ?? null,
    // v1.7.0 — coerce against a stale /me payload (older server image
    // without the field) so the display defaults to metric.
    unitPreference: data.unitPreference === "imperial" ? "imperial" : "metric",
    timeFormat,
    dateFormat,
    // v1.15.0 — coerce against a stale /me payload so the cycle nav entry
    // stays hidden by default when the field is absent.
    cycleTrackingEnabled: data.cycleTrackingEnabled === true,
    // v1.18.0 — coerce against a stale /me payload (older server image
    // without the module map) to an empty map so every module gate fails
    // open: a missing key reads as enabled and the nav stays intact.
    modules:
      data.modules && typeof data.modules === "object" ? data.modules : {},
    // v1.18.0 — operator availability map, coerced against a stale payload
    // to an empty map (all-available) so the Modules hub never shows a
    // spurious "disabled server-wide" row on an older server image.
    moduleAvailability:
      data.moduleAvailability && typeof data.moduleAvailability === "object"
        ? data.moduleAvailability
        : {},
    // The reason behind each module's boolean. Coerced against a stale /me
    // payload to an empty map; `useModuleAccess` then falls back to the
    // boolean, so an older server image reads "disabled" rather than
    // inventing a reason it was never told.
    moduleAccess:
      data.moduleAccess && typeof data.moduleAccess === "object"
        ? data.moduleAccess
        : {},
    accountAccess,
    accountAccessStatus,
  };
}

/**
 * Read the sharing block off a payload that may not carry one.
 *
 * A genuinely missing field is the pre-sharing server contract and remains an
 * own-record fallback. Once a server publishes the field, every other value —
 * including `undefined` as an own property and `null` — is a malformed block,
 * not permission to fall back to the caller's own presentation.
 */
function resolveAccountAccess(value: object): {
  accountAccess: AccountAccess;
  status: AccountAccessStatus;
} {
  if (!Object.hasOwn(value, "accountAccess")) {
    return { accountAccess: NO_ACCOUNT_ACCESS, status: "absent" };
  }

  const accountAccess = parseAccountAccess(
    (value as { accountAccess?: unknown }).accountAccess,
  );
  return accountAccess
    ? { accountAccess, status: "valid" }
    : { accountAccess: NO_ACCOUNT_ACCESS, status: "invalid" };
}

export function useAuth() {
  const query = useQuery({
    // v1.4.40 W-RSC — factory-routed to `queryKeys.authMe()`. Pre-fix
    // the literal `["auth", "me"]` was the canonical example in
    // audit-H1 of factory drift. The prefix `["auth"]` still matches
    // `queryKeys.auth()` invalidations.
    queryKey: queryKeys.authMe(),
    queryFn: fetchMe,
    // v1.16.8 — one retry on network errors / 5xx (never 401/403). A
    // single transient failure used to flip `isAuthenticated` false and
    // send the shell to the redirect spinner mid-session.
    retry: retryOnceOnTransientError,
    staleTime: 5 * 60 * 1000,
  });

  // v1.27.x offline fix — classify a failed `/api/auth/me` before acting on
  // it. Only an explicit 401/403 means "session ended"; a network-level
  // failure (offline relaunch, SW 503 offline envelope, timeout) or a 5xx
  // carries no verdict, so the hook holds the LAST-KNOWN auth state (the
  // localStorage marker) instead of flipping to unauthenticated. Pre-fix, an
  // airplane-mode relaunch read as a logout: the shell redirected to
  // /auth/login and wiped every offline cache (data 7→0 entries, pages 1→0
  // in the audit measurement), making the whole offline story unreachable.
  const verdictUnknown = query.isError && isAuthVerdictUnknown(query.error);
  const isAuthenticated =
    !!query.data || (verdictUnknown && readWasAuthenticated());

  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated,
    /**
     * True while the session question is genuinely unanswered — the auth
     * probe failed at the transport level (or 5xx) and no cached `/me`
     * payload exists. The shell uses it to suppress the session-end cache
     * wipe: a wipe without a 401/403 verdict would destroy the offline
     * caches on every network blip.
     */
    isAuthUnknown: !query.data && verdictUnknown,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The account payload, withheld from the SSR pass and the hydration render.
 *
 * ## The problem it solves
 *
 * The app shell sits in the streamed HTML shell and hydrates first; mounting it
 * fires `/api/auth/me`. A page below a `loading.tsx` is a streamed Suspense
 * boundary and hydrates LATER — routinely after that response has landed. React
 * replays the boundary's first render as a hydration render, and at that moment
 * `useAuth().user` holds a payload the server never had, because an RSC renders
 * with no query cache at all. Any branch that consults the account then renders
 * one thing in the streamed HTML and another in the browser, React reports #418
 * and discards the whole streamed tree.
 *
 * That stayed invisible while every page kept its own data behind a
 * `useMounted()` skeleton gate: both sides painted the same silhouette. The
 * dashboard's RSC prefetch (`src/app/page.tsx`) removed the silhouette — real
 * tiles render on both sides now — and the divergence surfaced as a bailout on
 * every cold load of `/`, throwing away exactly the paint the prefetch buys.
 *
 * `useMounted()` answers with its SERVER snapshot during SSR *and* during
 * hydration, then with the client one from the first re-render, so this pins the
 * hydration render to what the server rendered and hands the payload over one
 * render later. A component mounted by a client-side navigation never sees the
 * pin (`useSyncExternalStore` consults the server snapshot only while
 * hydrating), and `user === null` beside a settled query is not a new state: it
 * is what every consumer already renders on a cold load, before `/me` answers.
 *
 * ## Why `useAuth` itself must NOT do this
 *
 * Tried, and it breaks the app. Several surfaces drive a REDIRECT off the
 * payload — the document vault sends you to `/` when
 * `user.modules.inboundDocuments` is not `true`, and its effect only waits on
 * `isLoading`, which is already false by then. A hydration render that answers
 * "no account" makes that effect fire for real, and the vault bounces to the
 * dashboard on every load. The same shape would latch into any `useState`
 * initializer seeded from the account.
 *
 * So the withholding is opt-in, and belongs to components that RENDER the
 * account rather than navigate on it. Reach for it in anything that paints
 * inside a streamed page boundary; leave the redirect gates on `useAuth`.
 */
export function useAccountOnceMounted(): AuthUser | null {
  const { user } = useAuth();
  const mounted = useMounted();
  return mounted ? user : null;
}

/**
 * Wipe every client-side cache at a session END so no session ever inherits
 * another account's data on a shared browser.
 *
 * Primary cross-user guard: `queryClient.clear()` drops the entire IN-MEMORY
 * query cache. On a long-lived SPA the root QueryClient instance outlives every
 * client-side navigation, and the health-data families
 * (`["measurements"]`, `["dashboard","snapshot"]`, `["labs", …]`, `["mood", …]`,
 * `["insights", …]`) are NOT user-scoped — so without this wipe the next account
 * that logs in on the same browser reads the previous account's cached entries
 * before any refetch lands. `clear()` also drops `["auth","me"]`, superseding the
 * former explicit `setQueryData(null)` + `invalidateQueries(["auth"])`.
 *
 * Then `clearOfflineCachesForSessionEnd()` wipes the persisted layers — the
 * IndexedDB query snapshot, the SW offline read-data cache (`healthlog-data-*`),
 * and the SW page cache (`healthlog-pages-*`, cached navigation HTML). The static
 * cache (hashed chunks, icons) carries no PII and stays intact to avoid a
 * needless re-download. Best-effort; never blocks the redirect.
 */
export function clearCachesForSessionEnd(queryClient: QueryClient): void {
  queryClient.clear();
  // v1.36.0 — the cache-scope mirror is session state too. Left behind, the
  // next account on this browser would boot with the previous session's record
  // scope, which partitions its cache under a stranger's id until the first
  // `/api/auth/me` corrects it. Harmless for correctness (the store it points
  // at is wiped below) and free to get right.
  setRecordScope(null);
  // The offline-relaunch marker is session state too: after a real session
  // end the next cold offline launch must land on the login gate, not the
  // cached shell.
  clearWasAuthenticated();
  void clearOfflineCachesForSessionEnd();
}

export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { t } = useTranslations();

  return useMutation({
    mutationFn: async () => {
      await apiFetchRaw("/api/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      clearCachesForSessionEnd(queryClient);
      router.push("/auth/login");
    },
    // v1.16.4 — a network-failed logout used to do nothing at all (the
    // menu closed, the session stayed); a toast names the failure.
    onError: () => toast.error(t("common.networkError")),
  });
}
