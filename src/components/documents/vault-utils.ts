/**
 * Pure helpers for the Dokumente vault surface: URL-facet parsing and
 * serialisation (the page's filter state lives in the URL so every view is
 * deep-linkable and back-button-safe), the API query-string builder, the
 * month bucketing + row chunking the virtualized timeline renders from, the
 * upload-response contract (including the HTTP-200 `meta.duplicate` path),
 * and byte formatting. Kept out of the client components so they stay
 * trivially unit-testable without a render harness.
 */
import {
  DOCUMENT_LIST_DEFAULT_LIMIT,
  INBOUND_DOCUMENT_KINDS,
  type DocumentLinkedProcedureDto,
  type InboundDocumentDto,
  type InboundDocumentKindValue,
} from "@/lib/validations/inbound-documents";
import type { DocumentVaultFilters } from "@/lib/query-keys/documents";
import { userDayKey } from "@/lib/tz/format";

const KIND_SET = new Set<string>(INBOUND_DOCUMENT_KINDS);

/**
 * Parse the vault's URL search params (`?q&kind&episode&encounter&year`) into the
 * filter object. Unknown kinds are dropped (a hand-edited URL never 422s the
 * page), `kind` accepts repeats AND comma-separated values, and the result is
 * normalised (kinds sorted, empties omitted) so the same view always produces
 * the same TanStack cache key.
 */
export function parseVaultSearchParams(
  params: URLSearchParams,
): DocumentVaultFilters {
  const filters: DocumentVaultFilters = {};

  const q = params.get("q")?.trim();
  if (q) filters.q = q.slice(0, 100);

  const kinds = params
    .getAll("kind")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v): v is InboundDocumentKindValue => KIND_SET.has(v));
  if (kinds.length > 0) filters.kinds = [...new Set(kinds)].sort();

  const episode = params.get("episode")?.trim();
  if (episode) filters.episodeId = episode.slice(0, 40);

  // `?encounter=` is how a visit's own detail row reaches the vault filtered
  // to what that visit produced. No chip in the filter bar backs it: the facet
  // arrives by deep link from the visit and clears with the clear-all pill,
  // which is exactly what a one-way link needs and no more.
  const encounter = params.get("encounter")?.trim();
  if (encounter) filters.encounterId = encounter.slice(0, 40);

  const yearRaw = params.get("year");
  if (yearRaw && /^\d{4}$/.test(yearRaw)) {
    const year = Number(yearRaw);
    if (year >= 1900 && year <= 9999) filters.year = year;
  }

  return filters;
}

/**
 * Serialise the filter object back into the page URL's search string (no
 * leading `?`; empty string for the default view). Inverse of
 * `parseVaultSearchParams` — round-tripping is pinned by test so deep links
 * from the illness page / labs (`?episode=`, `?kind=LAB_RESULT`) stay stable.
 */
export function vaultFiltersToSearch(filters: DocumentVaultFilters): string {
  const sp = new URLSearchParams();
  if (filters.q) sp.set("q", filters.q);
  if (filters.kinds && filters.kinds.length > 0) {
    sp.set("kind", [...filters.kinds].sort().join(","));
  }
  if (filters.episodeId) sp.set("episode", filters.episodeId);
  if (filters.encounterId) sp.set("encounter", filters.encounterId);
  if (filters.year !== undefined) sp.set("year", String(filters.year));
  return sp.toString();
}

/** Count of active facets (search counts as one) for the clear-all pill. */
export function countActiveFilters(filters: DocumentVaultFilters): number {
  let count = 0;
  if (filters.q) count += 1;
  if (filters.kinds && filters.kinds.length > 0) count += filters.kinds.length;
  if (filters.episodeId) count += 1;
  if (filters.encounterId) count += 1;
  if (filters.year !== undefined) count += 1;
  return count;
}

/**
 * Build the `/api/documents/inbound` query string from the active facets and
 * a keyset cursor. The sort is pinned to the filing date, newest first — the
 * timeline IS the sort order. The API takes `episodeId` (the page URL uses
 * the shorter `episode`).
 */
export function buildVaultListApiSearch(
  filters: DocumentVaultFilters,
  cursor: string | null,
  limit: number = DOCUMENT_LIST_DEFAULT_LIMIT,
): string {
  const sp = new URLSearchParams();
  if (filters.q) sp.set("q", filters.q);
  if (filters.kinds && filters.kinds.length > 0) {
    sp.set("kind", filters.kinds.join(","));
  }
  if (filters.episodeId) sp.set("episodeId", filters.episodeId);
  if (filters.encounterId) sp.set("encounterId", filters.encounterId);
  if (filters.year !== undefined) sp.set("year", String(filters.year));
  sp.set("sort", "documentDate");
  sp.set("order", "desc");
  sp.set("limit", String(limit));
  if (cursor) sp.set("cursor", cursor);
  return sp.toString();
}

