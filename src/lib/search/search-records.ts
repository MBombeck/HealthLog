/**
 * The in-app record search behind `POST /api/search` (Discussion #1117): one
 * query over visits, conditions, documents, vaccinations, lab results,
 * medications, symptoms, workouts and the free-text notes on mood entries,
 * readings and illness days, each hit with the in-app path that opens it.
 *
 * Most of the record is ciphertext at rest, so matching cannot run in SQL.
 * The search reads the record's own rows newest first, decrypts them here and
 * matches them with the shared matcher (`./match.ts`, the one the MCP
 * `search` tool uses). The four clinical kinds come from the MCP module's own
 * reads (`loadRecordCandidates`); the rest are read here in batches.
 *
 * Bounds, so a large record cannot take the heap or the pool down:
 *
 *   - every batched source reads at most `MAX_SCAN_ROWS_PER_SOURCE` rows, in
 *     batches of `SCAN_BATCH`, and stops as soon as it holds more hits than
 *     the caller's limit (newest first, so those are the newest matches);
 *   - one search shares a time budget (`SEARCH_TIME_BUDGET_MS`); a source
 *     checks it before every batch and stops when it has run out, the
 *     clinical kinds check it before every row they decrypt, and a source
 *     that has not started yet when it runs out is not started at all;
 *   - the request's abort signal ends the search the same way: a client that
 *     typed on, or a newer search by the same actor, stops this one;
 *   - at most `SOURCE_CONCURRENCY` sources read at once, so one search holds
 *     a few pool connections, not one per table;
 *   - only matching rows are kept: a batch's decrypted text is dropped once
 *     the batch is matched.
 *
 * When a cap or the budget cut a source short the answer says `truncated`.
 *
 * Plaintext columns that are indexable (a lab's analyte, a medication's name,
 * a workout's sport) are read whole and matched here as well, so the folding
 * is the same for every kind: "Schulter", "schulter" and "Schülter" are one
 * word to the search whichever column holds it.
 *
 * Nothing here logs the query or any record text. The route annotates the
 * query's length and the counts only.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { readNote } from "@/lib/crypto/note-cipher";
import { prisma } from "@/lib/db";
import {
  decryptIndexText,
  decryptVerbatimText,
} from "@/lib/documents/content-index";
import { normalizeSearchText } from "@/lib/encounters/procedures";
import { dayHref, labHref, moodDayHref, recordHref } from "@/lib/links/hrefs";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { loadRecordCandidates, type RecordKind } from "@/lib/mcp/record-search";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";
import type { ShareScope } from "@/lib/sharing/scope";
import { userDayKey } from "@/lib/tz/format";

import {
  SEARCH_HIT_KINDS,
  type SearchGroup,
  type SearchHit,
  type SearchHitKind,
  type SearchMarkedText,
  type SearchNoteSource,
  type SearchResponse,
} from "./contract";
import {
  isHit,
  marked,
  queryWords,
  scoreCandidate,
  snippetOf,
  WEIGHT,
  type SearchCandidate,
} from "./match";
import {
  SEARCH_SOURCE_DOMAIN,
  SEARCH_SOURCE_KEYS,
  SEARCH_SOURCE_KIND,
  type SearchSourceKey,
} from "./sources";

// ── Bounds ───────────────────────────────────────────────────────────

/** Rows one batched source reads per round trip. */
export const SCAN_BATCH = 250;
/** Rows one batched source reads at most, per search. */
export const MAX_SCAN_ROWS_PER_SOURCE = 5000;
/**
 * Newest rows of each clinical kind (visits, conditions, documents,
 * vaccinations) one search reads. Wider than the MCP bound: a person's own
 * search is asked about the operation of ten years ago.
 */
export const RECORD_ROWS_PER_KIND = 2000;
/** Wall-clock budget one search shares across its sources. */
export const SEARCH_TIME_BUDGET_MS = 1500;
/** Sources that read at the same time. */
export const SOURCE_CONCURRENCY = 4;
/** Plaintext name rows (analytes, medications, symptom names) read at most. */
const MAX_NAME_ROWS = 1000;
/** Documents whose indexed text is opened for a snippet, per answer. */
const MAX_DOCUMENT_SNIPPETS = 5;

// ── The scan ─────────────────────────────────────────────────────────

