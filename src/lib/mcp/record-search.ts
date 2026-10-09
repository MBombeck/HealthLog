/**
 * The clinical records behind `search` and `fetch`: visits (procedures
 * included), conditions, documents and vaccinations (v1.39.3, Discussion
 * #1025).
 *
 * ChatGPT in its default mode can call only `search` and `fetch`. Before this
 * module those two covered metric domains, medications and lab analytes, so a
 * question like "when was my left knee operation" or "what did the discharge
 * letter say" had nothing to land on: the visit history lived behind
 * `get_visits`, which that mode never calls.
 *
 * Matching. Visit reasons, outcomes and body sites are ciphertext at rest, and
 * so are condition sites and notes, so matching cannot run in SQL. It runs
 * here, after the decrypt, over the account's own rows only and bounded per
 * kind (`MAX_ROWS_PER_KIND`, the same bound the body-sites view uses). The
 * folding is the body-sites service's (`normalizeSearchText`), so "Knie" and
 * "knie " are one word here as they are one site there. A document is matched
 * on its title, file name and kind, and, when the owner has a content index,
 * on whole words of its text through the blind token index the vault search
 * uses. The document body itself is never read for a search.
 *
 * Ranking. Every query word scores the best field it hits (a title, label,
 * site, reason or practitioner counts more than a kind word or a side, which
 * counts more than a note or an indexed-text hit). Results order by how many
 * query words they matched, then by score, then by a fixed kind order, then
 * newest first, then by id: the same query over the same record always
 * returns the same list, which is what the offset cursor relies on.
 *
 * Module switches. A record kind whose module the account has off (or the
 * operator switched off) is not read at all: no row, no link, no count.
 * Visits belong to no module. Links follow the same rule per target kind.
 *
 * AI capability. These are reads of the person's own data over their own MCP
 * connection, like every other MCP read, so no AI capability gates them. The
 * one piece of model-written text a document can carry, its stored summary,
 * is deliberately not returned: showing stored model text is a capability
 * question, and the indexed text is the document's own words.
 *
 * Free text. Everything a person or a document wrote is fenced in `text` and
 * in the long metadata fields; short labels (titles, practitioner names, link
 * labels) are scrubbed of forged markers instead, as the existing search
 * titles are, because a host renders them in a list.
 */
import type {
  EncounterKind,
  IllnessLifecycle,
  IllnessType,
  InboundDocumentKind,
  Laterality,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import { fenceUserText, scrubFenceMarkers } from "@/lib/ai/coach/data-fence";
import {
  decryptIndexText,
  decryptVerbatimText,
  hashQueryTokens,
  tokenise,
} from "@/lib/documents/content-index";
import { expandQueryTokens } from "@/lib/documents/search-synonyms";
import { normalizeSearchText } from "@/lib/encounters/procedures";
import { encounterKindLabel } from "@/lib/encounters/kind-label";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { listTargets } from "@/lib/links";
import type { LinkedTarget } from "@/lib/links/link-service";
import { isModuleEnabled, type ModuleKey } from "@/lib/modules/gate";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import {
  CUSTOM_VACCINE_RESOLVE_SELECT,
  customLookupOf,
  resolveVaccineEntry,
} from "@/lib/vaccinations/resolve-vaccine-entry";

// ── Bounds ───────────────────────────────────────────────────────────

/** Rows one search decrypts and matches, per record kind. */
export const MAX_ROWS_PER_KIND = 500;
/** Query words that take part in matching; the rest are ignored. */
export const MAX_QUERY_WORDS = 8;
/** Record results one search can return in total, across the four kinds. */
export const MAX_RECORD_RESULTS = 50;
/** Newest records per kind listed when the query is empty. */
export const EMPTY_QUERY_PER_KIND = 10;
/** Characters of indexed document text one `fetch` returns. */
export const MAX_DOCUMENT_EXCERPT_CHARS = 1500;
/** One-hop links one `fetch` returns. */
export const MAX_LINKS = 25;

// ── Kinds and their modules ──────────────────────────────────────────

export type RecordKind = "visit" | "condition" | "document" | "vaccination";

export const RECORD_KINDS: readonly RecordKind[] = [
  "visit",
  "condition",
  "document",
  "vaccination",
];

/**
 * The module that owns each record kind. A visit belongs to none: the visit
 * history and the procedure list are never switched off.
 */
export const RECORD_KIND_MODULE: Record<RecordKind, ModuleKey | null> = {
  visit: null,
  condition: "illness",
  document: "inboundDocuments",
  vaccination: "vaccinations",
};

export function isRecordKind(value: string): value is RecordKind {
  return (RECORD_KINDS as readonly string[]).includes(value);
}

/** Which record kinds this account can read right now. */
async function readableKinds(userId: string): Promise<Set<RecordKind>> {
  const out = new Set<RecordKind>();
  await Promise.all(
    RECORD_KINDS.map(async (kind) => {
      const owner = RECORD_KIND_MODULE[kind];
      if (!owner || (await isModuleEnabled(userId, owner))) out.add(kind);
    }),
  );
  return out;
}

// ── Matching and ranking (pure) ──────────────────────────────────────

/** Field weights: what a query word hitting that field is worth. */
export const WEIGHT = { primary: 3, secondary: 2, tertiary: 1 } as const;

export interface SearchField {
  text: string;
  weight: number;
}

export interface SearchCandidate {
  id: string;
  title: string;
  url: string;
  /** Tie-break order between kinds; lower sorts first. */
  kindOrder: number;
  /** Epoch ms of the record's own date, newest first on a tie. */
  date: number | null;
  fields: SearchField[];
  /** Query words the blind content index matched (documents only). */
  contentWords?: ReadonlySet<string>;
  /** True for the four record kinds; bounds `MAX_RECORD_RESULTS`. */
  record?: boolean;
}

/**
 * Words the index tokeniser keeps but a search box does not need. The
 * tokeniser's own list already drops the common function words.
 */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "mein",
  "meine",
  "meinen",
  "meinem",
  "meiner",
  "mine",
  "our",
  "all",
  "any",
  "some",
  "last",
  "latest",
  "recent",
  "letzte",
  "letzten",
  "letzter",
  "letztes",
  "show",
  "find",
  "list",
  "get",
]);