/** The date a document files under — its user filing date, else upload day. */
export function documentDateKey(
  doc: InboundDocumentDto,
  timezone: string,
): string {
  if (doc.documentDate) return doc.documentDate;
  // An undated document files under its upload day in the reader's zone: the
  // leading YYYY-MM-DD of `createdAt` is the UTC day, which puts an upload
  // late on the last evening of a month west of UTC into the next month.
  return userDayKey(new Date(doc.createdAt), timezone);
}

/** The YYYY-MM month bucket a document files under. */
export function documentMonthKey(
  doc: InboundDocumentDto,
  timezone: string,
): string {
  return documentDateKey(doc, timezone).slice(0, 7);
}

/**
 * v1.29.x — bounded "still processing" window for a freshly uploaded
 * document. `hasContentIndex` stays false until the fire-and-forget
 * auto-index job (`enqueueDocumentIndex`, `src/app/api/documents/inbound/
 * route.ts`) lands — which for some documents (an unsupported format,
 * content indexing disabled entirely) never happens. Gating the vault's
 * "Processing…" chip AND the timeline's poll-while-processing refetch on
 * this window means an old, permanently-unindexed document never shows a
 * stuck spinner and the list never polls forever.
 */
export const RECENT_UPLOAD_WINDOW_MS = 3 * 60 * 1000;

/** True while `createdAt` is still inside the recent-upload processing window. */
export function isRecentlyUploaded(
  createdAt: string,
  now: number = Date.now(),
): boolean {
  const ageMs = now - new Date(createdAt).getTime();
  return ageMs >= 0 && ageMs < RECENT_UPLOAD_WINDOW_MS;
}

/**
 * True while a recently-uploaded document's content index has not landed
 * yet — the vault card's "Processing…" chip condition.
 */
export function isDocumentProcessing(
  doc: Pick<InboundDocumentDto, "createdAt" | "hasContentIndex">,
  now: number = Date.now(),
): boolean {
  return !doc.hasContentIndex && isRecentlyUploaded(doc.createdAt, now);
}

/**
 * Whether ANY document in the list is still inside its processing window —
 * drives the vault list query's poll-while-indexing `refetchInterval`.
 */
export function hasProcessingDocument(
  documents: InboundDocumentDto[],
  now: number = Date.now(),
): boolean {
  return documents.some((doc) => isDocumentProcessing(doc, now));
}

/**
 * One flat item in the virtualized timeline: a month section label or one
 * grid row of up to `columns` documents. The virtualizer windows over this
 * flat list so the mounted DOM stays bounded regardless of corpus size.
 */
export type TimelineItem =
  | { type: "month"; key: string }
  | {
      type: "row";
      key: string;
      documents: InboundDocumentDto[];
      /**
       * Flowing arrangement only: the documents in this row that open a
       * month, mapped to that month's YYYY-MM key. The month name rides
       * inline above the document instead of taking a row of its own.
       */
      monthStarts?: Record<string, string>;
    };

/**
 * Bucket an already-sorted document list into consecutive YYYY-MM sections
 * and chunk each section into rows of `columns` documents. Order is preserved
 * exactly as received — the server stays the single source of truth for
 * sorting; a month opens the first time its key appears.
 */
export function buildTimelineItems(
  documents: InboundDocumentDto[],
  columns: number,
  timezone: string,
): TimelineItem[] {
  const cols = Math.max(1, columns);
  const items: TimelineItem[] = [];
  let month: string | null = null;
  let row: InboundDocumentDto[] = [];

  const flushRow = () => {
    if (row.length > 0 && month !== null) {
      items.push({ type: "row", key: `${month}:${row[0].id}`, documents: row });
      row = [];
    }
  };

  for (const doc of documents) {
    const key = documentMonthKey(doc, timezone);
    if (key !== month) {
      flushRow();
      month = key;
      items.push({ type: "month", key });
    }
    row.push(doc);
    if (row.length === cols) flushRow();
  }
  flushRow();
  return items;
}

/**
 * The flowing arrangement: documents run left to right across every row and
 * wrap, with no row reserved for a month. The first document of each month
 * carries that month in `monthStarts`, so its name can sit inline above it.
 * Order is preserved exactly as received, like `buildTimelineItems`.
 */
