/**
 * Opaque keyset cursor for the `/api/sync/changes` delta feed (v1.7.0).
 *
 * The cursor encodes the `(updatedAt, id)` high-water mark of the last
 * row the client fully drained. A keyset (not a bare `updatedAt`
 * watermark) is mandatory: a backfill writes hundreds of rows in the
 * same millisecond, and a bare-timestamp watermark would skip or
 * double-count rows that share a tick. The `id` tie-breaker makes the
 * ordering total.
 *
 * The encoding is deliberately opaque to the client — iOS echoes the
 * token back verbatim and never parses it (iOS-coord §7.6), so the
 * server is free to change this format without a client release. The
 * current encoding is base64url-of-JSON; nothing depends on that choice.
 */

export interface SyncCursor {
  /** `updatedAt` of the last drained row, as epoch milliseconds. */
  updatedAtMs: number;
  /** `id` of the last drained row (cuid) — the keyset tie-breaker. */
  id: string;
}

/** Encode a keyset position into an opaque token. */
export function encodeCursor(cursor: SyncCursor): string {
  const json = JSON.stringify({ u: cursor.updatedAtMs, i: cursor.id });
  return Buffer.from(json, "utf-8").toString("base64url");
}

/**
 * Decode an opaque token back into a keyset position. Returns null for a
 * malformed / unparseable token so the caller can treat a garbage cursor
 * as a clean initial sync rather than throwing a 500.
 */
export function decodeCursor(token: string): SyncCursor | null {
  try {
    const json = Buffer.from(token, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { u?: unknown }).u !== "number" ||
      typeof (parsed as { i?: unknown }).i !== "string"
    ) {
      return null;
    }
    const u = (parsed as { u: number }).u;
    const i = (parsed as { i: string }).i;
    if (!Number.isFinite(u) || i.length === 0) return null;
    return { updatedAtMs: u, id: i };
  } catch {
    return null;
  }
}
