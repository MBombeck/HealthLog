/**
 * Opaque multi-domain keyset cursor for the `/api/sync/changes` delta
 * feed (v1.7.0).
 *
 * The cursor carries one independent `(updatedAt, id)` high-water mark
 * per sync domain (measurements / mood / intakes). A per-domain keyset
 * (not a single shared watermark) is mandatory: each domain walks its
 * own table at its own `updatedAt` rate, and a backfill writes hundreds
 * of rows in the same millisecond, so a bare-timestamp watermark would
 * skip or double-count rows that share a tick. The `id` tie-breaker
 * makes each domain's ordering total.
 *
 * The encoding is deliberately opaque to the client — iOS echoes the
 * token back verbatim and never parses it (iOS-coord §7.6), so the
 * server is free to change this format without a client release. The
 * current encoding is base64url-of-JSON; nothing depends on that choice.
 * A device on the old single-domain token simply decodes to null (the
 * shape no longer matches) and re-inits cleanly — acceptable because no
 * live consumer cursors exist yet.
 */

/** The sync domains the feed serves. */
export type SyncDomain = "measurements" | "mood" | "intakes";

export const SYNC_DOMAINS: readonly SyncDomain[] = [
  "measurements",
  "mood",
  "intakes",
];

/** A single domain's keyset position. */
export interface DomainWatermark {
  /** `updatedAt` of the last drained row, as epoch milliseconds. */
  updatedAtMs: number;
  /** `id` of the last drained row (cuid) — the keyset tie-breaker. */
  id: string;
}

/**
 * The decoded cursor: a per-domain watermark map. Domains the client has
 * not yet advanced are simply absent (treated as a fresh scan).
 */
export type SyncCursor = Partial<Record<SyncDomain, DomainWatermark>>;

const CURSOR_VERSION = 1;

/** Encode a per-domain keyset map into an opaque token. */
export function encodeCursor(cursor: SyncCursor): string {
  const d: Record<string, { u: number; i: string }> = {};
  for (const domain of SYNC_DOMAINS) {
    const wm = cursor[domain];
    if (wm) d[domain] = { u: wm.updatedAtMs, i: wm.id };
  }
  const json = JSON.stringify({ v: CURSOR_VERSION, d });
  return Buffer.from(json, "utf-8").toString("base64url");
}

function parseWatermark(raw: unknown): DomainWatermark | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = (raw as { u?: unknown }).u;
  const i = (raw as { i?: unknown }).i;
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  if (typeof i !== "string" || i.length === 0) return null;
  return { updatedAtMs: u, id: i };
}

/**
 * Decode an opaque token back into a per-domain keyset map. Returns null
 * for a malformed / unparseable / wrong-version token so the caller can
 * treat a garbage cursor as a clean initial sync rather than throwing a
 * 500. A token whose envelope parses but carries zero valid domain
 * watermarks decodes to an empty map (a fresh scan of every domain),
 * which is also a clean init.
 */
export function decodeCursor(token: string): SyncCursor | null {
  try {
    const json = Buffer.from(token, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { v?: unknown }).v !== CURSOR_VERSION ||
      typeof (parsed as { d?: unknown }).d !== "object" ||
      (parsed as { d: unknown }).d === null
    ) {
      return null;
    }
    const d = (parsed as { d: Record<string, unknown> }).d;
    const cursor: SyncCursor = {};
    for (const domain of SYNC_DOMAINS) {
      const wm = parseWatermark(d[domain]);
      if (wm) cursor[domain] = wm;
    }
    return cursor;
  } catch {
    return null;
  }
}