export function buildFlowTimelineItems(
  documents: InboundDocumentDto[],
  columns: number,
  timezone: string,
): TimelineItem[] {
  const cols = Math.max(1, columns);
  const items: TimelineItem[] = [];
  let month: string | null = null;
  for (let i = 0; i < documents.length; i += cols) {
    const row = documents.slice(i, i + cols);
    const monthStarts: Record<string, string> = {};
    for (const doc of row) {
      const key = documentMonthKey(doc, timezone);
      if (key !== month) {
        monthStarts[doc.id] = key;
        month = key;
      }
    }
    items.push({
      type: "row",
      key: `flow:${row[0].id}`,
      documents: row,
      monthStarts,
    });
  }
  return items;
}

/**
 * Format a YYYY-MM month key as a locale month label ("März 2026"). Handed
 * over as a noon-UTC instant so the month never shifts under the display
 * timezone.
 */
export function formatMonthLabel(key: string, locale: string): string {
  if (!/^\d{4}-\d{2}$/.test(key)) return key;
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${key}-15T12:00:00.000Z`));
}

/** Locale byte formatting: 0 B / 412 KB / 1.2 MB / 2.4 GB. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 1;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: digits,
  }).format(value)} ${units[unit]}`;
}

/**
 * Shift-click range selection over the timeline's visual order. Selects
 * every id between the last plainly-toggled anchor and the target
 * (inclusive) — ADDITIVE, matching file-manager convention (a range gesture
 * never deselects). Falls back to a plain toggle when the anchor is gone
 * (filtered away, deleted) or was never set.
 */
export function expandRangeSelection(
  orderedIds: readonly string[],
  selected: ReadonlySet<string>,
  anchorId: string | null,
  targetId: string,
): Set<string> {
  const next = new Set(selected);
  const anchorIndex = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex === -1 || targetIndex === -1) {
    if (next.has(targetId)) {
      next.delete(targetId);
    } else {
      next.add(targetId);
    }
    return next;
  }
  const [from, to] =
    anchorIndex <= targetIndex
      ? [anchorIndex, targetIndex]
      : [targetIndex, anchorIndex];
  for (let i = from; i <= to; i += 1) {
    next.add(orderedIds[i]);
  }
  return next;
}

// ─── Bulk share selection ──────────────────────────────────────────────────

/**
 * Client mirror of the server's `SHARE_LINK_MAX_DOCUMENTS` — one share link
 * carries at most 50 documents. Kept as a local literal (NOT imported from the
 * clinician-share validations module, which pulls the Prisma client into scope
 * and would drag the DB into the client bundle); the server re-enforces the cap
 * on create regardless. The bulk-SELECT cap (`DOCUMENT_BULK_MAX_IDS`) is higher
 * (100), so a large selection is capped for the share path with an explicit hint.
 */
export const SHARE_LINK_MAX_DOCUMENTS = 50;

/**
 * Map a selection over the loaded corpus onto the `{ id, title }` list a share
 * link seeds from. Returns `{ overCap: true }` when the selection exceeds
 * `SHARE_LINK_MAX_DOCUMENTS` — the caller surfaces the hint and refuses rather
 * than silently dropping documents from the link. `untitledLabel` is injected
 * so the helper stays pure / i18n-free.
 */
export function resolveBulkShareDocuments(
  documents: readonly InboundDocumentDto[],
  selected: ReadonlySet<string>,
  untitledLabel: string,
):
  | { overCap: true }
  | { overCap: false; documents: { id: string; title: string }[] } {
  if (selected.size > SHARE_LINK_MAX_DOCUMENTS) return { overCap: true };
  const picked = documents
    .filter((d) => selected.has(d.id))
    .map((d) => ({
      id: d.id,
      title: d.title ?? d.filename ?? untitledLabel,
    }));
  return { overCap: false, documents: picked };
}

// ─── Upload response contract (§3.2) ───────────────────────────────────────

/**
 * The §3.2 failure reasons the upload/restore paths translate client-side,
 * plus the transport-level fallbacks. `rateLimited` maps 429; `generic`
 * covers everything unclassifiable (proxy-stripped bodies included).
 */
export type UploadFailureReason =
  | "fileTooLarge"
  | "quotaExceeded"
  | "unsupportedType"
  | "purged"
  | "duplicateExists"
  | "rateLimited"
  | "generic";

export interface UploadFailure {
  ok: false;
  reason: UploadFailureReason;
  /** §3.2 — present on `fileTooLarge`. */
  maxFileBytes?: number;
  /** §3.2 — present on `quotaExceeded`. */
  quotaBytes?: number;
  usedBytes?: number;
  /** §3.2 — present on `duplicateExists` (restore-conflict shape). */
  existingId?: string;
}

export interface UploadSuccess {
  ok: true;
  document: InboundDocumentDto;
  /**
   * §3.2 — a same-user re-upload is HTTP 200 with envelope-level
   * `meta.duplicate: true` and the EXISTING live row as `data`. Not an
   * error: the UI toasts "already stored" and highlights that row.
   */
  duplicate: boolean;
}

