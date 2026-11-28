/**
 * The link service itself. See `index.ts` for why it exists and what it
 * guarantees; this file is the implementation and the table of link kinds.
 */
import type { Prisma } from "@/generated/prisma/client";

/**
 * The document bulk route's own cap. A link call is a filing action, not an
 * import, so naming more ids than this is a client defect.
 */
export const MAX_TARGETS_PER_CALL = 100;

/** The record a link hangs off. */
export type LinkSourceKind =
  | "encounter"
  | "document"
  | "vaccination"
  | "conditionEpisode"
  | "medication"
  | "labResult"
  // Imaging: outside the relation matrix, read from the exam only.
  | "imagingExam";

/** The record a link points at. */
export type LinkTargetKind =
  | "document"
  | "labResult"
  | "conditionEpisode"
  | "encounter"
  | "vaccination"
  | "medication";

export interface LinkRequest {
  userId: string;
  sourceKind: LinkSourceKind;
  sourceId: string;
  targetKind: LinkTargetKind;
  targetIds: string[];
}

export interface LinkResult {
  /**
   * Rows actually written or removed.
   *
   * Zero is a success, not a failure: linking a pair that already exists, or
   * unlinking one that never did, is the idempotent no-op the callers rely on.
   */
  changed: number;
  /**
   * Ids that named nothing this account owns, or a row it has deleted.
   *
   * Returned rather than thrown. A bulk filing action treats one unknown id as
   * one failed row and keeps going; an upload treats it as a refusal of the
   * whole request. Both are legitimate and neither belongs in here.
   */
  unknownTargetIds: string[];
  /** True when the source itself is unknown, foreign or deleted. */
  unknownSource: boolean;
}

/** One resolved link target, ready for a DTO. Never just an id. */
export interface LinkedTarget {
  id: string;
  label: string;
  /** The date that makes the target sortable and recognisable, ISO-8601. */
  date: string | null;
}

/**
 * Prisma's generated delegates are structurally compatible with the narrow
 * shapes below, but each model's argument types are nominally distinct, so a
 * table keyed by link kind cannot be written without one narrowing per
 * accessor. The casts are confined to {@link LINK_TABLES} and every call in
 * this file goes through it.
 */
interface LinkRowDelegate {
  createMany(args: {
    data: Array<Record<string, string>>;
    skipDuplicates?: boolean;
  }): Promise<{ count: number }>;
  deleteMany(args: {
    where: Record<string, unknown>;
  }): Promise<{ count: number }>;
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean | Record<string, unknown>>;
    orderBy?: Record<string, unknown>;
  }): Promise<Array<Record<string, unknown>>>;
}

interface OwnedRowDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    select: Record<string, boolean>;
  }): Promise<Array<Record<string, unknown>>>;
}

interface EndpointSpec {
  /** The owning model's delegate, for the ownership re-read. */
  delegate: (tx: Prisma.TransactionClient) => OwnedRowDelegate;
  /**
   * Whether the model carries a `deletedAt` tombstone. A medication does
   * not (it is paused or ended, never tombstoned), so filtering it on the
   * column would be a query error rather than a no-op.
   */
  softDeletes: boolean;
  /** Columns the label and date are derived from. */
  select: Record<string, boolean>;
  label: (row: Record<string, unknown>) => string;
  date: (row: Record<string, unknown>) => string | null;
}

interface LinkTableSpec {
  delegate: (tx: Prisma.TransactionClient) => LinkRowDelegate;
  sourceColumn: string;
  targetColumn: string;
  target: EndpointSpec;
}

/**
 * The one narrowing point.
 *
 * Prisma generates a distinct argument type per model, so a table keyed by
 * link kind cannot hold them without erasing the difference. Going through
 * `unknown` here rather than at each accessor keeps the unsafety countable:
 * every delegate in this file is narrowed by this function and nowhere else,
 * and the column names it is narrowed FOR are declared beside it in
 * {@link LINK_TABLES}.
 */
function narrow<T>(delegate: unknown): T {
  return delegate as T;
}

/** The "still live" filter for a model, empty for one without a tombstone. */
function live(softDeletes: boolean): { deletedAt?: null } {
  return softDeletes ? { deletedAt: null } : {};
}