/** Shared by every source of one search. */
export interface ScanBudget {
  readonly deadline: number;
  readonly now: () => number;
  /** Aborted when nobody waits for the answer any more. */
  readonly signal?: AbortSignal;
  /** A cap or the deadline stopped a source before it read everything. */
  truncated: boolean;
  /** Rows read, for the annotation. */
  rows: number;
}

/** The search may not read any further: out of time, or abandoned. */
export function budgetSpent(budget: ScanBudget): boolean {
  return budget.signal?.aborted === true || budget.now() >= budget.deadline;
}

/**
 * Read a source newest first in batches until it is exhausted, holds more
 * than `wanted` hits, has read `maxRows` rows or the budget has run out.
 * `read` pages by the last row's id (Prisma cursor over a stable order);
 * `match` turns a row into a candidate that is a hit, or null.
 */
export async function scanNewest<Row extends { id: string }>(args: {
  budget: ScanBudget;
  wanted: number;
  maxRows?: number;
  batch?: number;
  read: (cursor: string | null, take: number) => Promise<Row[]>;
  match: (row: Row) => SearchCandidate | null;
}): Promise<SearchCandidate[]> {
  const { budget, wanted, read, match } = args;
  const maxRows = args.maxRows ?? MAX_SCAN_ROWS_PER_SOURCE;
  const batch = args.batch ?? SCAN_BATCH;
  const out: SearchCandidate[] = [];
  let cursor: string | null = null;
  let scanned = 0;
  for (;;) {
    if (budgetSpent(budget)) {
      budget.truncated = true;
      break;
    }
    const remaining = maxRows - scanned;
    // The batch that reaches the cap asks for one row more than it keeps:
    // that row only answers whether anything is left, so a source holding
    // exactly `maxRows` rows is read whole and not reported cut short.
    const last = remaining <= batch;
    const take = last ? remaining : batch;
    const fetched = await read(cursor, last ? take + 1 : take);
    const more = last && fetched.length > take;
    const rows = more ? fetched.slice(0, take) : fetched;
    scanned += rows.length;
    budget.rows += rows.length;
    for (const row of rows) {
      const candidate = match(row);
      if (candidate) out.push(candidate);
    }
    if (more) {
      budget.truncated = true;
      break;
    }
    // A short batch, or the cap reached with nothing beyond it, is the end
    // of the source.
    if (rows.length < take || last) break;
    // One more than the limit: the caller learns there is more.
    if (out.length > wanted) break;
    cursor = rows[rows.length - 1].id;
  }
  return out;
}

/** Prisma's keyset arguments for `scanNewest`. */
function after(cursor: string | null): {
  cursor?: { id: string };
  skip?: number;
} {
  return cursor ? { cursor: { id: cursor }, skip: 1 } : {};
}

/**
 * Run `tasks` with at most `limit` in flight. A task not yet started when
 * the budget is spent is not started: the search says `truncated` instead.
 */
async function inPool(
  tasks: ReadonlyArray<() => Promise<void>>,
  limit: number,
  budget: ScanBudget,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (budgetSpent(budget)) {
        budget.truncated = true;
        continue;
      }
      await task();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
}

// ── Sources ──────────────────────────────────────────────────────────

interface SearchContext {
  recordId: string;
  query: string;
  words: readonly string[];
  foldedQuery: string;
  wanted: number;
  timezone: string;
  display: Locale;
  modules: SurfaceModuleMap | null;
  budget: ScanBudget;
}

