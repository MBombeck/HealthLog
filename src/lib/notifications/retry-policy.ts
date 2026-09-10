/**
 * Notification dispatcher retry policy (v1.4.15 Phase B3).
 *
 * Two failure classes:
 *  - HARD reject (`hardReject: true`)        → channel is dead, do NOT retry,
 *    auto-disable immediately and capture a `disabledReason` so the UI can
 *    explain *why* the user needs to re-pair.
 *  - SOFT reject (`hardReject: false`)       → upstream temporarily unhappy
 *    (network timeout, 5xx, 429, generic fetch failure). Retry per the
 *    backoff schedule and only auto-disable after `MAX_CONSECUTIVE_FAILURES`
 *    in a row (5).
 *
 * Hard-reject signal mapping (per spec):
 *  - Web-Push   : statusCode 410 (FCM/Mozilla "subscription gone")
 *  - Web-Push   : statusCode 404 (subscription endpoint deleted) — already
 *                 deletes the row in the sender; treated as hard at the
 *                 channel level only when ALL subs were 410/404 (i.e. the
 *                 channel can no longer succeed).
 *  - Telegram   : Bot API description "chat not found" or
 *                 "Forbidden: bot was blocked by the user"
 *  - ntfy       : statusCode 410 (topic invalidated)
 *
 * Soft-reject signal mapping:
 *  - Any HTTP 5xx, HTTP 429, fetch network error / timeout, generic non-OK
 *    response that doesn't match the hard-reject rules.
 */

export interface SendOutcome {
  ok: boolean;
  /** True iff the upstream signaled a permanent failure (410, blocked-by-user, …). */
  hardReject?: boolean;
  /** HTTP status, when the sender went over HTTP. */
  statusCode?: number;
  /** Stable reason code suitable for `disabled_reason` / `last_failure_reason`. */
  reason?: string;
  /** Human-readable error fragment for logs (NOT for the disabled_reason column). */
  message?: string;
  /**
   * Stable machine code an API surface may forward as `meta.errorCode`. Set
   * only for a refusal the caller can act on — today the private-origin
   * policy (#947), which the test routes answer with 422 and a reason
   * instead of a bare 500.
   */
  errorCode?: string;
}

/**
 * Backoff schedule used to compute `next_retry_at` for soft failures.
 * Indexed by `consecutiveFailures` (0-based AFTER the failed attempt).
 *
 * Spec: [30s, 5min, 30min, 2h, gave-up]. The 5th transient failure flips
 * the channel to auto-disabled with reason `give_up_after_5_failures`.
 */
export const BACKOFF_SCHEDULE_MS: readonly number[] = Object.freeze([
  30 * 1_000, //  1st failure → wait  30s
  5 * 60 * 1_000, //  2nd failure → wait   5min
  30 * 60 * 1_000, //  3rd failure → wait  30min
  2 * 60 * 60 * 1_000, //  4th failure → wait   2h
]);

export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Given the new `consecutiveFailures` value (1, 2, …) AFTER incrementing,
 * return the wall-clock time when a retry is allowed. Returns null once the
 * counter crosses `MAX_CONSECUTIVE_FAILURES` (caller must auto-disable).
 *
 * The schedule is offset by 1 because `consecutiveFailures=1` means the
 * first failure has just happened and we want a 30s cooldown.
 */
export function nextRetryAt(
  consecutiveFailures: number,
  now: Date = new Date(),
): Date | null {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;
  if (consecutiveFailures < 1) return null;
  const idx = Math.min(consecutiveFailures - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return new Date(now.getTime() + BACKOFF_SCHEDULE_MS[idx]);
}

/**
 * After applying a transient failure, decide whether the channel should be
 * auto-disabled (i.e. give-up-after-N-failures fired).
 */
export function shouldAutoDisableAfterTransient(
  consecutiveFailures: number,
): boolean {
  return consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

/**
 * Classify a Telegram Bot API error string into hard/soft.
 * The Bot API uses the `description` field (HTTP 200 with `ok=false`), so the
 * sender doesn't have a clean status code — this is the canonical source.
 */
export function classifyTelegramError(description: string | undefined): {
  hardReject: boolean;
  reason: string;
} {
  const d = (description ?? "").toLowerCase();
  // Permanent: chat does not exist (user deleted the chat or blocked us).
  if (d.includes("chat not found")) {
    return { hardReject: true, reason: "telegram_chat_not_found" };
  }
  if (
    d.includes("blocked by the user") ||
    d.includes("bot was blocked") ||
    d.includes("user is deactivated")
  ) {
    return { hardReject: true, reason: "telegram_blocked_by_user" };
  }
  return { hardReject: false, reason: "telegram_send_failed" };
}

/**
 * Convert a numeric HTTP status into our hard/soft classification for
 * "regular" HTTP-shaped senders (web-push, ntfy).
 *
 * Anything that isn't a hard 410/404 (where applicable) and isn't a
 * 2xx is treated as soft: a transient blip the dispatcher should
 * retry rather than burn the user's channel for.
 */
export function classifyHttpStatus(
  status: number | undefined,
  service: "web-push" | "ntfy" | "webhook",
): { hardReject: boolean; reason: string } {
  if (status === undefined) {
    return { hardReject: false, reason: `${service}_network_error` };
  }
  if (service === "webhook") {
    // A user-supplied relay (Gotify / Discord / Slack / Matrix / HA). 410 Gone
    // and 404 Not Found mean the endpoint was deleted — permanent, do not
    // retry. 401/403 mean the shared secret is wrong — also permanent until
    // the user fixes the config, so we hard-reject and surface the reason in
    // the Settings card rather than burning the backoff schedule on a
    // misconfiguration. Everything else (5xx, 429, timeout) is transient.
    if (status === 410) return { hardReject: true, reason: "webhook_410_gone" };
    if (status === 404)
      return { hardReject: true, reason: "webhook_404_not_found" };
    if (status === 401 || status === 403)
      return { hardReject: true, reason: "webhook_auth_rejected" };
    return { hardReject: false, reason: `webhook_${status}` };
  }
  if (service === "web-push") {
    // 410 Gone = subscription is permanently invalid (push provider
    // told us so). 404 = endpoint never existed / was unsubscribed.
    if (status === 410)
      return { hardReject: true, reason: "web_push_410_gone" };
    if (status === 404)
      return { hardReject: true, reason: "web_push_404_endpoint" };
  }
  if (service === "ntfy") {
    // ntfy.sh treats 410 as "topic deleted, do not retry".
    if (status === 410) return { hardReject: true, reason: "ntfy_410_gone" };
  }
  return { hardReject: false, reason: `${service}_${status}` };
}
