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
 * Ranking and folding live in `@/lib/search/match`, shared with the in-app
 * search (`POST /api/search`), which reads its record kinds through
 * `loadRecordCandidates` here as well: one matcher, one set of record reads.
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
} from "@/lib/documents/content-index";
import { normalizeSearchText } from "@/lib/encounters/procedures";
import { encounterKindLabel } from "@/lib/encounters/kind-label";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";
import { listTargets } from "@/lib/links";
import {
  boundLinks,
  linksBySource,
  linksFor,
  linksSentence,
  type RecordLink,
} from "./record-links";
import { isModuleEnabled, type ModuleKey } from "@/lib/modules/gate";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import {
  CUSTOM_VACCINE_RESOLVE_SELECT,
  customLookupOf,
  resolveVaccineEntry,
} from "@/lib/vaccinations/resolve-vaccine-entry";
import {
  MAX_QUERY_WORDS,
  MIN_SUBSTRING_WORD,
  WEIGHT,
  queryWords,
  type SearchCandidate,
} from "@/lib/search/match";
import { visitPath } from "@/lib/encounters/visit-links";

// ── Bounds ───────────────────────────────────────────────────────────

/** Rows one search decrypts and matches, per record kind. */
export const MAX_ROWS_PER_KIND = 500;
/** Newest records per kind listed when the query is empty. */
export const EMPTY_QUERY_PER_KIND = 10;
/** Characters of indexed document text one `fetch` returns. */
export const MAX_DOCUMENT_EXCERPT_CHARS = 1500;

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

// ── Matching and ranking ─────────────────────────────────────────────
// Shared with the in-app search; see `@/lib/search/match`.

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
      return `${origin}${visitPath(id)}`;
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
  /** The language of the in-app display data (`SearchCandidate.hit`). */
  display: Locale;
}

async function loadOwner(userId: string, display?: Locale): Promise<Owner> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true, timezone: true },
  });
  const locale = resolveLocale(row?.locale);
  return {
    locale,
    timezone: row?.timezone ?? DEFAULT_TIMEZONE,
    display: display ?? locale,
  };
}

/** The in-app path of one record: `recordUrl` without an origin. */
export function recordPath(kind: RecordKind, id: string): string {
  return recordUrl("", kind, id);
}

/** "left Knee" in the display language, or the site alone. */
function sitePhrase(
  site: string | null,
  laterality: Laterality | null,
  display: Locale,
): string | null {
  if (!site) return null;
  if (!laterality) return site;
  const key =
    laterality === "LEFT"
      ? "encounters.laterality.left"
      : laterality === "RIGHT"
        ? "encounters.laterality.right"
        : "encounters.laterality.both";
  return `${site} (${getServerTranslator(display).t(key)})`;
}

