import { prisma } from "@/lib/db";

/**
 * `ApiToken.lastUsedAt`, written at most once a minute per token.
 *
 * The column answers "is this token still in use" on the token lists; a
 * minute of precision answers it. Writing it on every request did not: the
 * native app opens with a few dozen requests on one token at once, and each
 * fired an UPDATE of the same row. Those updates queued on the row lock,
 * every one holding a pooled connection while it waited (up to 700 ms), so
 * the reads of the same burst had to open further connections.
 *
 * Per process: the first request of a token in a minute writes, the rest
 * skip the statement. Several instances behind one database write at most
 * once a minute each.
 *
 * Fire-and-forget: the request never waits for it, and nothing here can
 * fail it.
 */
export const TOKEN_LAST_USED_INTERVAL_MS = 60_000;

/** Bounds the per-process memo; clearing it only costs a few extra writes. */
const MAX_TRACKED_TOKENS = 10_000;

const lastStamp = new Map<string, number>();

export function stampTokenLastUsed(
  tokenId: string,
  nowMs: number = Date.now(),
): void {
  const previous = lastStamp.get(tokenId);
  if (
    previous !== undefined &&
    nowMs - previous < TOKEN_LAST_USED_INTERVAL_MS
  ) {
    return;
  }
  if (lastStamp.size >= MAX_TRACKED_TOKENS) lastStamp.clear();
  lastStamp.set(tokenId, nowMs);

  try {
    void Promise.resolve(
      prisma.apiToken.update({
        where: { id: tokenId },
        data: { lastUsedAt: new Date(nowMs) },
      }),
    ).catch(() => {});
  } catch {
    // A client that cannot even build the statement must not fail the request.
  }
}

/** Test seam: forget every write this process made. */
export function resetTokenLastUsedThrottle(): void {
  lastStamp.clear();
}
