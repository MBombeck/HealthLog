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
 *
 * Version compatibility is additive, not breaking. The iOS client has
 * been in public beta since v1.5 and the delta feed shipped in v1.7.0, so
 * live v1 cursors DO exist in the field. A v1 token (which only carried
 * the measurements / mood / intakes domains) decodes normally: its known
 * domain watermarks are preserved and the two domains added in v2
 * (`cycleDays`, `cycles`) are simply absent → a fresh scan of just those
 * two domains on the next sync, with no re-download of the measurement /
 * mood / intake history. Only a genuinely malformed / unparseable token
 * re-inits from scratch.
 */

/** The sync domains the feed serves. */
export type SyncDomain =
  | "measurements"
  | "mood"
  | "intakes"
  | "cycleDays"
  | "cycles"
  | "measurementMirror";

/**
 * `measurementMirror` (#1272) is additive inside the v2 envelope: a token
 * without it decodes as before and that domain scans from the start. Its
 * watermark is not a row's `updatedAt` but the `mirrorChangedAt` of the
 * token whose readings were last re-delivered (see `read-rows.ts`).
 */
export const SYNC_DOMAINS: readonly SyncDomain[] = [
  "measurements",
  "mood",
  "intakes",
  "cycleDays",
  "cycles",
  "measurementMirror",
];

/** A single domain's keyset position. */
export interface DomainWatermark {
  /**
   * `updatedAt` of the last drained row, as epoch milliseconds; for
   * `measurementMirror`, the `mirrorChangedAt` of that row's token.
   */
  updatedAtMs: number;
  /** `id` of the last drained row (cuid) — the keyset tie-breaker. */
  id: string;
}

/**
 * The decoded cursor: a per-domain watermark map. Domains the client has
 * not yet advanced are simply absent (treated as a fresh scan).
 */
export type SyncCursor = Partial<Record<SyncDomain, DomainWatermark>>;

// v1.15.0 — bumped to 2 when the `cycleDays` + `cycles` domains were
// added. New tokens are stamped v2; decoding accepts both v1 and v2
// envelopes (see `decodeCursor`) so live beta v1 cursors keep their
// measurement / mood / intake watermarks and only fresh-scan the two new
// domains rather than re-initialising the whole feed.
const CURSOR_VERSION = 2;

/** Versions whose envelope shape `decodeCursor` accepts. v1 lacked the
 *  `cycleDays`/`cycles` domains; they decode as absent (fresh scan). */
const SUPPORTED_CURSOR_VERSIONS: readonly number[] = [1, 2];

/**
 * Encode a per-domain keyset map into an opaque token.
 *
 * `issuedAtMs` is when the server handed the token out. The watermarks cannot
 * say that: a restore writes rows back with their original `updatedAt`, so a
 * cursor drained entirely after a restore can still carry watermarks older
 * than it. The issue time is what `/api/sync/changes` compares against the
 * account's `syncResetAt`. Additive inside the v2 envelope: a token without
 * it decodes as before and counts as issued before any reset.
 */
export function encodeCursor(cursor: SyncCursor, issuedAtMs?: number): string {
  const d: Record<string, { u: number; i: string }> = {};
  for (const domain of SYNC_DOMAINS) {
    const wm = cursor[domain];
    if (wm) d[domain] = { u: wm.updatedAtMs, i: wm.id };
  }
  const json = JSON.stringify(
    issuedAtMs === undefined
      ? { v: CURSOR_VERSION, d }
      : { v: CURSOR_VERSION, t: issuedAtMs, d },
  );
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
    const version = (parsed as { v?: unknown }).v;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof version !== "number" ||
      !SUPPORTED_CURSOR_VERSIONS.includes(version) ||
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

/**
 * When a token was issued (see {@link encodeCursor}), or null for a token
 * that does not say: one from before the field existed, or one that does not
 * parse.
 */
export function decodeCursorIssuedAt(token: string): number | null {
  try {
    const json = Buffer.from(token, "base64url").toString("utf-8");
    const t = (JSON.parse(json) as { t?: unknown } | null)?.t;
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}
