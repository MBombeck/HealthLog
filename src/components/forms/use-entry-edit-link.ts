"use client";

import { apiGet } from "@/lib/api/api-fetch";
import { useDeepLinkedRecord } from "@/hooks/use-deep-linked-record";
import {
  ENTRY_EDIT_LINK,
  type EntryEditKind,
} from "@/components/forms/entry-edit-link";

/**
 * Open the entry a save receipt's Edit links to (`?reading=`, `?entry=`,
 * `?occurrence=`) in the list's own edit sheet: scrolled to when the list
 * holds it, read on its own when it does not. `open` is omitted for a reader
 * who may not edit; the link then only scrolls.
 */
export function useEntryEditLink<T extends { id: string }>(
  kind: EntryEditKind,
  records: readonly T[] | undefined,
  open: ((entry: T) => void) | undefined,
): void {
  const link = ENTRY_EDIT_LINK[kind];
  useDeepLinkedRecord({
    param: link.param,
    records,
    anchorAttribute: link.anchor,
    open,
    resolve: (id) =>
      apiGet<T>(`${link.read}${encodeURIComponent(id)}`).catch(() => null),
  });
}