export type UploadResult = UploadSuccess | UploadFailure;

const REASONS: ReadonlySet<string> = new Set([
  "fileTooLarge",
  "quotaExceeded",
  "unsupportedType",
  "purged",
  "duplicateExists",
]);

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Map a `{ status, meta }` failure onto the translated-reason union. */
export function classifyUploadFailure(
  status: number,
  meta: Record<string, unknown> | undefined,
): UploadFailure {
  const reason = typeof meta?.reason === "string" ? meta.reason : "";
  if (REASONS.has(reason)) {
    return {
      ok: false,
      reason: reason as UploadFailureReason,
      maxFileBytes: numberOrUndefined(meta?.maxFileBytes),
      quotaBytes: numberOrUndefined(meta?.quotaBytes),
      usedBytes: numberOrUndefined(meta?.usedBytes),
      existingId:
        typeof meta?.existingId === "string" ? meta.existingId : undefined,
    };
  }
  // A reverse proxy can strip the JSON body (and its `meta`); fall back to
  // the HTTP status so size / type / rate-limit still classify.
  if (status === 413) return { ok: false, reason: "fileTooLarge" };
  if (status === 415) return { ok: false, reason: "unsupportedType" };
  if (status === 429) return { ok: false, reason: "rateLimited" };
  return { ok: false, reason: "generic" };
}

/**
 * Parse a completed upload's raw response (status + body text) against the
 * envelope contract. This is the ONE place the duplicate contract lives:
 * unlike every other read (which unwraps `data` and ignores `meta`), the
 * upload MUST also read the success envelope's `meta.duplicate` flag.
 */
export function parseUploadResponse(
  status: number,
  bodyText: string,
): UploadResult {
  let envelope: {
    data?: unknown;
    meta?: Record<string, unknown>;
  } | null = null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object") {
      envelope = parsed as { data?: unknown; meta?: Record<string, unknown> };
    }
  } catch {
    envelope = null;
  }

  if (status >= 200 && status < 300) {
    const doc = envelope?.data;
    if (doc && typeof doc === "object" && "id" in doc) {
      return {
        ok: true,
        document: doc as InboundDocumentDto,
        duplicate: envelope?.meta?.duplicate === true,
      };
    }
    return { ok: false, reason: "generic" };
  }
  return classifyUploadFailure(status, envelope?.meta);
}

/** What a keypress on a focused document card does. */
export type DocumentCardKeyAction = "select" | "delete" | null;

/**
 * Resolve the action for a keypress on a focused vault card.
 *
 * `Backspace` is deliberately absent. The timeline's roving tabindex hands a
 * card focus the moment someone tabs into the grid, `Backspace` is the reflex
 * "go back" key, and a card carries no other delete control — so the reflex
 * press deleted a medical document with nothing but a transient undo toast
 * between the person and the loss. `Delete` alone deletes, and the card shows
 * that key while it holds focus.
 */
export function documentCardKeyAction(key: string): DocumentCardKeyAction {
  if (key === " ") return "select";
  if (key === "Delete") return "delete";
  return null;
}

/** One procedure choice in the filter bar, labelled for the reader. */
export interface ProcedureFilterChoice {
  encounterId: string;
  /** The heading the visits page shows for it. */
  name: string;
  /** Body site and date, the line that tells two same-named ones apart. */
  detail: string;
}

/**
 * The procedure filter's choices: the usage read's linked procedures, plus the
 * actively filtered visit when it is a procedure that list does not hold (its
 * last link was just removed, or a deep link names it). A filtered visit that
 * is not a procedure adds nothing — it is not a procedure choice.
 *
 * Each is labelled the way the visits page heads the row: the reason, else the
 * practice, else the kind's name. The body site (with its side) and the date
 * ride the second line. Order is the server's, newest first, with the
 * appended active visit last.
 */
export function buildProcedureChoices(
  linked: readonly DocumentLinkedProcedureDto[],
  active: DocumentLinkedProcedureDto | null,
  labels: {
    kindName: string;
    siteText: (
      bodySite: string | null,
      laterality: DocumentLinkedProcedureDto["laterality"],
    ) => string | null;
    formatDate: (iso: string) => string;
  },
): ProcedureFilterChoice[] {
  const sources = [...linked];
  if (active && !sources.some((p) => p.encounterId === active.encounterId)) {
    sources.push(active);
  }
  return sources.map((procedure) => {
    const site = labels.siteText(procedure.bodySite, procedure.laterality);
    const date = labels.formatDate(procedure.occurredAt);
    return {
      encounterId: procedure.encounterId,
      name:
        procedure.reason?.trim() ||
        procedure.practitionerName?.trim() ||
        labels.kindName,
      detail: site ? `${site}, ${date}` : date,
    };
  });
}
