/**
 * Shared vocabulary of the document picker (#1038): which systems it speaks,
 * the minimal shapes it hands to the client, and the errors a source can end
 * in. A zero-dependency leaf so the client components, the OpenAPI registry
 * and the routes import one list.
 */

/** The systems the picker can search and import from. */
export const DOCUMENT_PICKER_SYSTEMS = ["PAPERLESS", "PAPRA"] as const;
export type DocumentPickerSystem = (typeof DOCUMENT_PICKER_SYSTEMS)[number];

/** The lowercase path segment for each system (`/api/documents/sources/{slug}`). */
export const DOCUMENT_PICKER_SLUGS = {
  paperless: "PAPERLESS",
  papra: "PAPRA",
} as const satisfies Record<string, DocumentPickerSystem>;
export type DocumentPickerSlug = keyof typeof DOCUMENT_PICKER_SLUGS;

export function systemFromSlug(
  slug: string | undefined,
): DocumentPickerSystem | null {
  return slug && Object.hasOwn(DOCUMENT_PICKER_SLUGS, slug)
    ? DOCUMENT_PICKER_SLUGS[slug as DocumentPickerSlug]
    : null;
}

export function slugForSystem(
  system: DocumentPickerSystem,
): DocumentPickerSlug {
  return system === "PAPERLESS" ? "paperless" : "papra";
}

/** Results per search page. */
export const DOCUMENT_PICKER_PAGE_SIZE = 25;
/** Highest page a search may ask for. */
export const DOCUMENT_PICKER_MAX_PAGE = 500;
/** Longest name query. */
export const DOCUMENT_PICKER_QUERY_MAX = 200;
/** Documents the sheet imports in one run. */
export const DOCUMENT_PICKER_MAX_SELECTION = 25;
/** Tags offered in the filter (read in pages of 250). */
export const DOCUMENT_PICKER_MAX_TAGS = 1000;

/** Paperless-ngx document ids are integers. */
export const PAPERLESS_ID = /^\d{1,18}$/;
/** Papra document ids: letters, digits, `_` and `-`. */
export const PAPRA_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Papra organization ids, as Papra issues them. */
export const PAPRA_ORG_ID = /^org_[a-z0-9]{24}$/;

/**
 * Is `id` a document id `system` could have issued? Checked before an id is
 * put into a request path, so nothing a request carries can add a path
 * segment, a query or a `..` to the URL built from it.
 */
export function isSourceDocumentId(
  system: DocumentPickerSystem,
  id: string,
): boolean {
  if (id === "." || id === "..") return false;
  return (system === "PAPERLESS" ? PAPERLESS_ID : PAPRA_ID).test(id);
}

/** A connection as every route may show it: never the token. */
export interface DocumentSourceConnectionDto {
  system: DocumentPickerSystem;
  baseUrl: string;
  organizationId: string | null;
  hasToken: true;
  lastVerifiedAt: string | null;
  /** False once the operator removed the origin from the list. */
  originAllowed: boolean;
}

export interface DocumentSourcesStatusDto {
  /** The operator listed at least one origin; otherwise the picker is off. */
  available: boolean;
  /** The listed origins, so the settings card can say what is allowed. */
  allowedOrigins: string[];
  connections: DocumentSourceConnectionDto[];
}

export interface DocumentSourceTagDto {
  id: string;
  name: string;
}

/** Whether HealthLog already holds a result, by its source key. */
export type DocumentPickerResultState = "new" | "imported" | "deleted";

export interface DocumentSourceResultDto {
  sourceId: string;
  title: string;
  /** YYYY-MM-DD, the document's own date in the source, or null. */
  date: string | null;
  tags: string[];
  sizeBytes: number | null;
  state: DocumentPickerResultState;
  /**
   * The vault document when `state` is `imported`. When `state` is `deleted`,
   * the document while it is still in Recently deleted, and null once it has
   * been removed for good.
   */
  documentId: string | null;
}

export interface DocumentSourceSearchDto {
  results: DocumentSourceResultDto[];
  page: number;
  hasMore: boolean;
}

/**
 * `restored` answers only an import that asked to bring a deleted document
 * back (`revive`): the one still in Recently deleted was restored.
 */
export type DocumentImportOutcome =
  "imported" | "duplicate" | "deleted" | "restored";

export interface DocumentSourceImportDto {
  outcome: DocumentImportOutcome;
  /** The vault document; null only when a deleted one has been purged. */
  documentId: string | null;
  /** The document was linked to the record the picker was opened from. */
  linked: boolean;
}

/** Record kinds a picked document can be linked to on import. */
export const DOCUMENT_PICKER_LINK_KINDS = [
  "conditionEpisode",
  "encounter",
  "vaccination",
] as const;
export type DocumentPickerLinkKind =
  (typeof DOCUMENT_PICKER_LINK_KINDS)[number];

/**
 * Why a request to a source failed, as the `meta.errorCode` values the routes
 * emit. The route helper keys its status and wording on the last segment.
 */
export const DOCUMENT_SOURCE_ERROR_CODES = [
  "documents.sources.unavailable",
  "documents.sources.notConnected",
  "documents.sources.originNotAllowed",
  "documents.sources.unreachable",
  "documents.sources.redirected",
  "documents.sources.authRefused",
  "documents.sources.permissionMissing",
  "documents.sources.versionTooOld",
  "documents.sources.badResponse",
  "documents.sources.notFound",
  "documents.sources.linkTargetNotFound",
  "documents.sources.rateLimited",
] as const;
type SourceErrorSuffix<T> = T extends `documents.sources.${infer S}`
  ? S
  : never;
export type DocumentSourceErrorCode = SourceErrorSuffix<
  (typeof DOCUMENT_SOURCE_ERROR_CODES)[number]
>;

export function documentSourceErrorCode(
  code: DocumentSourceErrorCode,
): (typeof DOCUMENT_SOURCE_ERROR_CODES)[number] {
  return `documents.sources.${code}`;
}
