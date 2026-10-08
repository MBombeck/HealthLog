/**
 * v1.17.1 — TanStack Query keys for the structured lab-result store.
 *
 * `labResultsList` bakes the filter + pagination shape into the key so a
 * filter change refetches without a same-key cache collision (the project's
 * queryKey-factory invariant).
 */
export const labKeys = {
  labResults: () => ["lab-results"] as const,

  labResultsList: (params: {
    biomarkerId?: string | undefined;
    analyte: string | undefined;
    panel: string | undefined;
    from: string | undefined;
    to: string | undefined;
    page: number;
    sortDir: string;
  }) =>
    [
      "lab-results",
      "list",
      params.biomarkerId ?? null,
      params.analyte ?? null,
      params.panel ?? null,
      params.from ?? null,
      params.to ?? null,
      params.page,
      params.sortDir,
    ] as const,

  // `/labs?analyte=<name>` (MCP deep links): the newest reading stored under
  // that exact analyte name, one row, to find its marker's page. Its own key
  // because the page size differs from every list read; the `lab-results`
  // prefix lets a result mutation evict it too.
  labAnalyteLink: (analyte: string) =>
    ["lab-results", "analyte-link", analyte] as const,

  // The visit form's lab picker: newest results, its own page size. Its own
  // key because the Labs list reads a different page size, and a shared key
  // would serve one read's page to the other.
  labResultsPicker: (limit: number) =>
    ["lab-results", "picker", limit] as const,

  // v1.25 — paginated (offset) reading feed for the biomarker detail page.
  // Distinct from `labResultsList` (single-page key) so the infinite-query
  // accumulation never collides with a single-page read. Shares the
  // `["lab-results", …]` prefix so a result mutation's `labResults()`
  // invalidation evicts it too.
  labResultsInfinite: (params: { biomarkerId: string; sortDir: string }) =>
    [
      "lab-results",
      "list",
      "infinite",
      params.biomarkerId,
      params.sortDir,
    ] as const,

  // v1.18.1 — user-scoped Biomarker catalog. The list feeds the picker and
  // the manager; both invalidate `biomarkers()` after a mutation.
  biomarkers: () => ["biomarkers"] as const,
  biomarkerDetail: (id: string) => ["biomarkers", "detail", id] as const,

  // v1.18.9 — Lab-OCR capability probe (drives whether the "Scan a report"
  // affordance shows). Cheap GET; the dialog refetches it on open.
  ocrCapability: () => ["lab-ocr", "capability"] as const,

  // v1.18.10 — local (in-browser) OCR opt-in flag for text-only providers.
  labsLocalOcr: () => ["labs", "local-ocr"] as const,
};