function asDate(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Where a source record lives, and how to prove the caller owns a live one. */
const SOURCES: Record<
  LinkSourceKind,
  {
    delegate: (tx: Prisma.TransactionClient) => OwnedRowDelegate;
    /** The link row's relation field back to the source, for a joined filter. */
    relationField: string;
    softDeletes: boolean;
  }
> = {
  encounter: {
    delegate: (tx) => narrow<OwnedRowDelegate>(tx.encounter),
    relationField: "encounter",
    softDeletes: true,
  },
  document: {
    delegate: (tx) => narrow<OwnedRowDelegate>(tx.inboundDocument),
    relationField: "document",
    softDeletes: true,
  },
  vaccination: {
    delegate: (tx) => narrow<OwnedRowDelegate>(tx.vaccinationRecord),
    relationField: "vaccination",
    softDeletes: true,
  },
  // A condition is a source in the read direction of the tables that file
  // things against it (see the `conditionEpisode:*` pairs below).
  conditionEpisode: {
    delegate: (tx) => narrow<OwnedRowDelegate>(tx.illnessEpisode),
    relationField: "episode",
    softDeletes: true,
  },
  // v1.43 — a medication files its indication, its documents and its visits.
  medication: {
    delegate: (tx) => narrow<OwnedRowDelegate>(tx.medication),
    relationField: "medication",
    softDeletes: false,
  },
  // v1.43 — a lab result files the report it was read from and its visits.
  labResult: {
    delegate: (tx) => narrow<OwnedRowDelegate>(tx.labResult),
    relationField: "labResult",
    softDeletes: true,
  },
  imagingExam: {
    delegate: (tx) => narrow<OwnedRowDelegate>(tx.imagingExam),
    relationField: "exam",
    softDeletes: false,
  },
};

const DOCUMENT_ENDPOINT: EndpointSpec = {
  delegate: (tx) => narrow<OwnedRowDelegate>(tx.inboundDocument),
  softDeletes: true,
  select: {
    id: true,
    title: true,
    filename: true,
    documentDate: true,
    reportDate: true,
    createdAt: true,
  },
  // A vault document may carry neither a title nor a filename; the id is the
  // last honest thing left rather than an invented placeholder.
  label: (row) =>
    asString(row.title) ?? asString(row.filename) ?? String(row.id),
  date: (row) =>
    asDate(row.documentDate) ?? asDate(row.reportDate) ?? asDate(row.createdAt),
};

const LAB_RESULT_ENDPOINT: EndpointSpec = {
  delegate: (tx) => narrow<OwnedRowDelegate>(tx.labResult),
  softDeletes: true,
  select: { id: true, analyte: true, panel: true, takenAt: true },
  label: (row) => {
    const panel = asString(row.panel);
    const analyte = String(row.analyte);
    return panel ? `${panel} · ${analyte}` : analyte;
  },
  date: (row) => asDate(row.takenAt),
};

const ENCOUNTER_ENDPOINT: EndpointSpec = {
  delegate: (tx) => narrow<OwnedRowDelegate>(tx.encounter),
  softDeletes: true,
  select: { id: true, kind: true, occurredAt: true },
  // The visit's KIND, as the enum constant, and this is the one endpoint whose
  // label is deliberately not prose. A document title and an analyte name are
  // the person's own words and mean the same thing in every language; a visit
  // kind is one of eight closed values whose human name is a presentation
  // choice. Publishing the constant is what lets a German reader and an
  // English one each see it named correctly from their own bundle, which a
  // server-side string chosen once could not do.
  label: (row) => String(row.kind),
  date: (row) => asDate(row.occurredAt),
};

const VACCINATION_ENDPOINT: EndpointSpec = {
  delegate: (tx) => narrow<OwnedRowDelegate>(tx.vaccinationRecord),
  softDeletes: true,
  select: { id: true, antigenSlug: true, vaccineName: true, occurredAt: true },
  // The person's own wording first, then the catalogue slug. A caller that
  // renders a dose resolves the slug through its own bundle instead (see
  // `loadDocumentVaccinationLinks`); this label is the fallback every
  // generic consumer of the service gets.
  label: (row) =>
    asString(row.vaccineName) ?? asString(row.antigenSlug) ?? String(row.id),
  date: (row) => asDate(row.occurredAt),
};

const CONDITION_ENDPOINT: EndpointSpec = {
  delegate: (tx) => narrow<OwnedRowDelegate>(tx.illnessEpisode),
  softDeletes: true,
  select: { id: true, label: true, onsetAt: true },
  label: (row) => String(row.label),
  date: (row) => asDate(row.onsetAt),
};

const MEDICATION_ENDPOINT: EndpointSpec = {
  delegate: (tx) => narrow<OwnedRowDelegate>(tx.medication),
  softDeletes: false,
  select: { id: true, name: true, dose: true, startsOn: true, createdAt: true },
  label: (row) => {
    const dose = asString(row.dose);
    return dose ? `${String(row.name)} ${dose}` : String(row.name);
  },
  date: (row) => asDate(row.startsOn) ?? asDate(row.createdAt),
};

/**
 * Every legal (source, target) pair and the table behind it.
 *
 * A pair absent from here is not linkable, and asking for one is a programming
 * error rather than a user error — hence the throw in {@link tableFor} rather
 * than a result field.
 *
 * Since v1.43 this is the storage half of the relation matrix: every pair of
 * lab result, visit, document, condition, medication and vaccination either
 * has a table here (written in one direction, read in both) or is a written
 * exception in `src/lib/links/related.ts`, and `relation-matrix.test.ts` holds
 * the two together. The earlier ceilings (three visit tables, one vaccination
 * pair) were lifted by that decision rather than by drift: a visit that
 * prescribed a medication or gave a dose was a dead end otherwise. Each table
 * is still a named relation between two records, never a general edge store.
 */
const LINK_TABLES: Partial<
  Record<`${LinkSourceKind}:${LinkTargetKind}`, LinkTableSpec>
> = {
  "encounter:document": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterDocumentLink),
    sourceColumn: "encounterId",
    targetColumn: "documentId",
    target: DOCUMENT_ENDPOINT,
  },
  "encounter:labResult": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterLabLink),
    sourceColumn: "encounterId",
    targetColumn: "labResultId",
    target: LAB_RESULT_ENDPOINT,
  },
  "encounter:conditionEpisode": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterConditionLink),
    sourceColumn: "encounterId",
    targetColumn: "episodeId",
    target: CONDITION_ENDPOINT,
  },
  "document:conditionEpisode": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.documentConditionLink),
    sourceColumn: "documentId",
    targetColumn: "episodeId",
    target: CONDITION_ENDPOINT,
  },
  // The SAME table as `encounter:document`, read from the document's end
  // ("which visits is this filed against").
  "document:encounter": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterDocumentLink),
    sourceColumn: "documentId",
    targetColumn: "encounterId",
    target: ENCOUNTER_ENDPOINT,
  },
  "vaccination:document": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.vaccinationDocumentLink),
    sourceColumn: "vaccinationId",
    targetColumn: "documentId",
    target: DOCUMENT_ENDPOINT,
  },
  // The SAME table as `vaccination:document`, read from the other end, like
  // `document:encounter` beside it. A childhood record covering a dozen doses
  // is filed from the document's own sheet in one pass rather than dose by
  // dose; the dose's form and the document's sheet write one table, so they
  // cannot disagree about what is filed where. A second direction, not a
  // second vaccination table.
  "document:vaccination": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.vaccinationDocumentLink),
    sourceColumn: "documentId",
    targetColumn: "vaccinationId",
    target: VACCINATION_ENDPOINT,
  },
  // v1.39.2 — the body-site view walks from a condition to what is filed
  // against it. Both pairs are an existing table read from the condition's
  // end, the way `document:encounter` reads the visit table from the
  // document's: `document_condition_links` answers "which documents are about
  // this condition" and `encounter_condition_links` "which visits were for
  // it". A second direction each, not a new table, so the ceiling above is
  // untouched.
  "conditionEpisode:document": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.documentConditionLink),
    sourceColumn: "episodeId",
    targetColumn: "documentId",
    target: DOCUMENT_ENDPOINT,
  },
  "conditionEpisode:encounter": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterConditionLink),
    sourceColumn: "episodeId",
    targetColumn: "encounterId",
    target: ENCOUNTER_ENDPOINT,
  },

  // ── v1.43 — the pairs that close the relation matrix ──────────────────────
  // `lab_result_document_links`: the report a result was read from. Written
  // from the result's links route and, one document to many results, by the
  // scan commit.
  "labResult:document": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.labResultDocumentLink),
    sourceColumn: "labResultId",
    targetColumn: "documentId",
    target: DOCUMENT_ENDPOINT,
  },
  "document:labResult": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.labResultDocumentLink),
    sourceColumn: "documentId",
    targetColumn: "labResultId",
    target: LAB_RESULT_ENDPOINT,
  },
  // `encounter_lab_links` read from the result's end.
  "labResult:encounter": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterLabLink),
    sourceColumn: "labResultId",
    targetColumn: "encounterId",
    target: ENCOUNTER_ENDPOINT,
  },
  // `encounter_medication_links`: prescribed, changed or reviewed at a visit.
  "encounter:medication": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterMedicationLink),
    sourceColumn: "encounterId",
    targetColumn: "medicationId",
    target: MEDICATION_ENDPOINT,
  },
  "medication:encounter": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterMedicationLink),
    sourceColumn: "medicationId",
    targetColumn: "encounterId",
    target: ENCOUNTER_ENDPOINT,
  },
  // `encounter_vaccination_links`: a dose given at a visit.
  "encounter:vaccination": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterVaccinationLink),
    sourceColumn: "encounterId",
    targetColumn: "vaccinationId",
    target: VACCINATION_ENDPOINT,
  },
  "vaccination:encounter": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.encounterVaccinationLink),
    sourceColumn: "vaccinationId",
    targetColumn: "encounterId",
    target: ENCOUNTER_ENDPOINT,
  },
  // `medication_document_links`: a prescription, a plan, a package insert.
  "medication:document": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.medicationDocumentLink),
    sourceColumn: "medicationId",
    targetColumn: "documentId",
    target: DOCUMENT_ENDPOINT,
  },
  "document:medication": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.medicationDocumentLink),
    sourceColumn: "documentId",
    targetColumn: "medicationId",
    target: MEDICATION_ENDPOINT,
  },
  // `medication_condition_links`: the indication.
  "medication:conditionEpisode": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.medicationConditionLink),
    sourceColumn: "medicationId",
    targetColumn: "episodeId",
    target: CONDITION_ENDPOINT,
  },
  "conditionEpisode:medication": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.medicationConditionLink),
    sourceColumn: "episodeId",
    targetColumn: "medicationId",
    target: MEDICATION_ENDPOINT,
  },
  "imagingExam:document": {
    delegate: (tx) => narrow<LinkRowDelegate>(tx.imagingExamDocumentLink),
    sourceColumn: "examId",
    targetColumn: "documentId",
    target: DOCUMENT_ENDPOINT,
  },
};

