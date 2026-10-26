import { annotate } from "./context";
import { runDetached } from "./detached";
import { trackBackgroundTask } from "./background-tasks";

/**
 * Run a best-effort background promise and leave an observable breadcrumb
 * when it rejects — the disciplined replacement for `.catch(() => {})`, which
 * swallows a background failure with no `annotate()` or logger call.
 *
 * Use it for work whose failure must not fail the request but SHOULD be
 * visible: background enqueues (reminder satisfaction, rollup refresh),
 * re-auth state transitions, and post-write sync side effects.
 *
 * Observability without a control-flow change:
 *   - The rejection reason is annotated into the current wide event under a
 *     per-action `meta` key, so it flows through the SAME central redaction
 *     the event builder applies at emit time — the raw message is never
 *     logged unredacted. When the work settles after the event has already
 *     flushed (or runs outside a request context, e.g. a pg-boss worker),
 *     `annotate()` is a safe no-op.
 *   - A payload-free `console.warn` (SWC keeps `warn` in prod) records the
 *     action name so a late-settling failure still surfaces in the logs.
 *     Only the caller-supplied action label — never the error text — reaches
 *     the raw console sink, keeping it redaction-safe by construction.
 *
 * The work stays fire-and-forget: the caller does not await it and its
 * resolution is discarded exactly as before. It is started through
 * `runDetached`, so nothing it annotates can rename the caller's event; that
 * is why it is passed as a function rather than as a promise already
 * running. Under test the settled handle is registered with
 * `trackBackgroundTask` so the suite setup can await it — see
 * `./background-tasks` for why a late `console.warn` is otherwise a teardown
 * hazard.
 *
 * @param start Starts the background work.
 * @param context.action A stable `<surface>.<noun>.<verb>` label (never user
 *   input) identifying which background task failed.
 * @param context.meta Optional extra fields to attach to the breadcrumb; they
 *   ride the annotate/redact path with the error message.
 */
export function fireAndForget(
  start: () => Promise<unknown>,
  context: { action: string; meta?: Record<string, unknown> },
): void {
  const settled = runDetached(start).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    annotate({
      meta: {
        [`fire_and_forget.${context.action}`]: {
          error: message,
          ...context.meta,
        },
      },
    });
    // Action label only — the error payload rides the redacted annotate path
    // above, so nothing sensitive reaches the raw console sink.
    console.warn(`[fire-and-forget] background task failed: ${context.action}`);
  });

  trackBackgroundTask(settled);
}