function compact(values: ReadonlyArray<string | null | undefined>): string[] {
  return values
    .map((v) => v?.replace(/\s+/g, " ").trim() ?? "")
    .filter((v) => v.length > 0);
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
 * The practitioner columns a record read selects. A live visit or dose names
 * the practitioner it was with even after the address-book entry is deleted,
 * as the web record and the doctor report do: deleting the entry takes it out
 * of the address book and the pickers, not out of the history. The purge keeps
 * the entry for as long as a live record names it (`soft-delete-retention.ts`).
 */
const PRACTITIONER_SELECT = {
  select: { name: true, specialty: true },
} as const;

type PractitionerRow = {
  name: string;
  specialty: string | null;
} | null;

/** The practitioner a live visit or dose names, or null. */
export function visitPractitioner(
  row: PractitionerRow | undefined,
): { name: string; specialty: string | null } | null {
  return row ? { name: row.name, specialty: row.specialty } : null;
}

async function visitCandidates(
  userId: string,
  owner: Owner,
  origin: string,
  read: KindRead,
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
    take: probeTake(read),
    include: { practitioner: PRACTITIONER_SELECT },
  });
  return mapUntilStopped(
    withinCap(rows, read),
    read,
    (row): SearchCandidate => {
      const practitioner = visitPractitioner(row.practitioner);
      const reason = decryptText(row.reasonEncrypted);
      const outcome = decryptText(row.outcomeEncrypted);
      const bodySite = decryptText(row.bodySiteEncrypted);
      const day = userDayKey(row.occurredAt, owner.timezone);
      const kindLabel = encounterKindLabel(row.kind, owner.display);
      const title = reason?.replace(/\s+/g, " ").trim() || null;
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
        hit: {
          kind: "visit",
          recordId: row.id,
          title: title ?? kindLabel,
          context: compact([
            title ? kindLabel : null,
            practitioner?.name,
            sitePhrase(bodySite, row.laterality, owner.display),
          ]),
          day,
          path: recordPath("visit", row.id),
        },
        fields: [
          { text: bodySite ?? "", weight: WEIGHT.primary },
          { text: reason ?? "", weight: WEIGHT.primary, body: true },
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
          { text: outcome ?? "", weight: WEIGHT.secondary, body: true },
        ],
      };
    },
  );
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
  read: KindRead,
): Promise<SearchCandidate[]> {
  const rows = await prisma.illnessEpisode.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ onsetAt: "desc" }, { id: "asc" }],
    take: probeTake(read),
    select: CONDITION_SELECT,
  });
  return mapUntilStopped(
    withinCap(rows, read),
    read,
    (row): SearchCandidate => {
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
        hit: {
          kind: "condition",
          recordId: row.id,
          title: row.label,
          context: compact([
            illnessTypeLabel(row.type, owner.display),
            sitePhrase(bodySite, row.laterality, owner.display),
          ]),
          day,
          path: recordPath("condition", row.id),
        },
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
    },
  );
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
  includeAiDeferred: boolean,
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
          // text over MCP either; its title and kind still are. The person's
          // own in-app search is not an AI surface and reads it.
          document: {
            deletedAt: null,
            ...(includeAiDeferred ? {} : { aiReadDeferred: false }),
          },
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
  read: KindRead,
  query: string,
  words: readonly string[],
  includeAiDeferred: boolean,
): Promise<SearchCandidate[]> {
  const nameTerms = documentNameTerms(query, words);
  const [probed, content, named] = await Promise.all([
    prisma.inboundDocument.findMany({
      where: { userId, deletedAt: null },
      select: DOCUMENT_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: probeTake(read),
    }),
    words.length > 0
      ? contentMatches(userId, words, includeAiDeferred)
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
  // The cap applies to the newest read; the extra rows below are content and
  // name hits beyond it, already bounded by their own read.
  const rows = withinCap(probed, read);
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

  return mapUntilStopped([...rows, ...extra], read, (row): SearchCandidate => {
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
      hit: {
        kind: "document",
        recordId: row.id,
        title:
          row.title ??
          row.filename ??
          documentKindLabel(row.kind, owner.display),
        context: compact([
          documentKindLabel(row.kind, owner.display),
          row.title ? row.filename : null,
        ]),
        day: dated
          ? dateOnly(dated)
          : userDayKey(row.createdAt, owner.timezone),
        path: recordPath("document", row.id),
      },
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
  read: KindRead,
): Promise<SearchCandidate[]> {
  const rows = await prisma.vaccinationRecord.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
    take: probeTake(read),
    select: VACCINATION_SELECT,
  });
  return mapUntilStopped(
    withinCap(rows, read),
    read,
    (row): SearchCandidate => {
      const practitioner = visitPractitioner(row.practitioner);
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
        hit: {
          kind: "vaccination",
          recordId: row.id,
          title:
            row.vaccineName ??
            vaccineCatalogName(row.antigenSlug, owner.display) ??
            own?.name ??
            row.antigenSlug ??
            null,
          context: compact([practitioner?.name]),
          day,
          path: recordPath("vaccination", row.id),
        },
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
    },
  );
}

export interface RecordSearchOptions {
  /**
   * The kinds to read. Defaults to the account's module switches; the in-app
   * search passes its own set, narrowed by the module map and by the
   * sections a delegate's grant covers.
   */
  kinds?: ReadonlySet<RecordKind>;
  /** The language of `SearchCandidate.hit`; defaults to the owner's. */
  displayLocale?: Locale;
  /**
   * Match a document's indexed text even when it was held back from AI
   * reading. Only the person's own in-app search sets it; MCP never does.
   */
  includeAiDeferredText?: boolean;
  /** Newest rows read per kind; defaults to `MAX_ROWS_PER_KIND`. */
  rowsPerKind?: number;
  /**
   * Asked before each kind starts and before every row a kind decrypts.
   * Once it says stop, the kind keeps what it has (its newest rows) and
   * `onTruncated` is told. The in-app search hands its shared time budget
   * and the request's abort signal in here.
   */
  shouldStop?: () => boolean;
  /**
   * Told when a kind did not see all of its rows: it filled its newest
   * `rowsPerKind` read, or `shouldStop` ended it part-way.
   */
  onTruncated?: (kind: RecordKind) => void;
}

/** How one kind reads: its row cap, and the stop and truncation hooks. */
interface KindRead {
  take: number;
  shouldStop: () => boolean;
  onTruncated: () => void;
}

/**
 * A kind's newest read asks for one row past its cap. The extra row only
 * answers whether anything older is left: a kind holding exactly `take` rows
 * was read whole and is not reported cut short.
 */
function probeTake(read: KindRead): number {
  return read.take + 1;
}

/** The rows within the cap, telling `onTruncated` when the probe row came. */
function withinCap<Row>(rows: Row[], read: KindRead): Row[] {
  if (rows.length <= read.take) return rows;
  read.onTruncated();
  return rows.slice(0, read.take);
}

/**
 * Map a kind's rows newest first until `shouldStop` says stop. The rows are
 * read already; what this bounds is the decrypting and the building, which is
 * where a large record spends its time.
 */
function mapUntilStopped<Row, Out>(
  rows: readonly Row[],
  read: KindRead,
  build: (row: Row) => Out,
): Out[] {
  const out: Out[] = [];
  for (const row of rows) {
    if (read.shouldStop()) {
      read.onTruncated();
      break;
    }
    out.push(build(row));
  }
  return out;
}

/**
 * Every record candidate this account can see for one query. Unranked; the
 * caller ranks them together with its other kinds.
 */
export async function loadRecordCandidates(
  userId: string,
  query: string,
  origin: string,
  options: RecordSearchOptions = {},
): Promise<SearchCandidate[]> {
  const words = queryWords(query);
  const empty = normalizeSearchText(query).length === 0;
  const take = empty
    ? EMPTY_QUERY_PER_KIND
    : (options.rowsPerKind ?? MAX_ROWS_PER_KIND);
  const [kinds, owner] = await Promise.all([
    options.kinds ? Promise.resolve(options.kinds) : readableKinds(userId),
    loadOwner(userId, options.displayLocale),
  ]);
  const shouldStop = options.shouldStop ?? (() => false);
  const reading = (kind: RecordKind): KindRead | null => {
    if (!kinds.has(kind)) return null;
    const onTruncated = () => options.onTruncated?.(kind);
    if (shouldStop()) {
      onTruncated();
      return null;
    }
    return { take, shouldStop, onTruncated };
  };
  const visit = reading("visit");
  const condition = reading("condition");
  const document = reading("document");
  const vaccination = reading("vaccination");
  const groups = await Promise.all([
    visit
      ? visitCandidates(userId, owner, origin, visit, empty)
      : Promise.resolve([]),
    condition
      ? conditionCandidates(userId, owner, origin, condition)
      : Promise.resolve([]),
    document
      ? documentCandidates(
          userId,
          owner,
          origin,
          document,
          query,
          words,
          options.includeAiDeferredText === true,
        )
      : Promise.resolve([]),
    vaccination
      ? vaccinationCandidates(userId, owner, origin, vaccination)
      : Promise.resolve([]),
  ]);
  return groups.flat();
}

// ── Fetch ────────────────────────────────────────────────────────────

export interface FetchResult {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, unknown>;
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
    ...(await linksFor(userId, "conditionEpisode", conditions)),
    ...(await linksFor(userId, "document", documents)),
    ...(await linksFor(userId, "labResult", labs)),
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
  const live = visitPractitioner(row.practitioner);
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
    ...(await linksFor(userId, "encounter", visits)),
    ...(await linksFor(userId, "document", documents)),
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

/** What a document lists as linked, in this order. */
const DOCUMENT_LINK_TARGETS = [
  "encounter",
  "conditionEpisode",
  "vaccination",
  "labResult",
  "medication",
] as const;

async function fetchDocument(
  userId: string,
  id: string,
  rid: string,
  origin: string,
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

  // The lab results read from this document and the medications filed
  // against it are listed too, each behind its own module like the rest.
  const [content, linked] = await Promise.all([
    deferred
      ? Promise.resolve({ indexed: false, excerpt: null })
      : documentExcerpt(userId, rid),
    linksBySource(userId, "document", [rid], DOCUMENT_LINK_TARGETS),
  ]);
  const { links, linksTruncated } = boundLinks(linked.get(rid) ?? []);

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
    ...(await linksFor(userId, "document", documents)),
  ]);

  const catalog = vaccineCatalogName(row.antigenSlug, "en");
  const own = ownVaccine(row);
  const name =
    row.vaccineName ?? catalog ?? own?.name ?? row.antigenSlug ?? "Vaccination";
  const practitioner = visitPractitioner(row.practitioner);
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
      return fetchDocument(userId, id, rid, origin);
    case "vaccination":
      return fetchVaccination(userId, id, rid, origin, kinds);
  }
}
