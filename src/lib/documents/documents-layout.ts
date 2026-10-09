/**
 * Document vault presentation — persisted in `User.documentsLayoutJson`.
 *
 * Two independent choices, both display-only:
 *
 * - `view`: `cards` is the monthly grid of preview tiles; `list` is one
 *   compact row per document.
 * - `arrangement`: `stacked` gives every month its own block, one under the
 *   other; `flow` lets the documents run left to right across the full width
 *   and wrap, with each month's name riding inline as a small marker that does
 *   not break the run.
 *
 * Null / missing column = the defaults below (cards, flowing months). The GET
 * endpoint never lazy-writes, and the PUT stores only the fields the user has
 * actually chosen, so a default that changes later reaches every account that
 * never picked that field, while a saved choice stays. Mirrors
 * `medication-list-layout.ts`: tolerant resolver on read, normaliser on write,
 * preserve-when-absent PUT (see the route).
 */

export const DOCUMENTS_LAYOUT_VIEWS = ["cards", "list"] as const;
export type DocumentsLayoutView = (typeof DOCUMENTS_LAYOUT_VIEWS)[number];

export const DOCUMENTS_LAYOUT_ARRANGEMENTS = ["stacked", "flow"] as const;
export type DocumentsLayoutArrangement =
  (typeof DOCUMENTS_LAYOUT_ARRANGEMENTS)[number];

export interface DocumentsLayout {
  version: 1;
  view: DocumentsLayoutView;
  arrangement: DocumentsLayoutArrangement;
}

export const DEFAULT_DOCUMENTS_LAYOUT: DocumentsLayout = {
  version: 1,
  view: "cards",
  arrangement: "flow",
};

function isView(value: unknown): value is DocumentsLayoutView {
  return (
    typeof value === "string" &&
    (DOCUMENTS_LAYOUT_VIEWS as readonly string[]).includes(value)
  );
}

function isArrangement(value: unknown): value is DocumentsLayoutArrangement {
  return (
    typeof value === "string" &&
    (DOCUMENTS_LAYOUT_ARRANGEMENTS as readonly string[]).includes(value)
  );
}

/**
 * Any malformed, partial or legacy blob collapses onto the defaults field by
 * field, so a GET never fails on a stored row and a field added later
 * defaults cleanly for blobs written before it existed.
 */
export function resolveDocumentsLayout(raw: unknown): DocumentsLayout {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ...DEFAULT_DOCUMENTS_LAYOUT };
  }
  const blob = raw as { view?: unknown; arrangement?: unknown };
  return {
    version: 1,
    view: isView(blob.view) ? blob.view : DEFAULT_DOCUMENTS_LAYOUT.view,
    arrangement: isArrangement(blob.arrangement)
      ? blob.arrangement
      : DEFAULT_DOCUMENTS_LAYOUT.arrangement,
  };
}

/**
 * The fields a stored blob explicitly carries, each validated. Unknown or
 * malformed values drop out, so the default fills them on read. The PUT
 * merges into this rather than into the resolved layout, which keeps an
 * untouched field following the default instead of freezing today's value.
 */
export function storedDocumentsLayoutChoices(
  raw: unknown,
): Partial<Pick<DocumentsLayout, "view" | "arrangement">> {
  if (raw === null || raw === undefined || typeof raw !== "object") return {};
  const blob = raw as { view?: unknown; arrangement?: unknown };
  return {
    ...(isView(blob.view) ? { view: blob.view } : {}),
    ...(isArrangement(blob.arrangement)
      ? { arrangement: blob.arrangement }
      : {}),
  };
}
