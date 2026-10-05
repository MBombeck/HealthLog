/**
 * v1.18.11 (#65) — lab-result context block for the Coach snapshot.
 *
 * Lets the Coach answer "what was my LDL last time" / "is my ferritin in
 * range" from the user's own LabResult rows instead of guessing. The block is
 * SERVER-AUTHORITATIVE and GROUNDED: each biomarker carries the canonical
 * name, value, unit, resolved reference bounds, the in/out-of-range verdict,
 * and the measured date — all computed from the DB via the same resolver the
 * Labs API + doctor-report PDF use (`resolveLabFields` / `classifyReferenceRange`),
 * never re-derived. The Coach reads these numbers verbatim and must not invent
 * a lab value the block does not carry.
 *
 * Bounding (no unbounded history dump):
 *  - MOST RECENT reading per biomarker only (one row per analyte).
 *  - Last `LOOKBACK_MONTHS` months — stale panels do not enter the prompt.
 *  - At most `MAX_BIOMARKERS` biomarkers, newest reading first, so a heavy
 *    history can never balloon the prompt.
 *
 * Qualitative readings (`value` null, `valueText` "negativ" / …) are included
 * with a neutral `"unknown"` range status — there is nothing to compare against
 * the bounds, so no in/out verdict is fabricated. The encrypted `noteEncrypted`
 * column is never selected — the decrypted note must not reach the prompt.
 *
 * v1.30.25 — every free-text string in this block is sanitised, not just
 * `valueText`. The header used to claim `valueText` was "the one
 * user-controlled string here"; that was wrong. `analyte`, `panel` and `unit`
 * are equally attacker-reachable and, unlike `valueText`, they are not even
 * self-scoped: a lab row committed from an uploaded document carries whatever
 * name a model transcribed out of that PDF, stored verbatim as
 * `Biomarker.name` by `resolveOrMintBiomarker`. The document is the untrusted
 * party, not the user. These fields feed BOTH the snapshot prompt and the
 * `labs_read` tool result, so sanitisation lives here at the shared source.
 *
 * `userId` is narrowed from the authenticated session by the caller and feeds
 * the Prisma `where` field-by-field; it is never an input. Unlike the illness
 * block, Labs is intentionally NOT module-gated (mirrors `/api/labs` — the data
 * is always owner-scoped and safe to read), so the block is `null` only when the
 * account has no recent readings.
 */
import {
  COACH_LABS_LOOKBACK_MONTHS,
  UNBOUNDED_REACH,
  laterOfFloor,
  type CoachHistoryReach,
} from "./history-reach";
import { classifyAgainstEffectiveRange } from "@/lib/labs/reference-range";
import { resolveLabFields } from "@/lib/labs/serialise";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { prisma } from "@/lib/db";

/** Only readings within this many months enter the prompt. */
const LOOKBACK_MONTHS = COACH_LABS_LOOKBACK_MONTHS;

/** Cap on distinct biomarkers in the block (newest reading first). */
const MAX_BIOMARKERS = 24;

/** Max chars of the user-supplied qualitative `valueText` that may enter the prompt. */
const MAX_VALUE_TEXT_CHARS = 60;

/** Max chars of the document-sourced analyte / panel name that may enter the prompt. */
const MAX_ANALYTE_CHARS = 80;

/** Max chars of the document-sourced unit that may enter the prompt. */
const MAX_UNIT_CHARS = 24;

/**
 * Cap + strip the user-supplied qualitative result text before it enters the
 * Coach LLM prompt. `valueText` is the one user-controlled string in this
 * block, so it is a (self-scoped) prompt-injection surface: collapse control
 * chars + newlines to spaces so an embedded "ignore previous instructions\n…"
 * can't reshape the prompt structure, then bound the length. Mirrors
 * `sanitizeLabel` in `illness-snapshot.ts`.
 */
export function sanitizeValueText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE_TEXT_CHARS);
}