/**
 * Body parts, German and English, for matching a body site or a label. A site
 * is typed in the owner's language and the question often arrives in the
 * assistant's, so "knee" has to find "Knie". Search-time only and local to
 * this module; the document vault's synonym list is left as it is. Same
 * normal form as the tokeniser: lower case, accents stripped.
 */
const BODY_PART_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["knee", "knees", "knie", "kniegelenk"],
  ["shoulder", "shoulders", "schulter", "schultergelenk"],
  ["hip", "hips", "hufte", "huftgelenk"],
  ["ankle", "sprunggelenk", "knochel"],
  ["foot", "feet", "fuss"],
  ["hand", "hands", "hande"],
  ["wrist", "handgelenk"],
  ["elbow", "ellbogen", "ellenbogen"],
  ["back", "rucken", "wirbelsaule", "spine"],
  ["neck", "nacken", "hals"],
  ["head", "kopf"],
  ["eye", "eyes", "auge", "augen"],
  ["ear", "ears", "ohr", "ohren"],
  ["tooth", "teeth", "zahn", "zahne"],
  ["heart", "herz"],
  ["lung", "lungs", "lunge"],
  ["stomach", "magen"],
  ["bowel", "colon", "darm"],
  ["skin", "haut"],
  ["arm", "arms", "arme"],
  ["leg", "legs", "bein", "beine"],
  ["finger", "fingers"],
  ["toe", "toes", "zeh", "zehe", "zehen"],
  ["breast", "brust"],
  ["thyroid", "schilddruse"],
];

const BODY_PART_BY_WORD: ReadonlyMap<string, ReadonlyArray<string>> = (() => {
  const map = new Map<string, string[]>();
  for (const group of BODY_PART_GROUPS) {
    for (const word of group) map.set(word, [...group]);
  }
  return map;
})();

/** A query word's alternatives: the vault's synonyms plus body parts. */
function synonymsOf(word: string): string[] {
  const out = new Set([
    ...expandQueryTokens([word]),
    ...(BODY_PART_BY_WORD.get(word) ?? []),
  ]);
  out.delete(word);
  return [...out];
}

/**
 * The words of a query that take part in matching: folded, split, short and
 * filler words dropped, deduplicated, capped.
 */
export function queryWords(query: string): string[] {
  return tokenise(normalizeSearchText(query))
    .filter((word) => !QUERY_STOPWORDS.has(word))
    .slice(0, MAX_QUERY_WORDS);
}

interface PreparedField {
  folded: string;
  tokens: ReadonlySet<string>;
  weight: number;
}

function prepareField(field: SearchField): PreparedField {
  const folded = normalizeSearchText(field.text);
  return {
    folded,
    tokens: new Set(folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean)),
    weight: field.weight,
  };
}

export interface CandidateScore {
  /** Query words that hit anything. */
  matched: number;
  /** Sum of each matched word's best field weight, plus the phrase bonus. */
  score: number;
  /** The whole query appears as typed inside one field. */
  phrase: boolean;
}

/** Bonus for the whole query appearing inside one field. */
const PHRASE_BONUS = 5;

/**
 * Score one candidate against the query.
 *
 * A word hits a field when the field contains it (so "knee" finds "Knee
 * replacement") or when one of its curated synonyms is a whole word of the
 * field (so "Zucker" finds "glucose"). Synonyms match whole words only: they
 * are wider than the word the person typed, and a substring match on them
 * would find "rate" inside "moderate".
 */
/** Query words shorter than this match whole words or word starts only. */
export const MIN_SUBSTRING_WORD = 4;

/**
 * Whether a query word hits a field by its own spelling. A word of four
 * letters or more may sit anywhere ("knee" in "kneecap"); a shorter one has
 * to start a word, so "arm" finds "Arm" and "Armpit" but not "Darm" or "warm".
 */
function hitsField(field: PreparedField, word: string): boolean {
  if (word.length >= MIN_SUBSTRING_WORD) return field.folded.includes(word);
  for (const token of field.tokens) if (token.startsWith(word)) return true;
  return false;
}

export function scoreCandidate(
  candidate: Pick<SearchCandidate, "fields" | "contentWords">,
  words: readonly string[],
  foldedQuery: string,
): CandidateScore {
  const fields = candidate.fields
    .filter((f) => f.text.trim().length > 0)
    .map(prepareField);
  let matched = 0;
  let score = 0;
  for (const word of words) {
    const synonyms = synonymsOf(word);
    let best = 0;
    for (const field of fields) {
      if (field.weight <= best) continue;
      if (hitsField(field, word) || synonyms.some((s) => field.tokens.has(s))) {
        best = field.weight;
      }
    }
    if (best < WEIGHT.tertiary && candidate.contentWords?.has(word)) {
      best = WEIGHT.tertiary;
    }
    if (best > 0) {
      matched += 1;
      score += best;
    }
  }
  const phrase =
    foldedQuery.length > 0 &&
    fields.some((field) =>
      foldedQuery.includes(" ")
        ? field.folded.includes(foldedQuery)
        : hitsField(field, foldedQuery),
    );
  if (phrase) score += PHRASE_BONUS;
  return { matched, score, phrase };
}

/**
 * Filter and order candidates for one query. Pure and deterministic.
 *
 * An empty query keeps every candidate. Otherwise a candidate stays when a
 * query word hit it or the whole query appears in one of its fields (the
 * substring match the older search kinds were built on, kept so a short
 * query like "hr" still finds what it found before).
 */
