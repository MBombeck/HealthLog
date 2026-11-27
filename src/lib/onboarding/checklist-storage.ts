/**
 * The getting-started checklist's per-browser state.
 *
 * Three keys, all of them conveniences rather than record: which rows this
 * browser hid, whether the whole card was hidden, and whether it is open.
 * They were private to the card until the setup flow needed two of them —
 * the done screen and "skip for now" open the list, and Settings brings a
 * hidden list back — and a second copy of a storage key is how two surfaces
 * end up writing different ones.
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

/**
 * "Show the checklist again": forget every dismissal and open the list.
 * Returns whether anything was stored to forget, so the caller can say
 * "it is back" rather than "done" to somebody who never hid it.
 */
export function resetChecklistDismissals(): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const hadState =
      store.getItem(CHECKLIST_DISMISSED_ALL_KEY) === "1" ||
      (store.getItem(CHECKLIST_DISMISSED_ITEMS_KEY) ?? "[]") !== "[]";
    store.removeItem(CHECKLIST_DISMISSED_ITEMS_KEY);
    store.removeItem(CHECKLIST_DISMISSED_ALL_KEY);
    store.setItem(CHECKLIST_EXPANDED_KEY, "1");
    return hadState;
  } catch {
    return false;
  }
}