/** One biomarker's most-recent resolved reading. */
export interface CoachLabReading {
  /** Canonical analyte name (resolved from the linked biomarker when present). */
  analyte: string;
  /** Panel grouping, when the resolved marker carries one. */
  panel: string | null;
  /** Numeric reading; null for a qualitative row (see `valueText`). */
  value: number | null;
  /** Qualitative result text ("negativ" / …); null for a numeric row. */
  valueText: string | null;
  /** Resolved unit; empty for a qualitative marker. */
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** in-range / below / above / unknown — computed from the resolved bounds. */
  rangeStatus: "in-range" | "below" | "above" | "unknown";
  /** Measured date (ISO). */
  takenAt: string;
}

export interface CoachLabsBlock {
  /** Most-recent reading per biomarker, newest first; bounded. */
  recent: CoachLabReading[];
}

/**
 * Build the labs context block, or `null` when the account has no readings in
 * the lookback window. Selects label + value + resolved bounds + dates only —
 * `noteEncrypted` is never selected.
 */
export async function buildLabsSnapshotBlock(
  userId: string,
  now: Date = new Date(),
  /** The Coach's lookback limit: the shorter of it and the 12 months wins. */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<CoachLabsBlock | null> {
  const monthsBack = new Date(now);
  monthsBack.setMonth(monthsBack.getMonth() - LOOKBACK_MONTHS);
  const cutoff = laterOfFloor(monthsBack, reach, now);

  // Newest reading first; we keep only the first row seen per biomarker so the
  // block carries the MOST RECENT value per analyte. Bounded fetch: at most a
  // reading per capped biomarker plus headroom for older duplicates of the same
  // marker. Field-by-field `where` — never a spread.
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      takenAt: { gte: cutoff, lte: now },
    },
    orderBy: { takenAt: "desc" },
    take: MAX_BIOMARKERS * 8,
    select: {
      analyte: true,
      panel: true,
      value: true,
      valueText: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      sourceReferenceLow: true,
      sourceReferenceHigh: true,
      sourceReferenceText: true,
      takenAt: true,
      biomarkerId: true,
      biomarker: {
        select: {
          id: true,
          name: true,
          unit: true,
          lowerBound: true,
          upperBound: true,
          panel: true,
        },
      },
    },
  });

  if (rows.length === 0) return null;

  // De-dup to the most-recent reading per biomarker. Key on the linked
  // biomarker id when present (the canonical identity); fall back to the
  // lower-cased resolved analyte for any legacy unlinked row so two spellings
  // of the same marker still collapse. Rows arrive newest-first, so the first
  // key sighting wins.
  const seen = new Set<string>();
  const recent: CoachLabReading[] = [];
  for (const row of rows) {
    const resolved = resolveLabFields(row, row.biomarker);
    const key = row.biomarkerId ?? `analyte:${resolved.analyte.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    recent.push({
      // v1.30.25 — analyte / panel / unit are NOT server-authored. A lab row
      // committed from an uploaded document carries the name a model
      // transcribed out of that PDF (`resolveOrMintBiomarker` stores it
      // verbatim as `Biomarker.name`), so a hostile document chooses this
      // string. It reaches BOTH the snapshot prompt and the `labs_read` tool
      // result, so it is sanitised HERE at the shared source rather than at
      // either consumer. `sanitizeForPrompt` strips control chars and the
      // instruction-shaped patterns; the fence around the block carries the
      // data/instruction contract.
      analyte: sanitizeForPrompt(resolved.analyte, MAX_ANALYTE_CHARS),
      panel: resolved.panel
        ? sanitizeForPrompt(resolved.panel, MAX_ANALYTE_CHARS)
        : null,
      value: row.value,
      valueText: row.valueText ? sanitizeValueText(row.valueText) : null,
      unit: sanitizeForPrompt(resolved.unit, MAX_UNIT_CHARS),
      referenceLow: resolved.referenceLow,
      referenceHigh: resolved.referenceHigh,
      // A qualitative row has nothing to compare against the bounds → neutral
      // "unknown", never a fabricated verdict. A numeric row classifies against
      // the window in force for it — the report's own range when it carries
      // one, the catalog band otherwise. Same rule as every other lab surface.
      rangeStatus: classifyAgainstEffectiveRange(
        row.value,
        resolved.effectiveRange,
      ),
      takenAt: row.takenAt.toISOString(),
    });

    if (recent.length >= MAX_BIOMARKERS) break;
  }

  if (recent.length === 0) return null;

  return { recent };
}
