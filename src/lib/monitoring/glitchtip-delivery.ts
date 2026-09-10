/**
 * What actually happened to the last error report this host tried to send.
 *
 * The admin card used to derive "configured" from the enabled flag plus a DSN
 * that parses. Those two say a target was typed; they say nothing about the
 * target accepting anything. A wrong public key, a wrong project id, a host
 * that stopped answering — every one of them parses, and every one of them
 * would have shown a green badge and a line naming the host, which is the
 * false reassurance an operator only discovers when they go looking for a
 * crash that was never reported.
 *
 * So the outcome is recorded where the DSN already lives, next to the flag it
 * qualifies, and the badge reads it. `sendGlitchtipEvent` is the one writer —
 * every caller in the tree goes through it, so no send path can skip the
 * ledger by construction.
 */
import { prisma } from "@/lib/db";
import type { GlitchtipDeliveryResult } from "@/lib/monitoring/glitchtip";

/**
 * How long a successful send stands for. A self-hoster's instance can go days
 * without an unhandled error, and a badge that expired overnight would train
 * the operator to ignore it; a fortnight is long enough that only a target
 * that has genuinely stopped working falls out of it, and the test button
 * refreshes it on demand.
 */
export const GLITCHTIP_DELIVERY_WINDOW_HOURS = 14 * 24;

export interface GlitchtipDeliveryState {
  lastOkAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
}

/**
 * A short, safe classification of a failure. Never the response body: that is
 * text from a remote host, and an incident target's error page has no business
 * being rendered on the admin page or stored in this database.
 */
export function classifyGlitchtipFailure(
  result: GlitchtipDeliveryResult,
): string {
  if (result.details === "invalid_dsn") return "invalid_dsn";
  if (typeof result.status === "number") return `http_${result.status}`;
  return "network";
}

/**
 * Record the outcome of one send. Best-effort by design — a report that could
 * not be filed must not become a second error, and the singleton row may not
 * exist yet on a host that has never opened the admin page.
 */
export async function recordGlitchtipDelivery(
  result: GlitchtipDeliveryResult,
): Promise<void> {
  const now = new Date();
  try {
    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: result.ok
        ? { glitchtipLastOkAt: now }
        : {
            glitchtipLastFailureAt: now,
            glitchtipLastFailureReason: classifyGlitchtipFailure(result),
          },
    });
  } catch {
    // Nothing to do and nothing to report to: the caller is already on an
    // error path, and throwing here would replace the original failure with
    // this one.
  }
}

/**
 * The judgement, resolved server-side.
 *
 * The client gets the verdict, not the timestamps: whether a report is inside
 * the window is a question about a clock, and the process that holds the
 * ledger is the one that should answer it. A failure older than the last
 * success is not surfaced at all — it has been superseded by a report that
 * got through, and showing it would be reporting a fixed problem.
 */
export interface GlitchtipDeliverySummary {
  /** A report left this host successfully inside the window. */
  reportsDelivering: boolean;
  /** A report has left this host successfully at some point. */
  everDelivered: boolean;
  /** Why the last attempt failed, when that failure is the newest fact. */
  lastFailureReason: string | null;
  /** How long a success stands for, so the card can say it. */
  windowHours: number;
}

export function summariseGlitchtipDelivery(
  state: GlitchtipDeliveryState,
  now: Date,
): GlitchtipDeliverySummary {
  const windowMs = GLITCHTIP_DELIVERY_WINDOW_HOURS * 3_600_000;
  const okAge =
    state.lastOkAt === null ? null : now.getTime() - state.lastOkAt.getTime();
  const failureIsNewest =
    state.lastFailureAt !== null &&
    (state.lastOkAt === null ||
      state.lastFailureAt.getTime() > state.lastOkAt.getTime());

  return {
    reportsDelivering: okAge !== null && okAge >= 0 && okAge <= windowMs,
    everDelivered: state.lastOkAt !== null,
    lastFailureReason: failureIsNewest ? state.lastFailureReason : null,
    windowHours: GLITCHTIP_DELIVERY_WINDOW_HOURS,
  };
}