function tableFor(
  sourceKind: LinkSourceKind,
  targetKind: LinkTargetKind,
): LinkTableSpec {
  const spec = LINK_TABLES[`${sourceKind}:${targetKind}`];
  if (!spec) {
    throw new Error(
      `No link table joins a ${sourceKind} to a ${targetKind}. The legal pairs ` +
        `are declared in src/lib/links/link-service.ts; adding one is a schema ` +
        `decision, not a call-site decision.`,
    );
  }
  return spec;
}

function assertWithinCap(targetIds: string[]): void {
  if (targetIds.length > MAX_TARGETS_PER_CALL) {
    throw new Error(
      `A link call names ${targetIds.length} targets, above the cap of ` +
        `${MAX_TARGETS_PER_CALL}.`,
    );
  }
}

/** Does the caller own a LIVE source record with this id? */
async function ownsSource(
  tx: Prisma.TransactionClient,
  {
    userId,
    sourceKind,
    sourceId,
  }: Omit<LinkRequest, "targetKind" | "targetIds">,
): Promise<boolean> {
  const source = SOURCES[sourceKind];
  const rows = await source.delegate(tx).findMany({
    where: { id: sourceId, userId, ...live(source.softDeletes) },
    select: { id: true },
  });
  return rows.length === 1;
}

