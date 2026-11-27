/**
 * The getting-started checklist's per-browser state: whether it is open.
 *
 * Which rows are hidden, and whether the whole card is, lives on the account
 * (`getting-started.<row>` and `getting-started` in `dismissible-hints.ts`).
 * The two keys they were kept under in this browser before are named here
 * only so `legacy-dismissals.ts` can carry them over once.
 *
 * Every access is wrapped: storage can be full, disabled, or absent, and the
 * card renders correctly with no stored value.
 */
export const CHECKLIST_DISMISSED_ITEMS_KEY =
  "healthlog-getting-started-dismissed";
export const CHECKLIST_DISMISSED_ALL_KEY = "healthlog-getting-started-hidden";
export const CHECKLIST_EXPANDED_KEY = "healthlog-getting-started-expanded";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Open the checklist on the next dashboard visit. */
export function markChecklistExpanded(): void {
  try {
    storage()?.setItem(CHECKLIST_EXPANDED_KEY, "1");
  } catch {
    /* storage may be full or disabled */
  }
}
