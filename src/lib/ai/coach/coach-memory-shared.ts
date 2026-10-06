/**
 * v1.11.1 — generator-free contract for the Coach long-term-memory refresh
 * queue. The chat route enqueues a single-conversation refresh here without
 * importing the concrete generators (which would pull the provider chain into
 * the route bundle). The worker handler (`runCoachMemoryRefresh`) calls the
 * summary + fact + plan generators; it re-uses the queue name from here so
 * there is one source of truth.
 *
 * v1.41 — the refresh runs once a conversation has gone QUIET, not once it
 * grows past twenty turns. The old trigger meant the extraction almost never
 * ran: most conversations are shorter. Every turn now asks for a refresh
 * {@link COACH_MEMORY_QUIET_MS} later; the per-conversation `singletonKey`
 * inside a quiet-length slot collapses a busy conversation's turns into one
 * queued job, and the worker, when it wakes to a conversation that is still
 * going, puts the job back until the conversation has been quiet that long.
 * The summary still folds only the turns past the history window, so a short
 * conversation costs the fact and plan passes alone.
 *
 * Mirrors `period-narrative-shared.ts`: queue name + payload type + enqueue
 * helper here, the concrete dispatch in the worker.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

export const COACH_MEMORY_REFRESH_QUEUE = "coach-memory-refresh";

/** How long a conversation must be quiet before its memory is refreshed. */
export const COACH_MEMORY_QUIET_MS = 30 * 60_000;

export interface CoachMemoryRefreshPayload {
  conversationId: string;
  userId: string;
  /** Locale to compose the summary / facts prose in; defaults to "en". */
  locale?: "de" | "en";
}

/**
 * Fire-and-forget from every chat turn: refresh this conversation's memory
 * once it has been quiet for {@link COACH_MEMORY_QUIET_MS}. `delayMs` is the
 * wait (the worker passes the rest of the quiet time when it reschedules).
 * No-ops cleanly when the global boss is unavailable (a web process without
 * an embedded worker): the memory simply stays as-is until the next turn.
 */
export async function enqueueCoachMemoryRefresh(
  payload: {
    conversationId: string;
    userId: string;
    locale: "de" | "en";
  },
  delayMs: number = COACH_MEMORY_QUIET_MS,
): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) return;
  const quietSeconds = Math.round(COACH_MEMORY_QUIET_MS / 1000);
  try {
    await boss.send(
      COACH_MEMORY_REFRESH_QUEUE,
      {
        conversationId: payload.conversationId,
        userId: payload.userId,
        locale: payload.locale,
      } satisfies CoachMemoryRefreshPayload,
      {
        singletonKey: `quiet:${payload.conversationId}`,
        singletonSeconds: quietSeconds,
        startAfter: Math.max(1, Math.round(delayMs / 1000)),
      },
    );
    annotate({
      action: { name: "coach.memory.refresh.enqueued" },
      meta: {
        locale: payload.locale,
        delaySeconds: Math.round(delayMs / 1000),
      },
    });
  } catch {
    // Best-effort — a failure just leaves the Coach memory unchanged until the
    // next turn enqueues again.
  }
}
