/**
 * v1.4.22 — Coach evidence-block (`---KEYVALUES---` … `---END---`)
 * parser.
 *
 * The Coach prompt instructs the model to append, after its prose
 * reply, a sentinel block carrying the load-bearing numbers it cited:
 *
 *   ---KEYVALUES---
 *   avg30 systolic: 138 [mmHg] (last30days)
 *   Tue 6 May: 142/88 [mmHg]
 *   ---END---
 *
 * This module strips that block out of the streamed prose and parses
 * each line into a `CoachKeyValue`. The result feeds the
 * `provenance.keyValues` field that the UI renders as a collapsible
 * disclosure.
 *
 * Defence-in-depth:
 *   - Hard cap 1 KB on the sentinel block (prompt-injection guard).
 *   - Hard cap 8 lines kept (per the prompt contract).
 *   - Each line is validated against `coachKeyValueSchema`; malformed
 *     lines surface in `parsed.malformed[]` with a typed reason
 *     (v1.4.23 H1 — replaced the silent-drop path).
 *   - When the sentinel pair is malformed (e.g. no closing `---END---`,
 *     unbalanced sentinels), the parser still returns whatever rows it
 *     could parse plus a malformed flag; the caller logs
 *     `coach.keyvalues.parse_failed` (full block invalid) or
 *     `coach.keyvalues.parse_partial` (mixed valid + invalid) for ops
 *     visibility.
 */
import { coachKeyValueSchema, type CoachKeyValue } from "./types";

/** Sentinel block payload hard cap — 1 KB after the opening marker. */
const SENTINEL_BYTE_CAP = 1024;
/** Max key/value rows kept inside the block (prompt-contract value). */
const SENTINEL_LINE_CAP = 8;
/** Per-line value cap before we reject the row (defence-in-depth). */
const VALUE_BYTE_CAP = 200;
/** Per-line label cap mirroring the prompt-contract value of 40 chars. */
const LABEL_BYTE_CAP = 80;

const OPEN_SENTINEL = "---KEYVALUES---";
const CLOSE_SENTINEL = "---END---";

/**
 * Why a candidate row failed to parse. Surfaces to the caller via
 * `SentinelParseResult.malformed[]` so ops dashboards can attribute
 * partial failures (mixed valid + invalid rows) without the silent
 * drops the v1.4.22 W3 implementation paid.
 *
 * - `missing_colon`         — line had no `:` separator.
 * - `value_overflow`        — value exceeded `VALUE_BYTE_CAP`.
 * - `label_overflow`        — label exceeded `LABEL_BYTE_CAP`.
 * - `no_END_marker`         — the closing `---END---` was missing.
 * - `byte_overflow`         — block exceeded `SENTINEL_BYTE_CAP`.
 * - `schema_invalid`        — row passed shape but Zod rejected it
 *                             (e.g. empty value after stripping).
 */
export type SentinelMalformedReason =
  | "missing_colon"
  | "value_overflow"
  | "label_overflow"
  | "no_END_marker"
  | "byte_overflow"
  | "schema_invalid";

export interface SentinelMalformedEntry {
  rawLine: string;
  reason: SentinelMalformedReason;
}

/**
 * Result of parsing one body line. Either returns the `CoachKeyValue`
 * shape or a typed reason the line failed (so the caller can surface
 * partial-failure observability in the wide-event annotation).
 */
export type LineParseOutcome =
  | { ok: true; value: CoachKeyValue }
  | { ok: false; reason: SentinelMalformedReason };

/**
 * Parse one body line of the form
 *   `<label>: <value> [<unit>] (<window>)`
 * into a `CoachKeyValue`. The unit + window are both optional; an
 * input missing either or both still parses cleanly. Returns
 * `{ ok: false, reason }` when the line does not match the expected
 * shape — the caller now records the malformed row rather than
 * silently dropping it (v1.4.23 H1).
 */
export function tryParseKeyValueLine(line: string): LineParseOutcome {
  const trimmed = line.trim();
  if (!trimmed) return { ok: false, reason: "missing_colon" };

  // Find the first `:` — the label cannot itself contain `:`. The
  // remainder may carry the value, an optional `[unit]`, and an
  // optional `(window)`.
  const colon = trimmed.indexOf(":");
  if (colon < 1) return { ok: false, reason: "missing_colon" };

  const label = trimmed.slice(0, colon).trim();
  let rest = trimmed.slice(colon + 1).trim();
  if (!label) return { ok: false, reason: "missing_colon" };
  if (!rest) return { ok: false, reason: "schema_invalid" };
  if (label.length > LABEL_BYTE_CAP) {
    return { ok: false, reason: "label_overflow" };
  }

  let unit: string | undefined;
  let window: string | undefined;

  // Extract (window) if present at the very end. We allow the unit
  // bracket to follow either the value or the window-paren — both
  // emit orders show up across English/German few-shot examples.
  const winMatch = rest.match(/\s*\(([^()]+)\)\s*$/);
  if (winMatch) {
    window = winMatch[1].trim();
    rest = rest.slice(0, winMatch.index).trim();
  }

  // Extract [unit] if present at the end (after the optional window
  // strip).
  const unitMatch = rest.match(/\s*\[([^[\]]+)\]\s*$/);
  if (unitMatch) {
    unit = unitMatch[1].trim();
    rest = rest.slice(0, unitMatch.index).trim();
  }

  const value = rest.trim();
  if (!value) return { ok: false, reason: "schema_invalid" };
  if (value.length > VALUE_BYTE_CAP) {
    return { ok: false, reason: "value_overflow" };
  }

  const parsed = coachKeyValueSchema.safeParse({
    label,
    value,
    ...(unit ? { unit } : {}),
    ...(window ? { window } : {}),
  });
  if (!parsed.success) return { ok: false, reason: "schema_invalid" };
  return { ok: true, value: parsed.data };
}

