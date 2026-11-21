"use client";

/**
 * v1.36.0 — entering and leaving somebody else's record, from the browser.
 *
 * The switch is four acts in a fixed browser-coordination order:
 *
 *   1. **Hold every tab.** Publish a cross-tab `blocking` transition and clear
 *      local reads before the POST can change the shared server session.
 *   2. **Ask the server.** `POST /api/account/switch` validates the grant and
 *      stamps the session. Any client-visible failure stays held until a
 *      fresh `/api/auth/me` resolves the record the server actually kept; it
 *      never restores stale caches.
 *   3. **Empty every cache that survives a reload.** The IndexedDB query
 *      snapshot and the service worker's `healthlog-data-*` cache both answer
 *      reads from disk. Left in place, the first paint on the other side can
 *      be the PREVIOUS record's numbers under a banner naming the new one —
 *      and nothing in the page's own code would be wrong, because the answer
 *      would not have come from the page. Awaited, not fired: a wipe racing
 *      the navigation is a wipe that sometimes does not happen.
 *   4. **Reload the document.** Not `router.refresh()`, not a query
 *      invalidation. A hard navigation is what discards the in-memory cache,
 *      every React state tree holding a rendered value, and every in-flight
 *      request that was issued against the old record. The reload IS the cache
 *      flush; the two lines above it are the parts a reload cannot reach.
 *
 * The hook returns from step 1 and never from step 3 — the page is gone.
 * Callers therefore do not need a success state, only a pending one.
 */

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { showErrorToast } from "@/lib/errors/error-toast";

import { ApiError, apiPost } from "@/lib/api/api-fetch";
import {
  adoptRecordFenceState,
  currentRecordFenceState,
} from "@/lib/api/record-fence";
import { fetchMe } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { clearOfflineCachesForRecordSwitch } from "@/lib/pwa/query-persister";
import { queryKeys } from "@/lib/query-keys";
import {
  beginRecordSessionTransition,
  commitRecordSessionTransition,
  resolveUnknownRecordSessionTransition,
} from "@/lib/query-keys/record-session-transition";

/**
 * The stable sharing error code for a lost grant, as the envelope publishes it
 * (`meta.errorCode`). Named here rather than typed inline so the reset below
 * cannot drift apart from what the server sends.
 */
export const SHARING_ACCESS_DENIED = "sharing.access.denied";

/** The `meta.errorCode` on a failed request, when it carried one. */
export function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = error.meta?.errorCode;
  return typeof code === "string" ? code : null;
}

/**
 * True when a request failed because the caller may no longer act as the
 * account they are inside — the grant was revoked, lapsed, or never applied to
 * this record.
 *
 * The correct response is not a retry and not an error card: it is to leave the
 * record. A browser that stays inside it shows a banner claiming access it does
 * not have, over a page that will 403 every read.
 */
export function isSharingAccessDenied(error: unknown): boolean {
  return errorCodeOf(error) === SHARING_ACCESS_DENIED;
}

/**
 * v1.37.0 — the record-session fence's 409. Not a refusal of access: another
 * tab moved the selector first, or this tab's context is older than the row.
 * The response is to reconcile through `/api/auth/me` and try again, NOT to
 * leave the record — which is why it is deliberately absent from the set
 * `subscribeToGrantLoss` fires on below.
 */
export const SHARING_SESSION_CHANGED = "sharing.session.changed";

/** True when the server refused because this session's record context moved. */
export function isRecordSessionChanged(error: unknown): boolean {
  return errorCodeOf(error) === SHARING_SESSION_CHANGED;
}

interface SwitchResponse {
  actingAs: {
    accountId: string;
    username: string;
    displayName: string | null;
    access: "READ" | "WRITE";
  } | null;
  /**
   * The context this session is now in. Null when the request carried no
   * `expectedEpoch` — which a fence-aware client never does, so in this bundle
   * it is always present on a 200.
   */
  recordSession: { epoch: number; scope: string | null } | null;
}

/**
 * Ask the server to move the selector, naming the epoch this browser believes
 * it is on, and adopt whatever context comes back.
 *
 * The epoch turns the write into a compare-and-set: two tabs pressing the
 * switcher at the same moment resolve to one monotonic outcome and the loser
 * gets a 409 instead of silently overwriting the winner. Adopting the response
 * is what lets the very next request prove its context — this endpoint and
 * `/api/auth/me` are the only two a client may adopt from.
 */
async function postSwitch(accountId: string | null): Promise<SwitchResponse> {
  const response = await apiPost<SwitchResponse>("/api/account/switch", {
    accountId,
    expectedEpoch: currentRecordFenceState()?.epoch ?? 0,
  });
  adoptRecordFenceState(response.recordSession);
  return response;
}

/**
 * The switch, with one reconcile-and-retry.
 *
 * A lost compare-and-set is not a failure the person at the keyboard caused or
 * can act on: another tab of the same browser moved first. Surfacing that as a
 * failed toast would make the switcher look broken while nothing was wrong. So
 * a 409 reconciles through a network-only `/api/auth/me` — which re-adopts the
 * true epoch — and retries exactly once. A SECOND 409 means the browser is
 * genuinely racing itself faster than it can settle, and that does surface,
 * because retrying forever would spin rather than tell anybody.
 */