/** The subset of `targetIds` the caller owns and has not deleted. */
async function ownedTargetIds(
  tx: Prisma.TransactionClient,
  userId: string,
  spec: LinkTableSpec,
  targetIds: string[],
): Promise<Set<string>> {
  if (targetIds.length === 0) return new Set();
  const rows = await spec.target.delegate(tx).findMany({
    where: { id: { in: targetIds }, userId, ...live(spec.target.softDeletes) },
    select: { id: true },
  });
  return new Set(rows.map((row) => String(row.id)));
}

/**
 * Split a requested id list into the ones that may be written and the ones
 * that named nothing. Deduplicated first: a list naming the same document
 * twice is one link, and reporting it as two would overstate what happened.
 */
async function resolveTargets(
  tx: Prisma.TransactionClient,
  request: LinkRequest,
  spec: LinkTableSpec,
): Promise<{ owned: string[]; unknown: string[] }> {
  const unique = [...new Set(request.targetIds)];
  const owned = await ownedTargetIds(tx, request.userId, spec, unique);
  return {
    owned: unique.filter((id) => owned.has(id)),
    unknown: unique.filter((id) => !owned.has(id)),
  };
}

/**
 * Add links, leaving any that already exist untouched.
 *
 * `skipDuplicates` is what makes a re-post a success that changed nothing,
 * which is the contract the document bulk route already offers and the one a
 * client retrying a request depends on.
 */
