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
 *  - One entry per biomarker: its MOST RECENT reading, plus a `history` of the
 *    earlier numeric readings in the same unit when there are any.
 *  - The whole record by default (#1263). Labs are months or years apart, and
 *    a slow drift (LDL, PSA, HbA1c) is only visible across years, so they are
 *    not held to the one-year window that bounds the dense readings. The
 *    person's lookback limit still applies: under "12 months" the block reads
 *    twelve months, as before.
 *  - The history rides only a read for named analytes (`get_labs` with an
 *    `analyte`), never the snapshot: the snapshot shares one size cap with
 *    every other block and labs are never shed from it, so it keeps the
 *    latest reading per marker. A history is summarised, not dumped: the
 *    newest `LAB_HISTORY_RECENT_POINTS` earlier readings in full, everything
 *    older folded into one mean / min / max / count per calendar year, at
 *    most `LAB_HISTORY_MAX_YEARS` years (older years are counted, not
 *    listed).
 *  - At most `MAX_BIOMARKERS` biomarkers, the most recently measured first,
 *    and at most `MAX_ROWS` rows read, so a heavy history can never balloon
 *    the prompt.
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
 * the Prisma `where` field-by-field; it is never an input. Like the illness
 * block it is module-gated: with the `labs` module off the block is `null`
 * and no lab row is read, so neither the Coach prompt nor its `get_labs` tool
 * sees a value. It used to ride regardless, a decision from before Labs could
 * be switched off; the data routes (`/api/labs`) stay ungated, because a
 * module decides what a model is given, not what the owner can read.
 */
import { sameLabUnit } from "@/lib/labs/unit-normalise";
import {
  UNBOUNDED_REACH,
  reachFloor,
  type CoachHistoryReach,
} from "./history-reach";
import { classifyAgainstEffectiveRange } from "@/lib/labs/reference-range";
import { resolveLabFields } from "@/lib/labs/serialise";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/gate";

/** Cap on distinct biomarkers in the block (newest reading first). */
const MAX_BIOMARKERS = 24;

/** Earlier readings per biomarker carried in full, beside the latest. */
export const LAB_HISTORY_RECENT_POINTS = 5;

/** Calendar years of yearly aggregates per biomarker, newest first. */
export const LAB_HISTORY_MAX_YEARS = 10;

/**
 * Rows the block reads at most, newest first. A guard rather than a budget:
 * forty markers four times a year for twenty years is 3 200 rows, and the
 * shaping below keeps the prompt bounded whatever comes back.
 */
const MAX_ROWS = 4_000;

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

/** One earlier numeric reading of a biomarker. */
export interface CoachLabHistoryPoint {
  value: number;
  /** in-range / below / above / unknown against that reading's own bounds. */
  rangeStatus: "in-range" | "below" | "above" | "unknown";
  takenAt: string;
}

/** The readings of one calendar year (UTC), folded. */
export interface CoachLabYear {
  year: number;
  count: number;
  mean: number;
  min: number;
  max: number;
}

/**
 * The earlier numeric readings of a biomarker, in the unit of its latest
 * reading (a reading stored in another unit is left out rather than mixed in).
 */
export interface CoachLabHistory {
  /** Numeric readings in the window, the latest included. */
  count: number;
  /** The oldest of them. */
  firstTakenAt: string;
  /** The newest earlier readings in full, newest first, the latest excluded. */
  earlier: CoachLabHistoryPoint[];
  /** The readings older than `earlier`, one entry per year, newest first. */
  yearly: CoachLabYear[];
  /** Years older than the listed ones that hold readings, counted only. */
  yearsOmitted: number;
}

export interface CoachLabsBlock {
  /** Most-recent reading per biomarker, newest first; bounded. */
  recent: Array<CoachLabReading & { history?: CoachLabHistory }>;
}

/** One numeric reading as the history shaping sees it. */
export interface LabHistoryInput {
  value: number;
  takenAt: Date;
  rangeStatus: CoachLabHistoryPoint["rangeStatus"];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Shape a biomarker's earlier readings (newest first, the latest excluded)
 * into the bounded `history`. `null` when there are none. Pure, so the bound
 * is testable without a database.
 */
export function shapeLabHistory(
  latestTakenAt: Date,
  earlier: readonly LabHistoryInput[],
): CoachLabHistory | null {
  if (earlier.length === 0) return null;
  const listed = earlier.slice(0, LAB_HISTORY_RECENT_POINTS);
  const folded = earlier.slice(LAB_HISTORY_RECENT_POINTS);
  const byYear = new Map<number, number[]>();
  for (const reading of folded) {
    const year = reading.takenAt.getUTCFullYear();
    const values = byYear.get(year);
    if (values) values.push(reading.value);
    else byYear.set(year, [reading.value]);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  const yearly = years.slice(0, LAB_HISTORY_MAX_YEARS).map((year) => {
    const values = byYear.get(year) ?? [];
    return {
      year,
      count: values.length,
      mean: round2(values.reduce((sum, v) => sum + v, 0) / values.length),
      min: Math.min(...values),
      max: Math.max(...values),
    };
  });
  const oldest = earlier[earlier.length - 1]?.takenAt ?? latestTakenAt;
  return {
    count: earlier.length + 1,
    firstTakenAt: oldest.toISOString(),
    earlier: listed.map((reading) => ({
      value: reading.value,
      rangeStatus: reading.rangeStatus,
      takenAt: reading.takenAt.toISOString(),
    })),
    yearly,
    yearsOmitted: Math.max(0, years.length - LAB_HISTORY_MAX_YEARS),
  };
}

/**
 * Build the labs context block, or `null` when the account has no readings in
 * the lookback window. Selects label + value + resolved bounds + dates only —
 * `noteEncrypted` is never selected.
 */
export async function buildLabsSnapshotBlock(
  userId: string,
  now: Date = new Date(),
  /** The Coach's lookback limit; without one the whole record is read. */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
  options: {
    /**
     * Only the markers whose resolved name contains this text (lower-cased),
     * matched before the marker cap so a rarely measured one is still found.
     * With it, each entry carries its `history`.
     */
    analyte?: string;
  } = {},
): Promise<CoachLabsBlock | null> {
  if (!(await isModuleEnabled(userId, "labs"))) return null;
  const wanted = options.analyte?.trim().toLowerCase() || null;
  const floor = reachFloor(reach, now);

  // Newest reading first: the first row seen per biomarker is its MOST RECENT
  // value, every later row of it feeds its history. Field-by-field `where` —
  // never a spread.
  //
  // With an analyte the match runs in SQL, before the row cap: matched in
  // memory after it, the newest rows of every other marker used up the cap,
  // and the asked-for marker lost its older readings (or vanished) without a
  // word. A row's resolved name is its biomarker's when it is linked, its own
  // otherwise; the in-memory check below stays the final word.
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      takenAt: floor ? { gte: floor, lte: now } : { lte: now },
      OR: wanted
        ? [
            {
              biomarkerId: null,
              analyte: { contains: wanted, mode: "insensitive" },
            },
            { biomarker: { name: { contains: wanted, mode: "insensitive" } } },
          ]
        : undefined,
    },
    orderBy: { takenAt: "desc" },
    take: MAX_ROWS,
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
      sourceUnit: true,
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
  // key sighting is the latest reading and every later one is history.
  const entries = new Map<
    string,
    {
      reading: CoachLabReading;
      unit: string;
      takenAt: Date;
      earlier: LabHistoryInput[];
    }
  >();
  for (const row of rows) {
    const resolved = resolveLabFields(row, row.biomarker);
    if (wanted && !resolved.analyte.toLowerCase().includes(wanted)) continue;
    const key = row.biomarkerId ?? `analyte:${resolved.analyte.toLowerCase()}`;
    const existing = entries.get(key);
    if (existing) {
      // One unit written two ways ("mg/dl", "mg/dL") is one series.
      if (
        wanted &&
        row.value !== null &&
        sameLabUnit(resolved.unit, existing.unit)
      ) {
        existing.earlier.push({
          value: row.value,
          takenAt: row.takenAt,
          rangeStatus: classifyAgainstEffectiveRange(
            row.value,
            resolved.effectiveRange,
          ),
        });
      }
      continue;
    }
    if (entries.size >= MAX_BIOMARKERS) continue;

    entries.set(key, {
      unit: resolved.unit,
      takenAt: row.takenAt,
      earlier: [],
      reading: {
        // v1.30.25 — analyte / panel / unit are NOT server-authored. A lab row
        // committed from an uploaded document carries the name a model
        // transcribed out of that PDF (`resolveOrMintBiomarker` stores it
        // verbatim as `Biomarker.name`), so a hostile document chooses this
        // string. It reaches BOTH the snapshot prompt and the `labs_read`
        // tool result, so it is sanitised HERE at the shared source rather
        // than at either consumer. `sanitizeForPrompt` strips control chars
        // and the instruction-shaped patterns; the fence around the block
        // carries the data/instruction contract.
        analyte: sanitizeForPrompt(resolved.analyte, MAX_ANALYTE_CHARS),
        panel: resolved.panel
          ? sanitizeForPrompt(resolved.panel, MAX_ANALYTE_CHARS)
          : null,
        value: row.value,
        valueText: row.valueText ? sanitizeValueText(row.valueText) : null,
        unit: sanitizeForPrompt(resolved.unit, MAX_UNIT_CHARS),
        referenceLow: resolved.referenceLow,
        referenceHigh: resolved.referenceHigh,
        // A qualitative row has nothing to compare against the bounds →
        // neutral "unknown", never a fabricated verdict. A numeric row
        // classifies against the window in force for it — the report's own
        // range when it carries one, the catalog band otherwise. Same rule as
        // every other lab surface.
        rangeStatus: classifyAgainstEffectiveRange(
          row.value,
          resolved.effectiveRange,
        ),
        takenAt: row.takenAt.toISOString(),
      },
    });
  }

  const recent: CoachLabsBlock["recent"] = [];
  for (const entry of entries.values()) {
    // History is numeric and in the latest reading's unit; a qualitative
    // latest reading has no unit to hold the earlier values to. Collected
    // only for a named read (see the header).
    const history =
      wanted && entry.reading.value !== null
        ? shapeLabHistory(entry.takenAt, entry.earlier)
        : null;
    recent.push(history ? { ...entry.reading, history } : entry.reading);
  }

  if (recent.length === 0) return null;

  return { recent };
}
