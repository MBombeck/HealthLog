import type { CoachCloseIntent } from "@/lib/insights/coach-launch-context";

/**
 * The open document lives in the URL as `?doc=<id>`, pushed as its own
 * history entry when a card opens it, so Back closes the sheet and a link
 * reopens it. These helpers own that entry: building the URL, recognising
 * the entry a card pushed, consuming it on close, and the one close (the
 * Coach handoff) that keeps it as the way back.
 */
// Strict end-of-input: `$` also accepts a trailing newline in JavaScript.
export const DOCUMENT_QUERY_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}(?![\s\S])/;
const DOCUMENT_SELECTION_HISTORY_KEY = "__healthlogPushedDocumentSelection";

export function documentSelectionHistoryState(
  documentId: string,
): Record<string, unknown> {
  // Pass only application state here. Next's patched pushState copies its
  // private router fields onto this object; copying history.state ourselves
  // would include `__NA` and make that patch treat this as an internal write,
  // skipping useSearchParams synchronization.
  return { [DOCUMENT_SELECTION_HISTORY_KEY]: documentId };
}

export function documentSelectionHref(
  pathname: string,
  currentSearch: string,
  documentId: string,
): string | null {
  if (!DOCUMENT_QUERY_ID_PATTERN.test(documentId)) return null;
  const next = new URLSearchParams(currentSearch);
  next.set("doc", documentId);
  const search = next.toString();
  return search ? `${pathname}?${search}` : pathname;
}

export function withoutDocumentSelectionHref(
  pathname: string,
  currentSearch: string,
): string {
  const next = new URLSearchParams(currentSearch);
  next.delete("doc");
  const search = next.toString();
  return search ? `${pathname}?${search}` : pathname;
}

/**
 * How long to wait before checking that `history.back()` actually happened.
 *
 * Long enough for a traversal to commit on a loaded machine, short enough that
 * a reader who closed the sheet does not see the selection linger in the
 * address bar. The window is bounded on the other side too: the effect that
 * arms this cancels it as soon as the sheet re-opens.
 */
export const CLOSE_TRAVERSAL_GRACE_MS = 250;

/**
 * The selection this close was meant to consume is still in the address bar.
 *
 * Matched on the id rather than on the presence of `doc`, so a traversal that
 * landed somewhere carrying a DIFFERENT selection is not mistaken for a
 * dropped one and stripped.
 */
export function documentSelectionSurvivedClose(
  search: string,
  documentId: string,
): boolean {
  return new URLSearchParams(search).get("doc") === documentId;
}

export function closeDocumentSelectionHistoryEntry(
  history: {
    readonly state: unknown;
    back: () => void;
    replaceState: (
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) => void;
  },
  pathname: string,
  currentSearch: string,
  documentId: string,
): void {
  const ownsCurrentEntry =
    history.state !== null &&
    typeof history.state === "object" &&
    (history.state as Record<string, unknown>)[
      DOCUMENT_SELECTION_HISTORY_KEY
    ] === documentId;
  if (ownsCurrentEntry) {
    // Card selection owns the current pushed entry. Returning to its base
    // consumes it, so the user's next Back reaches the prior distinct page.
    history.back();
    return;
  }

  // A deep link did not create a disposable entry on this page. Keep the user
  // here and remove only the selection from the current URL.
  history.replaceState(
    null,
    "",
    withoutDocumentSelectionHref(pathname, currentSearch),
  );
}

/**
 * The selection is being KEPT on purpose, as the way back.
 *
 * Maximizing the Coach drawer hands the conversation to `/coach` and carries
 * `?doc=` with it, so browser-Back can reconstruct the sheet. That is the one
 * close-shaped transition that must leave the parameter exactly where it is.
 *
 * Named, and used by both the close and the check that follows it, because
 * those two disagreeing is a bug with no symptom until it has one: the check
 * would strip the return URL a few hundred milliseconds after the close
 * deliberately preserved it, and whether it won that race was a question about
 * how fast the machine navigated.
 */
export function coachHandoffRetainsSelection(
  documentId: string,
  handedOffDocumentId: string | null,
  closeIntent: CoachCloseIntent | null | undefined,
): boolean {
  return handedOffDocumentId === documentId && closeIntent === "navigate";
}

export function closeDocumentSelectionAfterCoachHandoff(
  history: Parameters<typeof closeDocumentSelectionHistoryEntry>[0],
  pathname: string,
  currentSearch: string,
  documentId: string,
  handedOffDocumentId: string | null,
  closeIntent: CoachCloseIntent | null | undefined,
): string | null {
  if (
    coachHandoffRetainsSelection(documentId, handedOffDocumentId, closeIntent)
  ) {
    return handedOffDocumentId;
  }

  closeDocumentSelectionHistoryEntry(
    history,
    pathname,
    currentSearch,
    documentId,
  );
  return handedOffDocumentId === documentId ? null : handedOffDocumentId;
}