export function rankCandidates(
  candidates: readonly SearchCandidate[],
  query: string,
): SearchCandidate[] {
  const foldedQuery = normalizeSearchText(query);
  const words = queryWords(query);
  const scored = candidates.flatMap((candidate) => {
    if (!foldedQuery) {
      return [{ candidate, matched: 0, score: 0 }];
    }
    const s = scoreCandidate(candidate, words, foldedQuery);
    if (s.matched === 0 && !s.phrase) return [];
    return [{ candidate, matched: s.matched, score: s.score }];
  });
  scored.sort(
    (a, b) =>
      b.matched - a.matched ||
      b.score - a.score ||
      a.candidate.kindOrder - b.candidate.kindOrder ||
      (b.candidate.date ?? 0) - (a.candidate.date ?? 0) ||
      (a.candidate.id < b.candidate.id
        ? -1
        : a.candidate.id > b.candidate.id
          ? 1
          : 0),
  );
  let records = 0;
  return scored.flatMap(({ candidate }) => {
    if (!candidate.record) return [candidate];
    records += 1;
    return records <= MAX_RECORD_RESULTS ? [candidate] : [];
  });
}

// ── Labels ───────────────────────────────────────────────────────────

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

/** "DISCHARGE_LETTER" → "discharge letter". */
function enumWords(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}

/**
 * Words a person uses for a visit kind that neither the enum nor the bundle
 * label carries. "Operation" is the common one: nobody asks for their "left
 * knee procedure or surgery".
 */
const ENCOUNTER_KIND_ALIASES: Partial<Record<EncounterKind, string>> = {
  PROCEDURE: "surgery surgical operation operiert eingriff",
  HOSPITAL: "inpatient krankenhaus klinik",
  EMERGENCY: "notaufnahme notfall",
};

const LATERALITY_WORDS: Record<Laterality, string> = {
  LEFT: "left",
  RIGHT: "right",
  BOTH: "both sides",
};

function sideTerms(
  laterality: Laterality | null,
  owner: Locale,
): string | null {
  if (!laterality) return null;
  const key =
    laterality === "LEFT"
      ? "encounters.laterality.left"
      : laterality === "RIGHT"
        ? "encounters.laterality.right"
        : "encounters.laterality.both";
  const en = getServerTranslator("en").t(key);
  const own = getServerTranslator(owner).t(key);
  return `${LATERALITY_WORDS[laterality]} ${en} ${own}`;
}

function documentKindLabel(kind: InboundDocumentKind, locale: Locale): string {
  return getServerTranslator(locale).t(`documents.kind.${kind}`);
}

function illnessTypeLabel(type: IllnessType, locale: Locale): string {
  return getServerTranslator(locale).t(`illness.type.${type}`);
}

function lifecycleLabel(lifecycle: IllnessLifecycle): string {
  return getServerTranslator("en").t(`illness.lifecycle.${lifecycle}`);
}

/** The catalogue name of a dose's slug, or null for a slug it does not know. */
function vaccineCatalogName(
  slug: string | null,
  locale: Locale,
): string | null {
  const entry = resolveVaccineEntry({ antigenSlug: slug });
  if (!entry?.slug) return null;
  return getServerTranslator(locale).t(`vaccinations.catalog.${entry.slug}`);
}

/** Decrypt a free-text `Bytes` column fail-soft: a rotation gap reads as absent. */
function decryptText(value: Uint8Array | null): string | null {
  if (!value || value.byteLength === 0) return null;
  try {
    const text = decryptFromBytes(value);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return { text: collapsed, truncated: false };
  return { text: `${collapsed.slice(0, max).trimEnd()}…`, truncated: true };
}

function dateOnly(value: Date | null): string | null {
  // eslint-disable-next-line healthlog/no-utc-day-key -- baseline: text label mixing date-only columns and instants, read without a zone
  return value ? value.toISOString().slice(0, 10) : null;
}

// ── Deep links ───────────────────────────────────────────────────────
// Pages behind the normal sign-in, never an API path that serves bytes.

export function recordUrl(
  origin: string,
  kind: RecordKind,
  id: string,
): string {
  const rid = encodeURIComponent(id);
  switch (kind) {
    case "visit":
      return `${origin}/checkups?visit=${rid}`;
    case "condition":
      return `${origin}/illness/${rid}`;
    case "document":
      return `${origin}/documents?doc=${rid}`;
    case "vaccination":
      return `${origin}/vaccinations?dose=${rid}`;
  }
}

/**
 * Record kinds sort after every older search kind on a tie. The older kinds
 * use their assembly position (at most a few thousand), so the base sits far
 * above it.
 */
const KIND_ORDER_BASE = 1_000_000;
const KIND_ORDER: Record<RecordKind, number> = {
  visit: KIND_ORDER_BASE,
  condition: KIND_ORDER_BASE + 1,
  document: KIND_ORDER_BASE + 2,
  vaccination: KIND_ORDER_BASE + 3,
};

// ── Search: candidates per kind ──────────────────────────────────────

interface Owner {
  locale: Locale;
  timezone: string;
}

async function loadOwner(userId: string): Promise<Owner> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true, timezone: true },
  });
  return {
    locale: resolveLocale(row?.locale),
    timezone: row?.timezone ?? DEFAULT_TIMEZONE,
  };
}

function visitTitle(args: {
  kind: EncounterKind;
  day: string;
  bodySite: string | null;
  laterality: Laterality | null;
  practitioner: string | null;
  status: string;
}): string {
  const parts = [encounterKindLabel(args.kind, "en")];
  if (args.bodySite) {
    parts.push(
      args.laterality && args.laterality !== "BOTH"
        ? `${LATERALITY_WORDS[args.laterality]} ${args.bodySite}`
        : args.bodySite,
    );
  }
  if (args.practitioner) parts.push(args.practitioner);
  const status = args.status === "DONE" ? "" : `, ${enumWords(args.status)}`;
  return scrubFenceMarkers(`${parts.join(" · ")} (${args.day}${status})`);
}

/**
 * The practitioner columns a record read selects. `deletedAt` rides along so
 * a practitioner the person removed contributes nothing: the visit keeps its
 * scalar id, but the name is no longer something the record says.
 */
const PRACTITIONER_SELECT = {
  select: { name: true, specialty: true, deletedAt: true },
} as const;

type PractitionerRow = {
  name: string;
  specialty: string | null;
  deletedAt: Date | null;
} | null;

/** The practitioner as the record may still show it, or null. */
export function livePractitioner(
  row: PractitionerRow | undefined,
): { name: string; specialty: string | null } | null {
  return row && row.deletedAt === null
    ? { name: row.name, specialty: row.specialty }
    : null;
}

