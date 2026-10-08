/**
 * Query keys — the Dokumente vault: the filtered timeline list (keyset-
 * paginated), a single document's detail, and the usage/limits read the
 * upload path pre-flights against. Part of the centralized factory;
 * aggregated in `./index.ts`. Any document write (upload / edit / link /
 * delete / restore / bulk) invalidates the `["documents"]` prefix so the
 * timeline, an open detail sheet, and the quota bar repaint in lockstep.
 */
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

/**
 * The parameter set that distinguishes one vault timeline view from another —
 * mirrors the URL facets (`?q&kind&episode&year`) one-to-one so a deep link
 * and an in-page filter change resolve to the same cache bucket. `undefined`
 * fields are dropped by TanStack's stable hash, so an all-defaults view and
 * an explicit `{ q: undefined, … }` share a key. Sort is pinned server-side
 * (filing date, newest first) and is deliberately NOT part of the key.
 */
export interface DocumentVaultFilters {
  q?: string;
  /** Type facet — OR inside the facet, sorted before keying by the caller. */
  kinds?: InboundDocumentKindValue[];
  /** Only documents linked to this illness/condition episode. */
  episodeId?: string;
  /** Only documents linked to this visit. Arrives by deep link from it. */
  encounterId?: string;
  /** Only documents whose filing date falls in this calendar year. */
  year?: number;
}

export const documentKeys = {
  documents: () => ["documents"] as const,
  /**
   * The vault presentation (view + month arrangement). Deliberately outside
   * the `["documents"]` prefix: a document write changes nothing about how
   * the vault is laid out, so it must not refetch this.
   */
  documentsLayout: () => ["documents-layout"] as const,
  inboundDocuments: () => ["documents", "inbound"] as const,
  /**
   * The parameterised vault list (keyset-paginated via `useInfiniteQuery`).
   * The literal `"list"` segment keeps it distinct from a single-document key
   * (`inboundDocument(id)`); cuid ids never collide with it. Stays under the
   * `["documents", "inbound"]` prefix so prefix invalidation still reaches it.
   */
  inboundDocumentList: (filters: DocumentVaultFilters) =>
    ["documents", "inbound", "list", filters] as const,
  inboundDocument: (id: string) => ["documents", "inbound", id] as const,
  /**
   * The illness-episode detail's compact document preview (single page,
   * small limit). Deliberately NOT `inboundDocumentList({ episodeId })` —
   * that key belongs to the vault's `useInfiniteQuery` and a plain query
   * under the same key would poison the cache with a different shape.
   */
  inboundDocumentEpisodePreview: (episodeId: string) =>
    ["documents", "inbound", "episode-preview", episodeId] as const,
  /**
   * The link-existing-documents picker (searchable single page). Own key
   * for the same shape-collision reason as the episode preview.
   */
  inboundDocumentPicker: (q: string) =>
    ["documents", "inbound", "picker", q] as const,
  /**
   * The whole vault as a link-picker option list (every page, walked at the
   * list route's ceiling), shared by the visit and vaccination forms. Own
   * segment because the shape is a flat document array, not a page.
   */
  inboundDocumentVaultPicker: () =>
    ["documents", "inbound", "vault-picker"] as const,
  /**
   * Storage usage + effective limits (`GET /api/documents/inbound/usage`).
   * Invalidated through the `["documents"]` prefix after every upload /
   * delete so the quota bar tracks reality.
   */
  inboundDocumentUsage: () => ["documents", "inbound", "usage"] as const,
  /**
   * Document-scoped AI capability probe
   * (`GET /api/documents/inbound/capability`). Distinct from the labs
   * `ocrCapability` key because it resolves over the DOCUMENT provider order
   * (local-first) and carries the per-egress class the vault notice reads.
   */
  inboundDocumentAiCapability: () =>
    ["documents", "inbound", "ai-capability"] as const,
  /**
   * The per-user "read documents automatically with AI" opt-in
   * (`GET/PATCH /api/auth/me/documents-auto-ai-read`). Drives the AI-settings
   * toggle; a flip invalidates the document AI capability probe.
   */
  documentsAutoAiRead: () => ["documents", "auto-ai-read"] as const,
  /**
   * The document picker (#1038): its own top-level prefix, deliberately NOT
   * under `["documents"]`. Every vault write invalidates that prefix, and a
   * search or tag read here is a request to the person's Paperless-ngx or
   * Papra instance; a filing action in the vault must not re-send them.
   */
  documentSources: () => ["documentSources"] as const,
  /** Availability + the person's connections (`GET /api/documents/sources`). */
  documentSourcesStatus: () => ["documentSources", "status"] as const,
  /** One source's tags for the filter. */
  documentSourceTags: (system: string) =>
    ["documentSources", "tags", system] as const,
  /** One page of one source's search. */
  documentSourceSearch: (system: string, search: DocumentSourceSearchKey) =>
    ["documentSources", "search", system, search] as const,
};

/** The facets that make one picker search distinct from another. */
export interface DocumentSourceSearchKey {
  q: string;
  tag?: string;
  from?: string;
  to?: string;
}
