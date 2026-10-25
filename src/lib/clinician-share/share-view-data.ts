/**
 * v1.11.0 — scoped data load for the public clinician view (Epic C, C5).
 *
 * Given a {@link ShareContext} (already proven by {@link resolveShareToken}),
 * aggregate exactly the data the owner froze into the link: the doctor-report
 * payload over the frozen `[rangeStart, rangeEnd]` window with the frozen
 * section toggles. The owner `userId` comes ONLY from the share context — never
 * from a session, never from the wire.
 *
 * KVNR is DEFAULT OFF: the clinician view never decrypts or surfaces the
 * insurance number. The descriptive wellness scores are kept (the view fences
 * them under an explicit "not a clinical assessment" card), but they are read
 * straight from the aggregator — no AI call, no coach, no insight generation.
 */
import { prisma } from "@/lib/db";
import {
  collectDoctorReportData,
  type DoctorReportData,
  type DoctorReportRange,
} from "@/lib/doctor-report-data";
import { resolveModuleMap } from "@/lib/modules/gate";
import { servingClassFor } from "@/lib/documents/upload-policy";
import type { DocumentServingClass } from "@/lib/documents/upload-policy";
import {
  LEAF_MODULE,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";
import {
  isEmptySelection,
  selectionFromStoredBlob,
  type ReportSelection,
} from "@/lib/report-selection/selection";
import type { ShareContext } from "@/lib/clinician-share/resolve-share-token";
import { dateOnlyKey } from "@/lib/tz/date-only";

/**
 * v1.28 — metadata for one document on the share's frozen set. NEVER carries
 * bytes: the share serve route (`/c/<token>/d/<id>`) is the only decrypt path
 * (P3-D5). The recipient view renders this list and points each entry at that
 * route (Class A inline preview / Class B download).
 */
export interface ShareViewDocument {
  id: string;
  title: string | null;
  kind: string;
  /** Filing date (YYYY-MM-DD at UTC) or null. */
  documentDate: string | null;
  byteSize: number;
  /**
   * The stored content type (metadata, never bytes). The recipient view uses
   * it to pick the inline surface — an image tag for `image/*`, a framed PDF
   * for `application/pdf` — within the Class A carve-out. Class B types are
   * download-only regardless.
   */
  mimeType: string;
  servingClass: DocumentServingClass;
}

export interface ShareViewData {
  /**
   * The aggregated, owner-scoped report payload over the frozen window, or
   * `null` for a documents-only share. `null` is the load-bearing privacy
   * state: the aggregator is NEVER called, so no health data leaves the DB —
   * the recipient sees only the attached documents.
   */
  report: DoctorReportData | null;
  /** The link's frozen selection, resolved. Empty when it carries no scope. */
  selection: ReportSelection;
  /**
   * Leaves the owner DID freeze onto the link and whose owning module is
   * switched off on the account it came from.
   *
   * The aggregator ANDs the two gates and returns the same `null` either way,
   * so the payload alone cannot tell "shared, nothing recorded" from "shared,
   * but the domain is switched off here". The recipient is owed that
   * difference — a doctor reading an empty Lab results card should know
   * whether the person has no results or whether the section never had a
   * chance to carry any — so the second gate's verdict is carried alongside
   * the payload rather than being collapsed into it.
   *
   * Only leaves the selection carries appear here: a leaf that was never
   * shared is not the recipient's business in any state.
   */
  unavailableLeaves: ReportLeafId[];
  /** v1.28 — the hand-picked documents on this link (metadata only). */
  documents: ShareViewDocument[];
  /**
   * v1.28.13 — whether this link carries ONLY documents (no report section
   * enabled). The public view reads it to render a documents-only surface with
   * no health-record chrome.
   */
  documentOnly: boolean;
}

/**
 * Resolve the frozen reporting window from the share context. `rangeEnd` null
 * means "rolling up to now"; the start is always the absolute instant the
 * owner froze, so a rolling share can never reach data older than chosen.
 */
function frozenRange(context: ShareContext): DoctorReportRange {
  const start = context.rangeStart;
  const end = context.rangeEnd ?? new Date();
  const spanDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / 86_400_000),
  );
  return { start, end, days: spanDays };
}