async function visitCandidates(
  userId: string,
  owner: Owner,
  origin: string,
  take: number,
  empty: boolean,
): Promise<SearchCandidate[]> {
  const rows = await prisma.encounter.findMany({
    // The empty-query listing is "what is in my record": things that
    // happened. A booked appointment is still found by any query naming it.
    where: {
      userId,
      deletedAt: null,
      ...(empty ? { occurredAt: { lte: new Date() } } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
    take,
    include: { practitioner: PRACTITIONER_SELECT },
  });
  return rows.map((row) => {
    const practitioner = livePractitioner(row.practitioner);
    const reason = decryptText(row.reasonEncrypted);
    const outcome = decryptText(row.outcomeEncrypted);
    const bodySite = decryptText(row.bodySiteEncrypted);
    const day = userDayKey(row.occurredAt, owner.timezone);
    return {
      id: `visit:${row.id}`,
      title: visitTitle({
        kind: row.kind,
        day,
        bodySite: bodySite?.replace(/\s+/g, " ").trim() ?? null,
        laterality: row.laterality,
        practitioner: practitioner?.name ?? null,
        status: row.status,
      }),
      url: recordUrl(origin, "visit", row.id),
      kindOrder: KIND_ORDER.visit,
      date: row.occurredAt.getTime(),
      record: true,
      fields: [
        { text: bodySite ?? "", weight: WEIGHT.primary },
        { text: reason ?? "", weight: WEIGHT.primary },
        { text: practitioner?.name ?? "", weight: WEIGHT.primary },
        { text: practitioner?.specialty ?? "", weight: WEIGHT.primary },
        {
          text: [
            "visit",
            enumWords(row.kind),
            encounterKindLabel(row.kind, "en"),
            encounterKindLabel(row.kind, owner.locale),
            ENCOUNTER_KIND_ALIASES[row.kind] ?? "",
          ].join(" "),
          weight: WEIGHT.secondary,
        },
        {
          text: sideTerms(row.laterality, owner.locale) ?? "",
          weight: WEIGHT.secondary,
        },
        { text: outcome ?? "", weight: WEIGHT.secondary },
      ],
    };
  });
}

/**
 * The condition columns MCP reads. An explicit list, and the note is not on
 * it: a condition's note is never handed to an AI surface (the Coach illness
 * snapshot and the doctor report leave it out too), and an outside assistant
 * is one. `no-note-columns-guard.test.ts` holds every MCP read to this.
 */
const CONDITION_SELECT = {
  id: true,
  label: true,
  type: true,
  lifecycle: true,
  onsetAt: true,
  resolvedAt: true,
  bodySiteEncrypted: true,
  laterality: true,
} as const;

/** The dose columns MCP reads; the note is left out for the same reason. */
const VACCINATION_SELECT = {
  id: true,
  occurredAt: true,
  antigenSlug: true,
  vaccineName: true,
  doseNumber: true,
  seriesDoses: true,
  lotNumber: true,
  site: true,
  practitioner: PRACTITIONER_SELECT,
  // v1.42 (#1005) — the person's own definition, for its name and antigens.
  customVaccineId: true,
  customVaccine: { select: CUSTOM_VACCINE_RESOLVE_SELECT },
} as const;

/**
 * The person's own vaccine definition a dose names, when it is the answer
 * (the catalogue wins when the dose also carries a slug). Its name is user
 * text and is scrubbed or fenced by the caller.
 */
function ownVaccine(row: {
  antigenSlug: string | null;
  customVaccineId: string | null;
  customVaccine: Parameters<typeof customLookupOf>[0][number];
}): { name: string; components: readonly string[] } | null {
  const entry = resolveVaccineEntry(row, customLookupOf([row.customVaccine]));
  return entry?.kind === "custom" && entry.name
    ? { name: entry.name, components: entry.components }
    : null;
}

async function conditionCandidates(
  userId: string,
  owner: Owner,
  origin: string,
  take: number,
): Promise<SearchCandidate[]> {
  const rows = await prisma.illnessEpisode.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ onsetAt: "desc" }, { id: "asc" }],
    take,
    select: CONDITION_SELECT,
  });
  return rows.map((row) => {
    const bodySite = decryptText(row.bodySiteEncrypted);
    const day = userDayKey(row.onsetAt, owner.timezone);
    const site = bodySite?.replace(/\s+/g, " ").trim();
    return {
      id: `condition:${row.id}`,
      title: scrubFenceMarkers(
        `${row.label}${site ? ` · ${site}` : ""} (${illnessTypeLabel(row.type, "en")}, since ${day})`,
      ),
      url: recordUrl(origin, "condition", row.id),
      kindOrder: KIND_ORDER.condition,
      date: row.onsetAt.getTime(),
      record: true,
      fields: [
        { text: row.label, weight: WEIGHT.primary },
        { text: bodySite ?? "", weight: WEIGHT.primary },
        {
          text: [
            "condition illness",
            enumWords(row.type),
            illnessTypeLabel(row.type, "en"),
            illnessTypeLabel(row.type, owner.locale),
            enumWords(row.lifecycle),
          ].join(" "),
          weight: WEIGHT.secondary,
        },
        {
          text: sideTerms(row.laterality, owner.locale) ?? "",
          weight: WEIGHT.secondary,
        },
      ],
    };
  });
}

const DOCUMENT_SELECT = {
  id: true,
  title: true,
  filename: true,
  kind: true,
  documentDate: true,
  reportDate: true,
  createdAt: true,
} as const;

/**
 * The account's documents whose indexed text holds each query word, keyed by
 * document id. Whole words only (the index is a set of one-way token hashes),
 * with the vault's synonym expansion. Never reads the text itself.
 */
async function contentMatches(
  userId: string,
  words: readonly string[],
): Promise<Map<string, Set<string>>> {
  const byDocument = new Map<string, Set<string>>();
  await Promise.all(
    words.map(async (word) => {
      const hashes = hashQueryTokens(word);
      if (hashes.length === 0) return;
      const rows = await prisma.documentContentIndex.findMany({
        where: {
          userId,
          searchTokens: { hasSome: hashes },
          // A document held back from AI reading is not searched by its
          // text over this wire either; its title and kind still are.
          document: { deletedAt: null, aiReadDeferred: false },
        },
        select: { documentId: true },
        take: MAX_ROWS_PER_KIND,
      });
      for (const row of rows) {
        const set = byDocument.get(row.documentId) ?? new Set<string>();
        set.add(word);
        byDocument.set(row.documentId, set);
      }
    }),
  );
  return byDocument;
}