/** Decrypt a free-text `Bytes` column fail-soft: a key gap reads as absent. */
function decryptText(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    const text = decryptFromBytes(value);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** `readNote` fail-soft, for the two columns still carrying a plaintext twin. */
function readNoteSoft(
  ciphertext: Uint8Array | null,
  plaintext: string | null,
): string | null {
  try {
    const text = readNote(ciphertext, plaintext);
    return text?.trim() ? text : null;
  } catch {
    return null;
  }
}

/** The candidate when it is a hit for the context's query, else null. */
function keepIfHit(
  ctx: SearchContext,
  candidate: SearchCandidate,
): SearchCandidate | null {
  return isHit(scoreCandidate(candidate, ctx.words, ctx.foldedQuery))
    ? candidate
    : null;
}

function noteCandidate(args: {
  id: string;
  source: SearchSourceKey;
  recordId: string;
  title: string | null;
  note: string;
  date: Date | null;
  day: string | null;
  path: string;
  noteSource?: SearchNoteSource;
}): SearchCandidate {
  return {
    id: args.id,
    title: args.title ?? "",
    url: args.path,
    kindOrder: 0,
    date: args.date?.getTime() ?? null,
    fields: [{ text: args.note, weight: WEIGHT.tertiary, body: true }],
    hit: {
      kind: SEARCH_SOURCE_KIND[args.source],
      recordId: args.recordId,
      title: args.title,
      context: [],
      day: args.day,
      path: args.path,
      ...(args.noteSource ? { source: args.noteSource } : {}),
    },
  };
}

async function labAnalyteCandidates(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const rows = await prisma.labResult.groupBy({
    by: ["analyte"],
    where: { userId: ctx.recordId, deletedAt: null },
    _max: { takenAt: true },
    orderBy: { _max: { takenAt: "desc" } },
    take: MAX_NAME_ROWS,
  });
  ctx.budget.rows += rows.length;
  return rows.flatMap((row) => {
    const latest = row._max.takenAt;
    const path = recordHref("analyte", row.analyte);
    const candidate = keepIfHit(ctx, {
      id: `labAnalyte:${row.analyte}`,
      title: row.analyte,
      url: path,
      kindOrder: 0,
      date: latest?.getTime() ?? null,
      fields: [{ text: row.analyte, weight: WEIGHT.primary }],
      hit: {
        kind: "lab",
        recordId: row.analyte,
        title: row.analyte,
        context: [],
        day: latest ? userDayKey(latest, ctx.timezone) : null,
        path,
      },
    });
    return candidate ? [candidate] : [];
  });
}

function labNoteCandidates(ctx: SearchContext): Promise<SearchCandidate[]> {
  return scanNewest({
    budget: ctx.budget,
    wanted: ctx.wanted,
    read: (cursor, take) =>
      prisma.labResult.findMany({
        where: {
          userId: ctx.recordId,
          deletedAt: null,
          noteEncrypted: { not: null },
        },
        select: {
          id: true,
          analyte: true,
          biomarkerId: true,
          takenAt: true,
          noteEncrypted: true,
        },
        orderBy: [{ takenAt: "desc" }, { id: "desc" }],
        take,
        ...after(cursor),
      }),
    match: (row) => {
      const note = decryptText(row.noteEncrypted);
      if (!note) return null;
      return keepIfHit(
        ctx,
        noteCandidate({
          id: `labNote:${row.id}`,
          source: "labNote",
          recordId: row.id,
          title: row.analyte,
          note,
          date: row.takenAt,
          day: userDayKey(row.takenAt, ctx.timezone),
          path: labHref(row),
        }),
      );
    },
  });
}

async function medicationCandidates(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const rows = await prisma.medication.findMany({
    where: { userId: ctx.recordId },
    select: { id: true, name: true, dose: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: MAX_NAME_ROWS,
  });
  ctx.budget.rows += rows.length;
  return rows.flatMap((row) => {
    const path = recordHref("medication", row.id);
    const candidate = keepIfHit(ctx, {
      id: `medication:${row.id}`,
      title: row.name,
      url: path,
      kindOrder: 0,
      date: row.createdAt.getTime(),
      fields: [
        { text: row.name, weight: WEIGHT.primary },
        { text: row.dose, weight: WEIGHT.secondary },
      ],
      hit: {
        kind: "medication",
        recordId: row.id,
        title: row.name,
        context: row.dose.trim() ? [row.dose.trim()] : [],
        day: null,
        path,
      },
    });
    return candidate ? [candidate] : [];
  });
}

/** The record's symptom names, decrypted once per search. */
function symptomLabels(
  ctx: SearchContext,
): () => Promise<Map<string, string | null>> {
  let pending: Promise<Map<string, string | null>> | null = null;
  return () => {
    pending ??= prisma.symptomDefinition
      .findMany({
        where: { userId: ctx.recordId },
        select: { id: true, labelEncrypted: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: MAX_NAME_ROWS,
      })
      .then((rows) => {
        ctx.budget.rows += rows.length;
        return new Map(
          rows.map((row) => [row.id, decryptText(row.labelEncrypted)]),
        );
      });
    return pending;
  };
}

async function symptomCandidates(
  ctx: SearchContext,
  labels: () => Promise<Map<string, string | null>>,
): Promise<SearchCandidate[]> {
  const byId = await labels();
  return [...byId].flatMap(([id, label]) => {
    if (!label) return [];
    const path = recordHref("symptom", id);
    const candidate = keepIfHit(ctx, {
      id: `symptom:${id}`,
      title: label,
      url: path,
      kindOrder: 0,
      date: null,
      fields: [{ text: label, weight: WEIGHT.primary }],
      hit: {
        kind: "symptom",
        recordId: id,
        title: label,
        context: [],
        day: null,
        path,
      },
    });
    return candidate ? [candidate] : [];
  });
}

async function symptomNoteCandidates(
  ctx: SearchContext,
  labels: () => Promise<Map<string, string | null>>,
): Promise<SearchCandidate[]> {
  const byId = await labels();
  return scanNewest({
    budget: ctx.budget,
    wanted: ctx.wanted,
    read: (cursor, take) =>
      prisma.symptomEvent.findMany({
        where: {
          userId: ctx.recordId,
          deletedAt: null,
          noteEncrypted: { not: null },
        },
        select: {
          id: true,
          definitionId: true,
          occurredAt: true,
          noteEncrypted: true,
        },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take,
        ...after(cursor),
      }),
    match: (row) => {
      const note = decryptText(row.noteEncrypted);
      if (!note) return null;
      const day = userDayKey(row.occurredAt, ctx.timezone);
      return keepIfHit(
        ctx,
        noteCandidate({
          id: `symptomNote:${row.id}`,
          source: "symptomNote",
          recordId: row.id,
          title: byId.get(row.definitionId) ?? null,
          note,
          date: row.occurredAt,
          day,
          path: dayHref("illness", day),
        }),
      );
    },
  });
}

/** "stairClimber" → "stair climber". */
function sportWords(sportType: string): string {
  return sportType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

/** The sport's name in the display language, else its words. */
function sportLabel(sportType: string, locale: Locale): string {
  const key = `insights.workouts.sport.${sportType}`;
  const label = getServerTranslator(locale).t(key);
  return label === key ? sportWords(sportType) : label;
}

async function workoutCandidates(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  const types = await prisma.workout.groupBy({
    by: ["sportType"],
    where: { userId: ctx.recordId },
  });
  ctx.budget.rows += types.length;
  // A sport matches by its name in the display language, in English and as
  // its enum words, so "laufen", "running" and "run" all find a run.
  const matched = types
    .map((t) => t.sportType)
    .filter((sportType) =>
      keepIfHit(ctx, {
        id: sportType,
        title: sportType,
        url: "",
        kindOrder: 0,
        date: null,
        fields: [
          {
            text: [
              sportLabel(sportType, ctx.display),
              sportLabel(sportType, "en"),
              sportWords(sportType),
            ].join(" "),
            weight: WEIGHT.primary,
          },
        ],
      }),
    );
  if (matched.length === 0) return [];
  const rows = await prisma.workout.findMany({
    where: { userId: ctx.recordId, sportType: { in: matched } },
    select: { id: true, sportType: true, startedAt: true },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: ctx.wanted + 1,
  });
  ctx.budget.rows += rows.length;
  return rows.map((row) => {
    const path = recordHref("workout", row.id);
    const label = sportLabel(row.sportType, ctx.display);
    return {
      id: `workout:${row.id}`,
      title: label,
      url: path,
      kindOrder: 0,
      date: row.startedAt.getTime(),
      fields: [
        {
          text: [
            label,
            sportLabel(row.sportType, "en"),
            sportWords(row.sportType),
          ].join(" "),
          weight: WEIGHT.primary,
        },
      ],
      hit: {
        kind: "workout",
        recordId: row.id,
        title: label,
        context: [],
        day: userDayKey(row.startedAt, ctx.timezone),
        path,
      },
    };
  });
}

function moodNoteCandidates(ctx: SearchContext): Promise<SearchCandidate[]> {
  return scanNewest({
    budget: ctx.budget,
    wanted: ctx.wanted,
    read: (cursor, take) =>
      prisma.moodEntry.findMany({
        where: {
          userId: ctx.recordId,
          deletedAt: null,
          OR: [{ noteEncrypted: { not: null } }, { note: { not: null } }],
        },
        select: {
          id: true,
          date: true,
          moodLoggedAt: true,
          note: true,
          noteEncrypted: true,
        },
        orderBy: [{ moodLoggedAt: "desc" }, { id: "desc" }],
        take,
        ...after(cursor),
      }),
    match: (row) => {
      const note = readNoteSoft(row.noteEncrypted, row.note);
      if (!note) return null;
      return keepIfHit(
        ctx,
        noteCandidate({
          id: `moodNote:${row.id}`,
          source: "moodNote",
          recordId: row.id,
          title: null,
          note,
          date: row.moodLoggedAt,
          day: row.date,
          path: moodDayHref(row.date),
          noteSource: "mood",
        }),
      );
    },
  });
}

function illnessNoteCandidates(ctx: SearchContext): Promise<SearchCandidate[]> {
  return scanNewest({
    budget: ctx.budget,
    wanted: ctx.wanted,
    read: (cursor, take) =>
      prisma.illnessDayLog.findMany({
        where: {
          userId: ctx.recordId,
          deletedAt: null,
          noteEncrypted: { not: null },
          episode: { deletedAt: null },
        },
        select: {
          id: true,
          date: true,
          noteEncrypted: true,
          episode: { select: { id: true, label: true } },
        },
        orderBy: [{ date: "desc" }, { id: "desc" }],
        take,
        ...after(cursor),
      }),
    match: (row) => {
      const note = decryptText(row.noteEncrypted);
      if (!note) return null;
      return keepIfHit(
        ctx,
        noteCandidate({
          id: `illnessNote:${row.id}`,
          source: "illnessNote",
          recordId: row.id,
          title: row.episode.label,
          note,
          // The day log's own calendar date; noon keeps the sort stable.
          date: new Date(`${row.date}T12:00:00Z`),
          day: row.date,
          path: recordHref("illness", row.episode.id),
          noteSource: "illness",
        }),
      );
    },
  });
}

function measurementNoteCandidates(
  ctx: SearchContext,
): Promise<SearchCandidate[]> {
  // A note on a reading follows the module of the reading's type.
  const typeVisible = (type: MeasurementType): boolean => {
    const owner = moduleForMeasurementType(type);
    return owner === null || ctx.modules?.[owner] !== false;
  };
  return scanNewest({
    budget: ctx.budget,
    wanted: ctx.wanted,
    // Served by the partial index `measurements_noted_live_idx` (migration
    // 0397): only live rows that carry a note, so a record of millions of
    // readings with a handful of notes reads the handful.
    read: (cursor, take) =>
      prisma.measurement.findMany({
        where: {
          userId: ctx.recordId,
          deletedAt: null,
          OR: [{ notesEncrypted: { not: null } }, { notes: { not: null } }],
        },
        select: {
          id: true,
          type: true,
          measuredAt: true,
          notes: true,
          notesEncrypted: true,
        },
        orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        take,
        ...after(cursor),
      }),
    match: (row) => {
      if (!typeVisible(row.type)) return null;
      const note = readNoteSoft(row.notesEncrypted, row.notes);
      if (!note) return null;
      const day = userDayKey(row.measuredAt, ctx.timezone);
      return keepIfHit(
        ctx,
        noteCandidate({
          id: `measurementNote:${row.id}`,
          source: "measurementNote",
          recordId: row.id,
          title: null,
          note,
          date: row.measuredAt,
          day,
          path: dayHref("measurements", day),
          noteSource: "measurement",
        }),
      );
    },
  });
}

// ── Ranking and the answer ───────────────────────────────────────────

const RECORD_SOURCES: ReadonlyArray<SearchSourceKey & RecordKind> = [
  "visit",
  "condition",
  "document",
  "vaccination",
];

interface Ranked {
  candidate: SearchCandidate;
  matched: number;
  titleHit: boolean;
  score: number;
}

function compareRanked(a: Ranked, b: Ranked): number {
  return (
    b.matched - a.matched ||
    Number(b.titleHit) - Number(a.titleHit) ||
    b.score - a.score ||
    (b.candidate.date ?? 0) - (a.candidate.date ?? 0) ||
    (a.candidate.id < b.candidate.id
      ? -1
      : a.candidate.id > b.candidate.id
        ? 1
        : 0)
  );
}

function markedOrNull(
  text: string | null,
  query: string,
): SearchMarkedText | null {
  return text ? marked(text, query) : null;
}

/** The snippet: the first free-text field the query hit, unless it is the title. */
function snippetFor(
  candidate: SearchCandidate,
  query: string,
): SearchMarkedText | null {
  const title = candidate.hit?.title ?? null;
  for (const field of candidate.fields) {
    if (!field.body || !field.text.trim()) continue;
    if (title !== null && field.text.trim() === title.trim()) continue;
    const snippet = snippetOf(field.text, query);
    if (snippet) return snippet;
  }
  return null;
}

function toHit(candidate: SearchCandidate, query: string): SearchHit {
  const hit = candidate.hit!;
  return {
    id: candidate.id,
    kind: hit.kind as SearchHitKind,
    title: markedOrNull(hit.title, query),
    context: hit.context.map((value) => marked(value, query)),
    snippet: snippetFor(candidate, query),
    day: hit.day,
    path: hit.path,
    source: (hit.source as SearchNoteSource | undefined) ?? null,
  };
}

/**
 * A snippet of the indexed text for the listed documents that matched by
 * their text alone. Bounded: the few listed documents, never the vault.
 */
async function addDocumentSnippets(
  recordId: string,
  hits: SearchHit[],
  query: string,
): Promise<void> {
  const wanting = hits
    .filter(
      (hit) =>
        hit.kind === "document" &&
        hit.snippet === null &&
        (hit.title?.marks.length ?? 0) === 0,
    )
    .slice(0, MAX_DOCUMENT_SNIPPETS);
  if (wanting.length === 0) return;
  const byDocument = new Map(
    wanting.map((hit) => [hit.id.slice("document:".length), hit]),
  );
  const rows = await prisma.documentContentIndex.findMany({
    where: { userId: recordId, documentId: { in: [...byDocument.keys()] } },
    select: {
      documentId: true,
      textEncrypted: true,
      verbatimTextEncrypted: true,
    },
  });
  for (const row of rows) {
    const hit = byDocument.get(row.documentId);
    if (!hit) continue;
    try {
      const text =
        row.verbatimTextEncrypted && row.verbatimTextEncrypted.byteLength > 0
          ? decryptVerbatimText(row.verbatimTextEncrypted)
          : decryptIndexText(row.textEncrypted);
      hit.snippet = snippetOf(text, query);
    } catch {
      // A key gap leaves the hit without a snippet; it still opens.
    }
  }
}

export interface SearchRecordsArgs {
  /** The record the session is acting for. */
  recordId: string;
  query: string;
  /** Most hits per group. */
  limit: number;
  /** The record's module map; an explicit `false` hides a source. */
  modules: SurfaceModuleMap | null;
  /** Whether the caller's grant covers a section (always true for the owner). */
  domainVisible: (domain: ShareScope) => boolean;
  /** The language of labels the server names (a visit kind, a sport). */
  displayLocale: Locale;
  /** The record's zone, for the calendar day of an instant. */
  timezone: string;
  /**
   * Aborted when the answer is no longer wanted (the client went away, or
   * the same actor started a newer search): every source stops at its next
   * check.
   */
  signal?: AbortSignal;
  /** Overrides for tests. */
  now?: () => number;
  budgetMs?: number;
}

export interface SearchStats {
  sources: number;
  rows: number;
  candidates: number;
  elapsedMs: number;
}

/** The sources this caller may read on this record. */
export function readableSources(
  modules: SurfaceModuleMap | null,
  domainVisible: (domain: ShareScope) => boolean,
): SearchSourceKey[] {
  return SEARCH_SOURCE_KEYS.filter(
    (key) =>
      domainVisible(SEARCH_SOURCE_DOMAIN[key]) &&
      isSurfaceVisible(`search:${key}`, modules),
  );
}

export async function searchRecords(
  args: SearchRecordsArgs,
): Promise<SearchResponse & { stats: SearchStats }> {
  const now = args.now ?? Date.now;
  const started = now();
  const budget: ScanBudget = {
    deadline: started + (args.budgetMs ?? SEARCH_TIME_BUDGET_MS),
    now,
    signal: args.signal,
    truncated: false,
    rows: 0,
  };
  const ctx: SearchContext = {
    recordId: args.recordId,
    query: args.query,
    words: queryWords(args.query),
    foldedQuery: normalizeSearchText(args.query),
    wanted: args.limit,
    timezone: args.timezone,
    display: args.displayLocale,
    modules: args.modules,
    budget,
  };
  const sources = new Set(readableSources(args.modules, args.domainVisible));
  const collected: SearchCandidate[] = [];
  const labels = symptomLabels(ctx);

  const tasks: Array<() => Promise<void>> = [];
  const add = (key: SearchSourceKey, run: () => Promise<SearchCandidate[]>) => {
    if (!sources.has(key)) return;
    tasks.push(async () => {
      collected.push(...(await run()));
    });
  };

  const recordKinds = new Set<RecordKind>(
    RECORD_SOURCES.filter((key) => sources.has(key)),
  );
  if (recordKinds.size > 0) {
    tasks.push(async () => {
      const candidates = await loadRecordCandidates(
        args.recordId,
        args.query,
        "",
        {
          kinds: recordKinds,
          displayLocale: args.displayLocale,
          includeAiDeferredText: true,
          rowsPerKind: RECORD_ROWS_PER_KIND,
          // The same budget as every other source: each kind checks it
          // before every row it decrypts, so a large record cannot hold the
          // search past its time.
          shouldStop: () => budgetSpent(budget),
          // A kind that holds more than its newest `RECORD_ROWS_PER_KIND`,
          // or that the budget stopped part-way, may have older matches the
          // search did not see.
          onTruncated: () => {
            budget.truncated = true;
          },
        },
      );
      budget.rows += candidates.length;
      for (const candidate of candidates) {
        if (keepIfHit(ctx, candidate)) collected.push(candidate);
      }
    });
  }
  add("labAnalyte", () => labAnalyteCandidates(ctx));
  add("labNote", () => labNoteCandidates(ctx));
  add("medication", () => medicationCandidates(ctx));
  add("symptom", () => symptomCandidates(ctx, labels));
  add("symptomNote", () => symptomNoteCandidates(ctx, labels));
  add("workout", () => workoutCandidates(ctx));
  add("moodNote", () => moodNoteCandidates(ctx));
  add("illnessNote", () => illnessNoteCandidates(ctx));
  add("measurementNote", () => measurementNoteCandidates(ctx));

  await inPool(tasks, SOURCE_CONCURRENCY, budget);

  const ranked: Ranked[] = collected
    .filter((candidate) => candidate.hit)
    .map((candidate) => {
      const s = scoreCandidate(candidate, ctx.words, ctx.foldedQuery);
      const title = candidate.hit?.title ?? null;
      return {
        candidate,
        matched: s.matched,
        score: s.score,
        titleHit: title !== null && marked(title, args.query).marks.length > 0,
      };
    })
    .sort(compareRanked);

  const groups = new Map<SearchHitKind, SearchGroup>();
  for (const { candidate } of ranked) {
    const kind = candidate.hit!.kind as SearchHitKind;
    let group = groups.get(kind);
    if (!group) {
      group = { kind, hits: [], more: false };
      groups.set(kind, group);
    }
    if (group.hits.length < args.limit)
      group.hits.push(toHit(candidate, args.query));
    else group.more = true;
  }
  // Groups in the order of their best hit; a tie keeps the fixed order.
  const ordered = [...groups.values()].sort((a, b) => {
    const ia = ranked.findIndex((r) => r.candidate.hit?.kind === a.kind);
    const ib = ranked.findIndex((r) => r.candidate.hit?.kind === b.kind);
    return (
      ia - ib ||
      SEARCH_HIT_KINDS.indexOf(a.kind) - SEARCH_HIT_KINDS.indexOf(b.kind)
    );
  });

  await addDocumentSnippets(
    args.recordId,
    ordered.flatMap((group) => group.hits),
    args.query,
  );

  return {
    groups: ordered,
    truncated: budget.truncated,
    stats: {
      sources: sources.size,
      rows: budget.rows,
      candidates: ranked.length,
      elapsedMs: now() - started,
    },
  };
}