/**
 * Load the scoped read-only view for a resolved share token. Pure data
 * assembly — no auth (the token was already proven), no rate-limit (the route
 * owns that), no session, no AI.
 */
export async function loadShareViewData(
  context: ShareContext,
): Promise<ShareViewData> {
  // The link's frozen scope. A blob this build cannot read — a legacy shape, a
  // hand-edited row — resolves to the EMPTY selection, so the link serves
  // nothing rather than defaulting open. Every such link was revoked by the
  // v1.32.37 migration; this is the second lock behind that.
  const selection = selectionFromStoredBlob(context.sectionsJson);
  const range = frozenRange(context);

  // A documents-only share never aggregates — no health metric is read from the
  // DB, let alone served. This is the load-bearing guarantee behind "share this
  // document, not the record". v1.28.16: the frozen `documentOnly` COLUMN is
  // authoritative; the derived all-sections-off check remains as the fallback
  // for legacy links minted before the column (where it reads `false`). Because
  // the column can only pin — never widen — this is strictly safer than the
  // derived check alone: a future report section can never re-open a link the
  // owner froze as documents-only.
  // v1.30.22 — the owner's `doctorReport` module gates the aggregate here too.
  // This surface serves the doctor-report payload to an unauthenticated third
  // party over a link, and it never consulted the module key; an owner (or an
  // operator, via the availability switch ANDed above the user toggle) who
  // turns the module off would still have had the full record served. Found
  // while closing the same gap on the MCP surface.
  //
  // Degrade to the share's OWN documents-only state rather than throwing:
  // `documentOnly` is an existing, load-bearing privacy mode on this surface
  // (report `null`, aggregator never called), so a disabled module collapses
  // the link to exactly the documents the owner attached. That is fail-closed
  // for the health record while keeping a public link from 500-ing. The
  // documents themselves are a separate module with their own gate below.
  //
  // The whole map is resolved rather than the one key, because the per-leaf
  // verdicts below come off the same read. It is NOT handed to the aggregator:
  // the third argument is the frozen selection and there is deliberately no
  // fourth, so this surface cannot grow an options object that widens what it
  // asks for. `resolveModuleMap` memoises its DB reads per request, so the
  // aggregator resolving its own map again costs no round-trip.
  const moduleMap = await resolveModuleMap(context.ownerUserId);
  const documentOnly =
    context.documentOnly ||
    isEmptySelection(selection) ||
    moduleMap.doctorReport === false;

  // Shared, but switched off at the source. Derived from the SAME map the
  // aggregator gates with, so the notice on the page and the absence of the
  // data behind it can never disagree.
  const unavailableLeaves = selection.leaves.filter((leaf) => {
    const moduleKey = LEAF_MODULE[leaf];
    return moduleKey !== undefined && moduleMap[moduleKey] === false;
  });

  const [report, documents] = await Promise.all([
    documentOnly
      ? Promise.resolve(null)
      : collectDoctorReportData(context.ownerUserId, range, selection),
    // With the documents module off, the link lists no document, and the
    // serve route (`/c/[token]/d/[id]`) answers 404 for each of them.
    moduleMap.inboundDocuments === false
      ? Promise.resolve([])
      : loadShareDocuments(context),
  ]);

  return { report, selection, unavailableLeaves, documents, documentOnly };
}

/**
 * The frozen document set for a resolved share, as metadata only. Scoped to
 * the link's membership rows AND the owner (defence in depth) AND live rows —
 * a document the owner soft-deleted after sharing drops out of the list, just
 * as it 404s at the serve route. The blob column is never selected.
 */
async function loadShareDocuments(
  context: ShareContext,
): Promise<ShareViewDocument[]> {
  const rows = await prisma.clinicianShareLinkDocument.findMany({
    where: {
      shareLinkId: context.shareLinkId,
      document: { userId: context.ownerUserId, deletedAt: null },
    },
    select: {
      document: {
        select: {
          id: true,
          title: true,
          kind: true,
          documentDate: true,
          byteSize: true,
          mimeType: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map(({ document }) => ({
    id: document.id,
    title: document.title,
    kind: document.kind,
    documentDate: document.documentDate
      ? dateOnlyKey(document.documentDate)
      : null,
    byteSize: document.byteSize,
    mimeType: document.mimeType,
    servingClass: servingClassFor(document.mimeType),
  }));
}
