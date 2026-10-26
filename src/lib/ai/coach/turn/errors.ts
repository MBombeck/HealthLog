/**
 * Error classification for a Coach chat turn: which thrown errors are
 * provider failures (a graceful `coach.provider.*` frame) and which are
 * server defects (forwarded to GlitchTip and still answered with a frame,
 * because the stream is already open).
 *
 * Imports nothing from the tool registry or the snapshot builder.
 */
import { annotate, getEvent } from "@/lib/logging/context";
import { redactOptional, redactSecrets } from "@/lib/logging/redact";
import type { AllProvidersFailedError } from "@/lib/ai/provider-runner";

import type { TurnEmitter } from "./types";

/**
 * The `coach.provider.*` code for a provider chain where every hop failed.
 *
 *  - v1.11.0 — the person's PRIMARY provider failed auth-class (401/403):
 *    the credential is dead, not the service, so the drawer deep-links to
 *    reconnect (`credential_expired`).
 *  - v1.4.25 — every hop landed on 429: transient, on the provider's side
 *    (`rate_limited`).
 *  - #1276 — every hop answered with reasoning and no reply, after the
 *    client already asked once more (`reasoning_only`). The provider was
 *    reached; "try again in a moment" is the wrong advice, and the thought
 *    itself is never shown as the answer.
 *  - Anything else: `unavailable`.
 */
export function chainFailureCode(
  err: Pick<AllProvidersFailedError, "attempts" | "primaryCredentialExpired">,
): string {
  if (err.primaryCredentialExpired) return "coach.provider.credential_expired";
  const { attempts } = err;
  if (attempts.length > 0 && attempts.every((a) => a.httpStatus === 429)) {
    return "coach.provider.rate_limited";
  }
  if (
    attempts.length > 0 &&
    attempts.every((a) => a.failureKind === "reasoning_only")
  ) {
    return "coach.provider.reasoning_only";
  }
  return "coach.provider.unavailable";
}

/**
 * v1.21.3 — classify a provider error that bubbled out of the chain runner
 * un-wrapped (i.e. not an `AllProvidersFailedError`). The provider clients tag
 * their thrown errors with `upstream` + `httpStatus`; a tagged error is a
 * provider failure that must surface a graceful `coach.provider.*` frame rather
 * than rethrow into an HTTP 500. Returns `null` for anything that is NOT a
 * recognisable provider error (a real server bug), so those keep the 500 +
 * GlitchTip path. Status mapping mirrors `chainFailureCode`: 401/403 →
 * credential_expired, 429 → rate_limited, a reasoning-only reply →
 * reasoning_only, everything else → unavailable.
 */
export function classifyBubblingProviderError(err: unknown): {
  code:
    "credential_expired" | "rate_limited" | "reasoning_only" | "unavailable";
  httpStatus: number | null;
} | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as { upstream?: unknown; httpStatus?: unknown; kind?: unknown };
  const hasUpstreamTag = typeof e.upstream === "string";
  const status = typeof e.httpStatus === "number" ? e.httpStatus : null;
  // Require the wire tag — a bare `{ httpStatus }` from unrelated code must not
  // be swallowed as a provider outage.
  if (!hasUpstreamTag) return null;
  if (status === 401 || status === 403) {
    return { code: "credential_expired", httpStatus: status };
  }
  if (status === 429) return { code: "rate_limited", httpStatus: status };
  // #1276 — the empty-reply sentinel of a reply that was reasoning only.
  if (e.kind === "reasoning_only") {
    return { code: "reasoning_only", httpStatus: status };
  }
  return { code: "unavailable", httpStatus: status };
}

/**
 * Fire-and-forget GlitchTip forward for a genuine server defect that
 * surfaces INSIDE the open SSE producer — e.g. a Prisma failure in the
 * post-stream `appendMessage` persistence, which runs after the provider
 * call and therefore outside its try/catch. Once the stream is open the
 * route can no longer return a 500, so without this such a defect would
 * read as a generic provider outage in error tracking rather than the
 * server bug it is. Mirrors the api-handler / worker forwarders: dynamic
 * import (no cycle, no startup cost), redacted message + stack, and it
 * NEVER throws so a sink failure cannot mask the original error.
 */
async function reportCoachStreamDefect(err: unknown): Promise<void> {
  const e =
    err instanceof Error ? err : new Error("Unknown coach stream error");
  const message = redactSecrets(`[insights.coach.stream] ${e.message}`);
  console.error("[coach-stream]", message, e);
  try {
    const [{ getGlitchtipSettings }, { sendGlitchtipEvent }] =
      await Promise.all([
        import("@/lib/monitoring-settings"),
        import("@/lib/monitoring/glitchtip"),
      ]);
    const settings = await getGlitchtipSettings();
    if (!settings.glitchtipEnabled || !settings.glitchtipDsn) return;
    await sendGlitchtipEvent({
      dsn: settings.glitchtipDsn,
      input: {
        environment: settings.glitchtipEnvironment || "production",
        message,
        level: "error",
        type: e.name || "Error",
        stack: redactOptional(e.stack),
        sourceTag: "healthlog-api-handler",
      },
    });
  } catch {
    /* the reporter must never throw */
  }
}

/**
 * The in-stream producer threw. The stream is already open, so there is no
 * 500 to return: answer with an error frame (unless nobody is listening) and
 * keep a genuine defect visible.
 */
export function handleProducerFailure(
  err: unknown,
  args: { signal: AbortSignal; emitter: TurnEmitter; conversationId: string },
): void {
  // #781 — a client disconnect can also surface as an abort-shaped error
  // on a path the model step's own catch does not own (e.g. a teardown
  // rejection out of persistence). That is not a defect and nobody is
  // listening: skip the GlitchTip forward and the error frame.
  if (args.signal.aborted) {
    annotate({
      action: { name: "insights.coach.cancelled" },
      meta: { conversationId: args.conversationId, lateAbort: true },
    });
    return;
  }
  // The stream is already open, so we cannot 500: a tagged provider error
  // surfaces a graceful `coach.provider.*` frame; anything else degrades to
  // a generic unavailable frame. A genuine defect is still annotated.
  const providerError = classifyBubblingProviderError(err);
  if (!providerError) {
    // Not a tagged provider failure — a genuine server defect raised
    // inside the open producer (e.g. a DB error in the post-stream
    // `appendMessage` persistence). Record it on the wide event and
    // forward it to GlitchTip so it stays visible instead of reading
    // as a provider outage; the stream is open, so we still emit an
    // error frame below rather than a 500.
    getEvent()?.setError(err instanceof Error ? err : new Error(String(err)));
    void reportCoachStreamDefect(err);
  }
  annotate({
    action: { name: "insights.coach.streamError" },
    meta: {
      unwrapped: Boolean(providerError),
      reported: !providerError,
      firstStatus: providerError?.httpStatus ?? null,
    },
  });
  if (!args.emitter.aborted()) {
    const code = providerError
      ? `coach.provider.${providerError.code}`
      : "coach.provider.unavailable";
    args.emitter.emit({ type: "error", code, message: code });
  }
}
