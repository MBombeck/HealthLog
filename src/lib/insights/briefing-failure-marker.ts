import { prisma } from "@/lib/db";
import {
  isTimeoutFailure,
  providerFailureKind,
  type ProviderFailureKind,
} from "@/lib/ai/failure-kind";
import { AllProvidersFailedError } from "@/lib/ai/provider-runner";

/**
 * Dated failure marker for the daily-briefing generation.
 *
 * The briefing keeps its last good payload on a failed refresh: the generator
 * writes NO `User.insightsCachedTextEncrypted` row when a provider times out or errors,
 * so the previous briefing stays intact and the surface never blanks. What was
 * missing is a signal the READ path can use to tell the difference between "no
 * refresh was due" and "the last refresh attempt failed" — without that, a
 * stale-but-shown briefing reads as current and a never-generated one shows a
 * generic empty state instead of an honest "couldn't generate".
 *
 * This records an append-only `auditLog` row (no migration, no overwrite of the
 * cached text) carrying the calendar day, the reason, and the locale. The read
 * path compares the latest marker's timestamp against the last successful
 * generation (`User.insightsCachedAt`): a marker newer than the last success
 * means the most recent attempt failed.
 */
export const BRIEFING_FAILURE_ACTION = "insights.briefing-failure";

/**
 * Coarse class of a briefing-generation failure, used by the read path to
 * point the empty-state hint at the right lever:
 *   - `timeout`     — the generation ran out of time (a deadline, or a marker
 *                     from before the failure kind was recorded). Lever: raise
 *                     the AI response timeout for a slow local model.
 *   - `auth`        — the provider rejected the request (4xx that is not 429).
 *                     Lever: re-check the provider / API key in Settings.
 *   - `rate-limit`  — the provider returned 429.
 *   - `provider`    — a 5xx / generic upstream failure.
 *   - `format`      — the model returned unparseable output (invalid JSON).
 *   - `unknown`     — anything that does not classify.
 */
export type BriefingFailureClass =
  "timeout" | "auth" | "rate-limit" | "provider" | "format" | "unknown";

/**
 * Classify a failure from its recorded reason and (optional) upstream HTTP
 * status. A reason of `invalid-json` is always a format miss; a 401/403 (or any
 * other non-429 4xx) is an auth / configuration problem; 429 is a rate limit; a
 * 5xx is a generic provider failure. With no status at all, the recorded
 * failure kind decides (#1267): a deadline is `timeout`, a reply without an
 * answer is `format`, any other transport failure is `provider`. A marker
 * without a kind keeps the old `timeout` reading.
 */
export function classifyBriefingFailure(args: {
  reason: string;
  httpStatus?: number | null;
  /**
   * #1267 — what the first provider call ran into. A marker written before
   * the field existed has none and keeps the old reading.
   */
  failureKind?: string | null;
  /**
   * The first provider was not called because the health ledger benched it
   * for a credential it refused. The failure is the credential's, whatever
   * the hop itself recorded.
   */
  credentialExpired?: boolean | null;
}): BriefingFailureClass {
  if (args.reason === "invalid-json") return "format";
  if (args.credentialExpired === true) return "auth";
  const status = args.httpStatus;
  if (typeof status === "number" && status > 0) {
    if (status === 429) return "rate-limit";
    if (status >= 400 && status < 500) return "auth";
    if (status >= 500) return "provider";
  }
  // No / sentinel-zero upstream status. Only a deadline is a timeout: a reply
  // that came back without an answer is the model's output, and a refused or
  // dropped connection is the provider, and neither is helped by a longer
  // response timeout.
  const kind = args.failureKind ?? null;
  if (kind === null || isTimeoutFailure(kind as ProviderFailureKind)) {
    return "timeout";
  }
  if (
    kind === "empty_response" ||
    kind === "reasoning_only" ||
    kind === "parse"
  ) {
    return "format";
  }
  return "provider";
}

/**
 * What a thrown provider failure tells the marker: the upstream status, the
 * failure kind and whether a refused credential was behind it, all read off
 * the chain's FIRST hop, the provider the account prefers. The background
 * warm and the interactive regenerate both record through this. The warm
 * used to record the chain error's aggregate status instead, which is 503
 * whenever no hop carried a status of its own, so a provider benched for a
 * refused key was filed as an upstream outage and the card told the reader
 * the provider had "timed out or returned an error".
 */