export interface SentinelParseResult {
  /** Prose with the sentinel block (if any) stripped out. */
  prose: string;
  /** Parsed key/value rows. Empty when no valid sentinel was found. */
  keyValues: CoachKeyValue[];
  /**
   * `true` when the parser saw an opening `---KEYVALUES---` marker
   * but failed to extract a complete + non-empty + well-formed block.
   * Callers log this for ops visibility (graceful degrade).
   */
  malformed: boolean;
  /**
   * Per-line diagnostics for rows the parser skipped — populated even
   * when `keyValues.length > 0` so ops can spot mixed-format drift
   * (v1.4.23 H1). Empty when every body line parsed cleanly.
   *
   * Block-level failures (missing `---END---`, payload truncated to
   * fit the byte cap) land here as a synthetic entry with `rawLine`
   * set to the marker / cap descriptor and the corresponding reason
   * code so the wide-event annotation always carries a typed cause.
   */
  malformedEntries: SentinelMalformedEntry[];
}

/**
 * Split a raw assistant reply into `{ prose, keyValues }`.
 *
 * The streamed prose passed to the client is the `prose` field — the
 * `---KEYVALUES---` block is stripped before any token frame is sent
 * so the user never sees the raw sentinel.
 */
export function parseKeyValuesSentinel(raw: string): SentinelParseResult {
  if (!raw) {
    return { prose: "", keyValues: [], malformed: false, malformedEntries: [] };
  }

  const openIdx = raw.indexOf(OPEN_SENTINEL);
  if (openIdx === -1) {
    return {
      prose: raw,
      keyValues: [],
      malformed: false,
      malformedEntries: [],
    };
  }

  // Everything before the opening marker is prose; trim trailing
  // whitespace introduced by the marker's own leading newline so the
  // bubble doesn't render an extra blank paragraph.
  const prose = raw.slice(0, openIdx).replace(/\s+$/u, "");

  const malformedEntries: SentinelMalformedEntry[] = [];

  const afterOpen = raw.slice(openIdx + OPEN_SENTINEL.length);
  // Look for the closing sentinel; if missing, the block is
  // malformed — fall back to the original prose and emit nothing.
  const closeRel = afterOpen.indexOf(CLOSE_SENTINEL);
  let bodyRaw: string;
  let malformedClose = false;
  if (closeRel === -1) {
    // Treat the rest of the reply as the block body so we can still
    // parse what's there — but flag malformed so the caller knows
    // the contract wasn't fully met.
    bodyRaw = afterOpen;
    malformedClose = true;
    malformedEntries.push({
      rawLine: CLOSE_SENTINEL,
      reason: "no_END_marker",
    });
  } else {
    bodyRaw = afterOpen.slice(0, closeRel);
  }

  // Defence-in-depth: cap the sentinel payload at 1 KB before we
  // bother parsing. An adversarial reply could otherwise pad the
  // block with megabytes of garbage.
  let body = bodyRaw;
  let truncated = false;
  if (body.length > SENTINEL_BYTE_CAP) {
    body = body.slice(0, SENTINEL_BYTE_CAP);
    truncated = true;
    malformedEntries.push({
      rawLine: `<payload truncated at ${SENTINEL_BYTE_CAP} bytes>`,
      reason: "byte_overflow",
    });
  }

  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    // Skip any stray opening / closing markers that landed inside the
    // body (rare but cheap to ignore).
    .filter((l) => l !== OPEN_SENTINEL && l !== CLOSE_SENTINEL);

  const kept: CoachKeyValue[] = [];
  for (const line of lines) {
    if (kept.length >= SENTINEL_LINE_CAP) break;
    const outcome = tryParseKeyValueLine(line);
    if (outcome.ok) {
      kept.push(outcome.value);
    } else {
      malformedEntries.push({ rawLine: line, reason: outcome.reason });
    }
  }

  // Malformed when:
  //   - closing sentinel missing, OR
  //   - block payload was truncated to fit the 1 KB cap, OR
  //   - the block was present but yielded zero valid rows, OR
  //   - any individual row failed to parse (mixed-format drift).
  const malformed =
    malformedClose ||
    truncated ||
    kept.length === 0 ||
    malformedEntries.length > 0;

  return {
    prose,
    keyValues: kept,
    malformed,
    malformedEntries,
  };
}