export async function linkTargets(
  tx: Prisma.TransactionClient,
  request: LinkRequest,
): Promise<LinkResult> {
  assertWithinCap(request.targetIds);
  const spec = tableFor(request.sourceKind, request.targetKind);

  if (!(await ownsSource(tx, request))) {
    return { changed: 0, unknownTargetIds: [], unknownSource: true };
  }
  const { owned, unknown } = await resolveTargets(tx, request, spec);
  if (owned.length === 0) {
    return { changed: 0, unknownTargetIds: unknown, unknownSource: false };
  }

  const created = await spec.delegate(tx).createMany({
    data: owned.map((targetId) => ({
      [spec.sourceColumn]: request.sourceId,
      [spec.targetColumn]: targetId,
      userId: request.userId,
    })),
    skipDuplicates: true,
  });
  return {
    changed: created.count,
    unknownTargetIds: unknown,
    unknownSource: false,
  };
}

/**
 * Remove links.
 *
 * Ownership of the TARGET is deliberately not required here. A document the
 * account has since deleted still has a link row, and refusing to unlink it
 * would leave a filing nobody can clear. The link rows are scoped by `userId`
 * regardless, so nothing another account owns is reachable.
 */
export async function unlinkTargets(
  tx: Prisma.TransactionClient,
  request: LinkRequest,
): Promise<LinkResult> {
  assertWithinCap(request.targetIds);
  const spec = tableFor(request.sourceKind, request.targetKind);
  const unique = [...new Set(request.targetIds)];
  if (unique.length === 0) {
    return { changed: 0, unknownTargetIds: [], unknownSource: false };
  }

  const removed = await spec.delegate(tx).deleteMany({
    where: {
      userId: request.userId,
      [spec.sourceColumn]: request.sourceId,
      [spec.targetColumn]: { in: unique },
    },
  });
  return {
    changed: removed.count,
    unknownTargetIds: [],
    unknownSource: false,
  };
}

/**
 * Make the link set exactly `targetIds`: drop what is no longer named, add
 * what is missing.
 *
 * The delete runs before the ownership check on purpose. Clearing a link is
 * always allowed (see {@link unlinkTargets}), and doing it first means a
 * request naming one unknown id still applies the part of itself that was
 * valid, rather than leaving the set in a state the caller did not ask for.
 */
export async function replaceTargets(
  tx: Prisma.TransactionClient,
  request: LinkRequest,
): Promise<LinkResult> {
  assertWithinCap(request.targetIds);
  const spec = tableFor(request.sourceKind, request.targetKind);

  if (!(await ownsSource(tx, request))) {
    return { changed: 0, unknownTargetIds: [], unknownSource: true };
  }
  const { owned, unknown } = await resolveTargets(tx, request, spec);

  const removed = await spec.delegate(tx).deleteMany({
    where: {
      userId: request.userId,
      [spec.sourceColumn]: request.sourceId,
      [spec.targetColumn]: { notIn: owned },
    },
  });

  let created = 0;
  if (owned.length > 0) {
    const result = await spec.delegate(tx).createMany({
      data: owned.map((targetId) => ({
        [spec.sourceColumn]: request.sourceId,
        [spec.targetColumn]: targetId,
        userId: request.userId,
      })),
      skipDuplicates: true,
    });
    created = result.count;
  }

  return {
    changed: removed.count + created,
    unknownTargetIds: unknown,
    unknownSource: false,
  };
}

/**
 * The resolved targets currently linked to one source.
 *
 * Returns labels and dates, never bare ids: a client that had to fetch each
 * target to render a list would be re-deriving something the server already
 * knows, and the two would drift.
 */