/**
 * The terms a title or file name is looked up by in SQL: the folded query
 * words plus the raw lower-cased ones, because the columns keep their accents
 * and "Schädel" folds to "schadel". Short words stay out: a three-letter
 * substring over every title is noise, and the in-memory pass still sees
 * them for the newest documents.
 */
function documentNameTerms(query: string, words: readonly string[]): string[] {
  const raw = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}._-]+/u)
    .filter((w) => w.length >= MIN_SUBSTRING_WORD);
  return [
    ...new Set([
      ...words.filter((w) => w.length >= MIN_SUBSTRING_WORD),
      ...raw,
    ]),
  ].slice(0, MAX_QUERY_WORDS * 2);
}

async function documentCandidates(
  userId: string,
  owner: Owner,
  origin: string,
  take: number,
  query: string,
  words: readonly string[],
): Promise<SearchCandidate[]> {
  const nameTerms = documentNameTerms(query, words);
  const [rows, content, named] = await Promise.all([
    prisma.inboundDocument.findMany({
      where: { userId, deletedAt: null },
      select: DOCUMENT_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take,
    }),
    words.length > 0
      ? contentMatches(userId, words)
      : Promise.resolve(new Map<string, Set<string>>()),
    // Title and file name are plaintext columns, so an older document is
    // found by them in SQL, the way the vault list finds it.
    nameTerms.length > 0
      ? prisma.inboundDocument.findMany({
          where: {
            userId,
            deletedAt: null,
            OR: nameTerms.flatMap((term) => [
              { title: { contains: term, mode: "insensitive" as const } },
              { filename: { contains: term, mode: "insensitive" as const } },
            ]),
          },
          select: { id: true },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: MAX_ROWS_PER_KIND,
        })
      : Promise.resolve([] as Array<{ id: string }>),
  ]);
  // A content or name hit on a document older than the newest `take` still
  // counts; the extra read is bounded like the others.
  const seen = new Set(rows.map((r) => r.id));
  const missing = [
    ...new Set([...content.keys(), ...named.map((r) => r.id)]),
  ].filter((id) => !seen.has(id));
  const extra =
    missing.length > 0
      ? await prisma.inboundDocument.findMany({
          where: { userId, deletedAt: null, id: { in: missing } },
          select: DOCUMENT_SELECT,
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: MAX_ROWS_PER_KIND,
        })
      : [];

  return [...rows, ...extra].map((row) => {
    const dated = row.documentDate ?? row.reportDate;
    const kindLabel = documentKindLabel(row.kind, "en");
    const name = row.title ?? row.filename ?? kindLabel;
    return {
      id: `document:${row.id}`,
      title: scrubFenceMarkers(
        `${name} (${kindLabel}${dated ? `, ${dateOnly(dated)}` : ""})`,
      ),
      url: recordUrl(origin, "document", row.id),
      kindOrder: KIND_ORDER.document,
      date: (dated ?? row.createdAt).getTime(),
      record: true,
      contentWords: content.get(row.id),
      fields: [
        { text: row.title ?? "", weight: WEIGHT.primary },
        { text: row.filename ?? "", weight: WEIGHT.primary },
        {
          text: [
            "document",
            enumWords(row.kind),
            kindLabel,
            documentKindLabel(row.kind, owner.locale),
          ].join(" "),
          weight: WEIGHT.secondary,
        },
      ],
    };
  });
}

async function vaccinationCandidates(
  userId: string,
  owner: Owner,
  origin: string,
  take: number,
): Promise<SearchCandidate[]> {
  const rows = await prisma.vaccinationRecord.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
    take,
    select: VACCINATION_SELECT,
  });
  return rows.map((row) => {
    const practitioner = livePractitioner(row.practitioner);
    const entry = resolveVaccineEntry({ antigenSlug: row.antigenSlug });
    const own = ownVaccine(row);
    const catalogEn = vaccineCatalogName(row.antigenSlug, "en");
    const name =
      row.vaccineName ??
      catalogEn ??
      own?.name ??
      row.antigenSlug ??
      "Vaccination";
    const dose = row.doseNumber ? `dose ${row.doseNumber}, ` : "";
    const day = dateOnly(row.occurredAt);
    return {
      id: `vaccination:${row.id}`,
      title: scrubFenceMarkers(`${name} (${dose}${day})`),
      url: recordUrl(origin, "vaccination", row.id),
      kindOrder: KIND_ORDER.vaccination,
      date: row.occurredAt.getTime(),
      record: true,
      fields: [
        { text: row.vaccineName ?? "", weight: WEIGHT.primary },
        {
          text: [
            catalogEn ?? "",
            vaccineCatalogName(row.antigenSlug, owner.locale) ?? "",
            row.antigenSlug
              ? enumWords(row.antigenSlug.replace(/-/g, "_"))
              : "",
            ...(entry?.synonyms ?? []),
            own?.name ?? "",
            ...(own?.components ?? []).map((antigen) =>
              enumWords(antigen.replace(/-/g, "_")),
            ),
          ].join(" "),
          weight: WEIGHT.primary,
        },
        {
          text: "vaccination vaccine immunization impfung",
          weight: WEIGHT.secondary,
        },
        { text: practitioner?.name ?? "", weight: WEIGHT.secondary },
        { text: practitioner?.specialty ?? "", weight: WEIGHT.secondary },
      ],
    };
  });
}

/**
 * Every record candidate this account can see for one query. Unranked; the
 * caller ranks them together with the older search kinds.
 */
