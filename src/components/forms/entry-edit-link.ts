/**
 * The page and query parameter that open one saved entry's edit sheet: the
 * Edit on a quick-entry form's save receipt. Each list reads its parameter
 * through `useDeepLinkedRecord`, so the link scrolls to the row when the list
 * holds it and reads the entry on its own when it does not.
 */
export const ENTRY_EDIT_LINK = {
  measurement: {
    path: "/measurements",
    param: "reading",
    anchor: "data-measurement-id",
    read: "/api/measurements/",
  },
  mood: {
    path: "/mood",
    param: "entry",
    anchor: "data-mood-entry-id",
    read: "/api/mood-entries/",
  },
  symptom: {
    path: "/illness",
    param: "occurrence",
    anchor: "data-symptom-event-id",
    read: "/api/symptoms/events/",
  },
} as const;

export type EntryEditKind = keyof typeof ENTRY_EDIT_LINK;

/** `/measurements?reading=<id>` and its siblings. */
export function entryEditHref(kind: EntryEditKind, id: string): string {
  const { path, param } = ENTRY_EDIT_LINK[kind];
  return `${path}?${param}=${encodeURIComponent(id)}`;
}