export async function listTargets(
  tx: Prisma.TransactionClient,
  request: Omit<LinkRequest, "targetIds">,
): Promise<LinkedTarget[]> {
  const spec = tableFor(request.sourceKind, request.targetKind);

  const links = await spec.delegate(tx).findMany({
    where: {
      userId: request.userId,
      [spec.sourceColumn]: request.sourceId,
    },
    select: { [spec.targetColumn]: true },
    orderBy: { createdAt: "asc" },
  });
  const targetIds = links.map((link) => String(link[spec.targetColumn]));
  if (targetIds.length === 0) return [];

  // Re-read the targets rather than joining through the link's relation: the
  // soft-delete filter belongs on the target, and a tombstoned row must drop
  // out of the list even though its link row survives the soft delete.
  const rows = await spec.target.delegate(tx).findMany({
    where: {
      id: { in: targetIds },
      userId: request.userId,
      ...live(spec.target.softDeletes),
    },
    select: spec.target.select,
  });
  const byId = new Map(rows.map((row) => [String(row.id), row]));

  // Ordered by the link's own creation, so the list reads in the order the
  // person filed things rather than in whatever order the id lookup returned.
  return targetIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [{ id, label: spec.target.label(row), date: spec.target.date(row) }];
  });
}

/**
 * The resolved targets for MANY sources at once, as a map keyed by source id.
 *
 * One grouped query for the links and one for the targets, so a page of
 * documents costs two round trips rather than two per row. Sources with no
 * links are absent from the map rather than present with an empty array.
 *
 * `includeDeletedTargets` exists for one caller and is off by default. The
 * document vault has always rendered a condition chip through a relation join
 * with no tombstone filter, so a document filed against a condition the person
 * later deleted still shows it. Whether that is right is a product question
 * this refactor does not answer; changing it silently while moving the query
 * would be the wrong place to answer it.
 */
export async function listTargetsBySource(
  tx: Prisma.TransactionClient,
  request: {
    userId: string;
    sourceKind: LinkSourceKind;
    sourceIds: string[];
    targetKind: LinkTargetKind;
    includeDeletedTargets?: boolean;
  },
): Promise<Map<string, LinkedTarget[]>> {
  const map = new Map<string, LinkedTarget[]>();
  const sourceIds = [...new Set(request.sourceIds)];
  if (sourceIds.length === 0) return map;

  const spec = tableFor(request.sourceKind, request.targetKind);
  const links = await spec.delegate(tx).findMany({
    where: {
      userId: request.userId,
      [spec.sourceColumn]: { in: sourceIds },
    },
    select: { [spec.sourceColumn]: true, [spec.targetColumn]: true },
    orderBy: { createdAt: "asc" },
  });
  if (links.length === 0) return map;

  const targetIds = [
    ...new Set(links.map((link) => String(link[spec.targetColumn]))),
  ];
  const rows = await spec.target.delegate(tx).findMany({
    where: {
      id: { in: targetIds },
      userId: request.userId,
      ...(request.includeDeletedTargets ? {} : live(spec.target.softDeletes)),
    },
    select: spec.target.select,
  });
  const byId = new Map(rows.map((row) => [String(row.id), row]));

  for (const link of links) {
    const targetId = String(link[spec.targetColumn]);
    const row = byId.get(targetId);
    if (!row) continue;
    const sourceId = String(link[spec.sourceColumn]);
    const entry = map.get(sourceId) ?? [];
    entry.push({
      id: targetId,
      label: spec.target.label(row),
      date: spec.target.date(row),
    });
    map.set(sourceId, entry);
  }
  return map;
}

/**
 * Every distinct target this account has linked at least one LIVE source to.
 *
 * What a filter bar needs: the chips exist because something is filed under
 * them, whether or not that something is on the page currently loaded. The
 * source's tombstone is what "live" means here — a condition whose only
 * documents were all deleted is not offered as a filter.
 */
export async function listDistinctTargets(
  tx: Prisma.TransactionClient,
  request: {
    userId: string;
    sourceKind: LinkSourceKind;
    targetKind: LinkTargetKind;
  },
): Promise<LinkedTarget[]> {
  const spec = tableFor(request.sourceKind, request.targetKind);
  const source = SOURCES[request.sourceKind];

  const links = await spec.delegate(tx).findMany({
    where: {
      userId: request.userId,
      ...(source.softDeletes
        ? { [source.relationField]: { deletedAt: null } }
        : {}),
    },
    select: { [spec.targetColumn]: true },
    orderBy: { [spec.targetColumn]: "asc" },
  });
  const targetIds = [
    ...new Set(links.map((link) => String(link[spec.targetColumn]))),
  ];
  if (targetIds.length === 0) return [];

  const rows = await spec.target.delegate(tx).findMany({
    where: { id: { in: targetIds }, userId: request.userId },
    select: spec.target.select,
  });
  const byId = new Map(rows.map((row) => [String(row.id), row]));

  return targetIds.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    return [{ id, label: spec.target.label(row), date: spec.target.date(row) }];
  });
}