export async function loadRecordCandidates(
  userId: string,
  query: string,
  origin: string,
): Promise<SearchCandidate[]> {
  const words = queryWords(query);
  const empty = normalizeSearchText(query).length === 0;
  const take = empty ? EMPTY_QUERY_PER_KIND : MAX_ROWS_PER_KIND;
  const [kinds, owner] = await Promise.all([
    readableKinds(userId),
    loadOwner(userId),
  ]);
  const groups = await Promise.all([
    visitCandidates(userId, owner, origin, take, empty),
    kinds.has("condition")
      ? conditionCandidates(userId, owner, origin, take)
      : Promise.resolve([]),
    kinds.has("document")
      ? documentCandidates(userId, owner, origin, take, query, words)
      : Promise.resolve([]),
    kinds.has("vaccination")
      ? vaccinationCandidates(userId, owner, origin, take)
      : Promise.resolve([]),
  ]);
  return groups.flat();
}

// ── Fetch ────────────────────────────────────────────────────────────

export interface RecordLink {
  id: string | null;
  kind: RecordKind | "lab";
  label: string;
  date: string | null;
}

export interface FetchResult {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, unknown>;
}

function linkDate(iso: string | null): string | null {
  return iso ? iso.slice(0, 10) : null;
}

function toLinks(
  kind: RecordKind,
  targets: readonly LinkedTarget[],
  label: (target: LinkedTarget) => string = (t) => t.label,
): RecordLink[] {
  return targets.map((target) => ({
    id: `${kind}:${target.id}`,
    kind,
    label: scrubFenceMarkers(label(target)),
    date: linkDate(target.date),
  }));
}

/** A linked visit is labelled by its kind, in English on this wire. */
function visitLinkLabel(target: LinkedTarget): string {
  return encounterKindLabel(target.label as EncounterKind, "en");
}

async function labLinks(
  userId: string,
  targets: readonly LinkedTarget[],
): Promise<RecordLink[]> {
  if (targets.length === 0) return [];
  const rows = await prisma.labResult.findMany({
    where: { userId, id: { in: targets.map((t) => t.id) }, deletedAt: null },
    select: { id: true, analyte: true },
  });
  const analyte = new Map(rows.map((r) => [r.id, r.analyte]));
  return targets.flatMap((target) => {
    const name = analyte.get(target.id);
    if (!name) return [];
    return [
      {
        id: `lab:${name}`,
        kind: "lab" as const,
        label: scrubFenceMarkers(target.label),
        date: linkDate(target.date),
      },
    ];
  });
}

function linksSentence(links: readonly RecordLink[]): string {
  if (links.length === 0) return "Linked records: none.";
  return `Linked records: ${links
    .map(
      (l) =>
        `${l.kind} ${fenceUserText(l.label)}${l.date ? ` (${l.date})` : ""}`,
    )
    .join("; ")}.`;
}

function boundLinks(links: RecordLink[]): {
  links: RecordLink[];
  linksTruncated: boolean;
} {
  return {
    links: links.slice(0, MAX_LINKS),
    linksTruncated: links.length > MAX_LINKS,
  };
}

function moduleOff(
  id: string,
  kind: RecordKind,
  origin: string,
  module: ModuleKey,
): FetchResult {
  return {
    id,
    title: "Not available",
    text: `This record kind is switched off in HealthLog (module "${module}"), so nothing of it is shared.`,
    url: `${origin}/insights`,
    metadata: { type: kind, present: false, reason: "module_disabled" },
  };
}

function notFound(id: string, kind: RecordKind, origin: string): FetchResult {
  return {
    id,
    title: "Not found",
    text: `No ${kind} matches this id.`,
    url: `${origin}/insights`,
    metadata: { type: kind, present: false, reason: "not_found" },
  };
}

function fenced(value: string | null): string | null {
  return value === null ? null : fenceUserText(value);
}