async function postSwitchWithReconcile(
  accountId: string | null,
): Promise<SwitchResponse> {
  try {
    return await postSwitch(accountId);
  } catch (error) {
    if (!isRecordSessionChanged(error)) throw error;
    await fetchMe();
    return postSwitch(accountId);
  }
}

/**
 * Complete a server-confirmed switch: empty the disk layers, reload.
 *
 * Extracted from the mutation so the grant-loss reset can reuse the exact same
 * sequence. Two copies of "wipe, then reload" is one copy too many for a step
 * whose order is the safety property.
 */
async function landOnRecord(destination = "/"): Promise<never> {
  await clearOfflineCachesForRecordSwitch();
  window.location.assign(destination);
  // The document is being replaced. Nothing after this runs, and the promise
  // deliberately never settles so no caller paints a "done" state over a page
  // that is on its way out.
  return new Promise<never>(() => {});
}

/**
 * Switch into a record, or (with `null`) back into the caller's own.
 *
 * Errors surface as a toast and leave the browser in place — including the
 * `sharing.access.denied` case, which means the grant ended between the
 * switcher being painted and the click. The list the switcher renders comes
 * from `/api/auth/me`, so the next boot will not offer it again.
 */
export function useAccountSwitch() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationKey: queryKeys.accountSwitchMutation(),
    mutationFn: async ({
      accountId,
      destination,
    }: {
      accountId: string | null;
      destination: string;
    }) => {
      // Publish the browser-wide hold before the server sees the session
      // change. Every recipient blocks its shell and clears local reads before
      // it reconciles the committed scope through a fresh `/me`.
      const transitionId = beginRecordSessionTransition(accountId);
      // The in-memory cache holds the record we are leaving. Clearing it here
      // as well as reloading costs nothing and closes the window in which a
      // failed navigation would leave the old entries reachable.
      void queryClient.cancelQueries();
      queryClient.clear();
      try {
        await postSwitchWithReconcile(accountId);
      } catch (error) {
        // A client error cannot prove that the server left the session alone:
        // its response may have been lost after the server committed. Keep all
        // tabs held until a fresh `/me` resolves the record the server kept.
        resolveUnknownRecordSessionTransition(transitionId);
        throw error;
      }
      commitRecordSessionTransition(transitionId, accountId);
      return landOnRecord(destination);
    },
    onError: (error: unknown) => {
      showErrorToast(
        isSharingAccessDenied(error)
          ? t("recordSharing.switch.noLongerAvailable")
          : t("recordSharing.switch.failed"),
        { cause: error },
      );
    },
  });

  return {
    ...mutation,
    /** Preserve the established own-record and exit call sites. */
    mutate: (accountId: string | null) =>
      mutation.mutate({ accountId, destination: "/" }),
    /** Enter a scoped record directly at a server-presentable destination. */
    switchTo: (accountId: string, destination: string) =>
      mutation.mutate({ accountId, destination }),
  };
}

/**
 * Leave a record the server has stopped honouring.
 *
 * The switcher-reset the contract asks for: on `sharing.access.denied` the
 * session is still stamped with an account it may no longer act on, and every
 * delegable read from here on is a 403. When the server confirms the reset,
 * its own-record scope replaces the stamp rather than leaving somebody
 * staring at refusals under a banner that says they are somewhere they are
 * not.
 *
 * `POST /api/account/switch` with `null` is an actor surface and always
 * succeeds — it is the way out, by design. If even that fails (offline, server
 * down), the browser keeps the transition unresolved and reloads. A fresh
 * `/api/auth/me`, not a local scope guess, decides what may render next.
 */
/**
 * Watch the cache for the moment the server stops honouring the switch.
 *
 * A plain function over a QueryClient rather than an effect body, so a test
 * can drive a real cache into the error state and check what happens — which
 * is the only way to tell a subscriber that fires from one that was written
 * and never wired.
 *
 * Fires `onLoss` at most once. The caller reloads the document, and a second
 * trigger would queue a second navigation behind one already in flight.
 */
export function subscribeToGrantLoss(
  queryClient: QueryClient,
  onLoss: () => void,
): () => void {
  let fired = false;
  return queryClient.getQueryCache().subscribe((event) => {
    if (fired) return;
    if (event.type !== "updated") return;
    if (event.query.state.status !== "error") return;
    if (!isSharingAccessDenied(event.query.state.error)) return;
    fired = true;
    onLoss();
  });
}

export function useLeaveSharedRecordOnGrantLoss() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    const transitionId = beginRecordSessionTransition(null);
    void queryClient.cancelQueries();
    queryClient.clear();
    try {
      await postSwitchWithReconcile(null);
      commitRecordSessionTransition(transitionId, null);
    } catch {
      // The grant-loss path deliberately still reloads, but it cannot claim
      // an own-record scope when the POST outcome is unknown. The next `/me`
      // is the only authority that may release this resolving hold.
      resolveUnknownRecordSessionTransition(transitionId);
    }
    await landOnRecord();
  }, [queryClient]);
}