export function briefingFailureFacts(error: unknown): {
  httpStatus: number | null;
  failureKind: ProviderFailureKind | null;
  credentialExpired?: true;
} {
  if (error instanceof AllProvidersFailedError) {
    const first = error.attempts?.[0];
    return {
      httpStatus: first?.httpStatus ?? null,
      failureKind: first?.failureKind ?? null,
      ...(first?.benchReason === "credential_expired"
        ? { credentialExpired: true as const }
        : {}),
    };
  }
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
  return {
    httpStatus: typeof status === "number" ? status : null,
    failureKind: providerFailureKind(error).failure,
  };
}

/** UTC YYYY-MM-DD calendar-day key for the marker payload. */
function dateKey(at: Date = new Date()): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: internal once-per-day marker key, written and read by this module only, never shown
  return at.toISOString().slice(0, 10);
}

/**
 * Append a failure marker for `userId`. Best-effort: a write failure here must
 * never propagate out of the generation's own failure path.
 */
export async function recordBriefingFailure(args: {
  userId: string;
  reason: string;
  locale?: string;
  /**
   * v1.25.3 — upstream HTTP status when the failure carried one, so the read
   * path can tell an auth / rate-limit / provider failure apart from a plain
   * timeout and point the hint at the right lever.
   */
  httpStatus?: number | null;
  /** #1267 — the first hop's `FallbackHop.failureKind`, when known. */
  failureKind?: ProviderFailureKind | null;
  /** The first hop was benched for a refused credential. */
  credentialExpired?: boolean;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: args.userId,
        action: BRIEFING_FAILURE_ACTION,
        details: JSON.stringify({
          dateKey: dateKey(),
          reason: args.reason,
          httpStatus: args.httpStatus ?? null,
          failureKind: args.failureKind ?? null,
          // Written only when set, so every other marker keeps its shape.
          ...(args.credentialExpired === true
            ? { credentialExpired: true }
            : {}),
          locale: args.locale ?? null,
          triedAt: new Date().toISOString(),
        }),
      },
    });
  } catch {
    // Marker is best-effort — never throw out of the failure path.
  }
}

export interface BriefingFailureState {
  triedAt: string;
  reason: string;
  /** v1.25.3 — coarse class for the empty-state hint (see classifyBriefingFailure). */
  failureClass: BriefingFailureClass;
}

/**
 * Read the latest briefing-failure marker for `userId`, but only when it is
 * newer than the last successful generation (`since`). Returns `null` when the
 * most recent attempt succeeded (or there is no marker at all), so the read
 * path can render a discreet "couldn't refresh" hint exactly when it applies.
 */
export async function readBriefingFailure(args: {
  userId: string;
  since: Date | null;
}): Promise<BriefingFailureState | null> {
  const latest = await prisma.auditLog.findFirst({
    where: { userId: args.userId, action: BRIEFING_FAILURE_ACTION },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!latest) return null;
  // A failure older than (or equal to) the last successful generation has been
  // superseded — the surface is showing fresh text, not a held one.
  if (args.since && latest.createdAt <= args.since) return null;

  let reason = "unknown";
  let httpStatus: number | null = null;
  let failureKind: string | null = null;
  let credentialExpired = false;
  if (latest.details) {
    try {
      const parsed = JSON.parse(latest.details) as {
        reason?: unknown;
        httpStatus?: unknown;
        failureKind?: unknown;
        credentialExpired?: unknown;
      };
      credentialExpired = parsed.credentialExpired === true;
      if (typeof parsed.reason === "string") reason = parsed.reason;
      if (typeof parsed.httpStatus === "number") httpStatus = parsed.httpStatus;
      if (typeof parsed.failureKind === "string") {
        failureKind = parsed.failureKind;
      }
    } catch {
      // Malformed marker payload — still report the failure, generic reason.
    }
  }
  return {
    triedAt: latest.createdAt.toISOString(),
    reason,
    failureClass: classifyBriefingFailure({
      reason,
      httpStatus,
      failureKind,
      credentialExpired,
    }),
  };
}