async function fetchVisit(
  userId: string,
  id: string,
  rid: string,
  origin: string,
  kinds: ReadonlySet<RecordKind>,
  owner: Owner,
): Promise<FetchResult> {
  const row = await prisma.encounter.findFirst({
    where: { id: rid, userId, deletedAt: null },
    include: { practitioner: PRACTITIONER_SELECT },
  });
  if (!row) return notFound(id, "visit", origin);

  const labsOn = await isModuleEnabled(userId, "labs");
  const source = { userId, sourceKind: "encounter" as const, sourceId: rid };
  const [documents, labs, conditions, doses] = await Promise.all([
    kinds.has("document")
      ? listTargets(prisma, { ...source, targetKind: "document" })
      : Promise.resolve([]),
    labsOn
      ? listTargets(prisma, { ...source, targetKind: "labResult" })
      : Promise.resolve([]),
    kinds.has("condition")
      ? listTargets(prisma, { ...source, targetKind: "conditionEpisode" })
      : Promise.resolve([]),
    kinds.has("vaccination")
      ? prisma.vaccinationRecord.findMany({
          where: { userId, encounterId: rid, deletedAt: null },
          select: {
            id: true,
            vaccineName: true,
            antigenSlug: true,
            occurredAt: true,
            customVaccineId: true,
            customVaccine: { select: CUSTOM_VACCINE_RESOLVE_SELECT },
          },
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
  ]);
  const all: RecordLink[] = [
    ...toLinks("condition", conditions),
    ...toLinks("document", documents),
    ...(await labLinks(userId, labs)),
    ...doses.map((dose) => ({
      id: `vaccination:${dose.id}`,
      kind: "vaccination" as const,
      label: scrubFenceMarkers(
        dose.vaccineName ??
          vaccineCatalogName(dose.antigenSlug, "en") ??
          ownVaccine(dose)?.name ??
          dose.antigenSlug ??
          "Vaccination",
      ),
      date: dateOnly(dose.occurredAt),
    })),
  ];
  const { links, linksTruncated } = boundLinks(all);

  const reason = decryptText(row.reasonEncrypted);
  const outcome = decryptText(row.outcomeEncrypted);
  const bodySite = decryptText(row.bodySiteEncrypted);
  const day = userDayKey(row.occurredAt, owner.timezone);
  const kindLabel = encounterKindLabel(row.kind, "en");
  const live = livePractitioner(row.practitioner);
  const practitioner = live?.name ?? null;
  const specialty = live?.specialty ?? null;

  const sentences = [
    `Visit on ${day}: ${kindLabel}, status ${row.status}.`,
    practitioner
      ? `Practitioner: ${fenceUserText(practitioner)}${specialty ? ` (${fenceUserText(specialty)})` : ""}.`
      : "No practitioner recorded.",
    bodySite
      ? `Body site: ${fenceUserText(bodySite)}${row.laterality ? `, side ${row.laterality}` : ""}.`
      : null,
    reason ? `Reason: ${fenceUserText(reason)}.` : "No reason recorded.",
    outcome ? `Outcome: ${fenceUserText(outcome)}.` : "No outcome recorded.",
    linksSentence(links),
  ].filter((s): s is string => s !== null);

  return {
    id,
    title: visitTitle({
      kind: row.kind,
      day,
      bodySite: bodySite?.replace(/\s+/g, " ").trim() ?? null,
      laterality: row.laterality,
      practitioner,
      status: row.status,
    }),
    text: sentences.join(" "),
    url: recordUrl(origin, "visit", rid),
    metadata: {
      type: "visit",
      present: true,
      occurredAt: row.occurredAt.toISOString(),
      status: row.status,
      kind: row.kind,
      practitioner: practitioner ? scrubFenceMarkers(practitioner) : null,
      specialty: specialty ? scrubFenceMarkers(specialty) : null,
      bodySite: fenced(bodySite),
      laterality: row.laterality,
      reason: fenced(reason),
      outcome: fenced(outcome),
      links,
      linksTruncated,
    },
  };
}

async function fetchCondition(
  userId: string,
  id: string,
  rid: string,
  origin: string,
  kinds: ReadonlySet<RecordKind>,
  owner: Owner,
): Promise<FetchResult> {
  const row = await prisma.illnessEpisode.findFirst({
    where: { id: rid, userId, deletedAt: null },
    select: CONDITION_SELECT,
  });
  if (!row) return notFound(id, "condition", origin);

  const source = {
    userId,
    sourceKind: "conditionEpisode" as const,
    sourceId: rid,
  };
  const [visits, documents] = await Promise.all([
    listTargets(prisma, { ...source, targetKind: "encounter" }),
    kinds.has("document")
      ? listTargets(prisma, { ...source, targetKind: "document" })
      : Promise.resolve([]),
  ]);
  const { links, linksTruncated } = boundLinks([
    ...toLinks("visit", visits, visitLinkLabel),
    ...toLinks("document", documents),
  ]);

  const bodySite = decryptText(row.bodySiteEncrypted);
  const onset = userDayKey(row.onsetAt, owner.timezone);
  const resolved = row.resolvedAt
    ? userDayKey(row.resolvedAt, owner.timezone)
    : null;
  const typeLabel = illnessTypeLabel(row.type, "en");

  const sentences = [
    `Condition ${fenceUserText(row.label)}: ${typeLabel}, ${lifecycleLabel(row.lifecycle).toLowerCase()}, since ${onset}${resolved ? `, resolved ${resolved}` : ", not marked resolved"}.`,
    bodySite
      ? `Body site: ${fenceUserText(bodySite)}${row.laterality ? `, side ${row.laterality}` : ""}.`
      : null,
    linksSentence(links),
  ].filter((s): s is string => s !== null);

  const site = bodySite?.replace(/\s+/g, " ").trim();
  return {
    id,
    title: scrubFenceMarkers(
      `${row.label}${site ? ` · ${site}` : ""} (${typeLabel}, since ${onset})`,
    ),
    text: sentences.join(" "),
    url: recordUrl(origin, "condition", rid),
    metadata: {
      type: "condition",
      present: true,
      label: scrubFenceMarkers(row.label),
      illnessType: row.type,
      lifecycle: row.lifecycle,
      onsetAt: row.onsetAt.toISOString(),
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      bodySite: fenced(bodySite),
      laterality: row.laterality,
      links,
      linksTruncated,
    },
  };
}

/**
 * The indexed text of one document, bounded. Verbatim text first (casing and
 * accents intact), the normalised search text for a row indexed before the
 * verbatim capture existed. A decrypt failure reads as no excerpt rather than
 * a failed fetch; the metadata says which.
 */
async function documentExcerpt(
  userId: string,
  documentId: string,
): Promise<{
  indexed: boolean;
  excerpt: { text: string; truncated: boolean } | null;
}> {
  const row = await prisma.documentContentIndex.findFirst({
    where: { documentId, userId },
    select: { textEncrypted: true, verbatimTextEncrypted: true },
  });
  if (!row) return { indexed: false, excerpt: null };
  try {
    const text =
      row.verbatimTextEncrypted && row.verbatimTextEncrypted.byteLength > 0
        ? decryptVerbatimText(row.verbatimTextEncrypted)
        : decryptIndexText(row.textEncrypted);
    return {
      indexed: true,
      excerpt: text.trim() ? clip(text, MAX_DOCUMENT_EXCERPT_CHARS) : null,
    };
  } catch {
    return { indexed: true, excerpt: null };
  }
}

async function fetchDocument(
  userId: string,
  id: string,
  rid: string,
  origin: string,
  kinds: ReadonlySet<RecordKind>,
): Promise<FetchResult> {
  // Metadata only. The stored bytes and the model-written summary are never
  // selected, so neither can reach this answer by accident.
  const row = await prisma.inboundDocument.findFirst({
    where: { id: rid, userId, deletedAt: null },
    select: {
      ...DOCUMENT_SELECT,
      mimeType: true,
      byteSize: true,
      aiReadDeferred: true,
    },
  });
  if (!row) return notFound(id, "document", origin);
  // Held back from AI reading at upload: the indexed text is not read, let
  // alone sent. The title, kind, dates and links are the record's metadata
  // and still are.
  const deferred = row.aiReadDeferred;

  const source = { userId, sourceKind: "document" as const, sourceId: rid };
  const [content, visits, conditions, doses] = await Promise.all([
    deferred
      ? Promise.resolve({ indexed: false, excerpt: null })
      : documentExcerpt(userId, rid),
    listTargets(prisma, { ...source, targetKind: "encounter" }),
    kinds.has("condition")
      ? listTargets(prisma, { ...source, targetKind: "conditionEpisode" })
      : Promise.resolve([]),
    kinds.has("vaccination")
      ? listTargets(prisma, { ...source, targetKind: "vaccination" })
      : Promise.resolve([]),
  ]);
  const { links, linksTruncated } = boundLinks([
    ...toLinks("visit", visits, visitLinkLabel),
    ...toLinks("condition", conditions),
    ...toLinks("vaccination", doses),
  ]);

  const kindLabel = documentKindLabel(row.kind, "en");
  const name = row.title ?? row.filename ?? kindLabel;
  const dated = row.documentDate ?? row.reportDate;
  const sentences = [
    `Document ${fenceUserText(name)}: ${kindLabel}, ${dated ? `dated ${dateOnly(dated)}` : "undated"}, added ${dateOnly(row.createdAt)}.`,
    deferred
      ? "This document was stored without AI reading, so its text is not shared here."
      : content.excerpt
        ? `Indexed text${content.excerpt.truncated ? " (excerpt)" : ""}: ${fenceUserText(content.excerpt.text)}`
        : content.indexed
          ? "The indexed text could not be read."
          : "No indexed text is stored for this document.",
    linksSentence(links),
  ];

  return {
    id,
    title: scrubFenceMarkers(
      `${name} (${kindLabel}${dated ? `, ${dateOnly(dated)}` : ""})`,
    ),
    text: sentences.join(" "),
    url: recordUrl(origin, "document", rid),
    metadata: {
      type: "document",
      present: true,
      kind: row.kind,
      title: row.title ? scrubFenceMarkers(row.title) : null,
      filename: row.filename ? scrubFenceMarkers(row.filename) : null,
      documentDate: dateOnly(row.documentDate),
      reportDate: dateOnly(row.reportDate),
      createdAt: row.createdAt.toISOString(),
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      ...(deferred ? { reason: "ai_read_deferred" } : {}),
      indexed: content.indexed,
      excerpt: content.excerpt ? fenceUserText(content.excerpt.text) : null,
      excerptTruncated: content.excerpt?.truncated ?? false,
      links,
      linksTruncated,
    },
  };
}

async function fetchVaccination(
  userId: string,
  id: string,
  rid: string,
  origin: string,
  kinds: ReadonlySet<RecordKind>,
): Promise<FetchResult> {
  const row = await prisma.vaccinationRecord.findFirst({
    where: { id: rid, userId, deletedAt: null },
    select: {
      ...VACCINATION_SELECT,
      encounter: {
        select: { id: true, kind: true, occurredAt: true, deletedAt: true },
      },
    },
  });
  if (!row) return notFound(id, "vaccination", origin);

  const documents = kinds.has("document")
    ? await listTargets(prisma, {
        userId,
        sourceKind: "vaccination",
        sourceId: rid,
        targetKind: "document",
      })
    : [];
  const visit =
    row.encounter && row.encounter.deletedAt === null ? row.encounter : null;
  const { links, linksTruncated } = boundLinks([
    ...(visit
      ? [
          {
            id: `visit:${visit.id}`,
            kind: "visit" as const,
            label: encounterKindLabel(visit.kind, "en"),
            date: dateOnly(visit.occurredAt),
          },
        ]
      : []),
    ...toLinks("document", documents),
  ]);

  const catalog = vaccineCatalogName(row.antigenSlug, "en");
  const own = ownVaccine(row);
  const name =
    row.vaccineName ?? catalog ?? own?.name ?? row.antigenSlug ?? "Vaccination";
  const practitioner = livePractitioner(row.practitioner);
  const day = dateOnly(row.occurredAt);
  const dose =
    row.doseNumber !== null
      ? `dose ${row.doseNumber}${row.seriesDoses ? ` of ${row.seriesDoses}` : ""}`
      : "dose number not recorded";

  const sentences = [
    `Vaccination ${fenceUserText(name)} on ${day}, ${dose}.`,
    catalog && row.vaccineName ? `Catalogue entry: ${catalog}.` : null,
    own
      ? `Logged against the person's own vaccine ${fenceUserText(own.name)}${
          own.components.length > 0
            ? `, which protects against ${own.components.join(", ")}`
            : ""
        }.`
      : null,
    practitioner
      ? `Given by ${fenceUserText(practitioner.name)}.`
      : "No practitioner recorded.",
    linksSentence(links),
  ].filter((s): s is string => s !== null);

  return {
    id,
    title: scrubFenceMarkers(
      `${name} (${row.doseNumber ? `dose ${row.doseNumber}, ` : ""}${day})`,
    ),
    text: sentences.join(" "),
    url: recordUrl(origin, "vaccination", rid),
    metadata: {
      type: "vaccination",
      present: true,
      occurredAt: day,
      vaccineName: row.vaccineName ? scrubFenceMarkers(row.vaccineName) : null,
      antigenSlug: row.antigenSlug,
      catalogName: catalog,
      doseNumber: row.doseNumber,
      seriesDoses: row.seriesDoses,
      lotNumber: row.lotNumber ? scrubFenceMarkers(row.lotNumber) : null,
      site: row.site,
      practitioner: practitioner ? scrubFenceMarkers(practitioner.name) : null,
      links,
      linksTruncated,
    },
  };
}

/**
 * Hydrate one record by its search id. The module check runs before any row
 * is read, so a switched-off kind answers without touching its table.
 */
export async function fetchRecord(
  userId: string,
  kind: RecordKind,
  rid: string,
  origin: string,
): Promise<FetchResult> {
  const id = `${kind}:${rid}`;
  const kinds = await readableKinds(userId);
  const owner = RECORD_KIND_MODULE[kind];
  if (owner && !kinds.has(kind)) return moduleOff(id, kind, origin, owner);
  switch (kind) {
    case "visit":
      return fetchVisit(
        userId,
        id,
        rid,
        origin,
        kinds,
        await loadOwner(userId),
      );
    case "condition":
      return fetchCondition(
        userId,
        id,
        rid,
        origin,
        kinds,
        await loadOwner(userId),
      );
    case "document":
      return fetchDocument(userId, id, rid, origin, kinds);
    case "vaccination":
      return fetchVaccination(userId, id, rid, origin, kinds);
  }
}
