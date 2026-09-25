"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Open the record a link points at: `/vaccinations?dose=<id>`,
 * `/checkups?visit=<id>`.
 *
 * The link chips on a document name the record they point at, and a chip that
 * lands on a list with nothing selected leaves the person searching the list
 * for the one row they just tapped. Once the list has loaded, the row named by
 * `param` is scrolled into view and handed to `open` (the page's own edit
 * sheet, or nothing for a reader who may not edit). Each id is acted on once,
 * so closing the sheet does not reopen it on the next render.
 *
 * An id the list does not hold (deleted since, or outside what this grant
 * shows) is ignored: the page simply renders as it would without the link.
 */
export function useDeepLinkedRecord<T extends { id: string }>({
  param,
  records,
  anchorAttribute,
  open,
}: {
  /** The query parameter carrying the id. */
  param: string;
  /** The loaded list, or undefined while it loads. */
  records: readonly T[] | undefined;
  /** The data attribute each row carries its id in, for the scroll. */
  anchorAttribute: string;
  /** Called once with the linked record; omit to only scroll. */
  open?: (record: T) => void;
}): void {
  // Null outside the app router (a component rendered on its own, as the
  // unit tests do): no link, nothing to open.
  const wanted = useSearchParams()?.get(param) ?? null;
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!wanted || !records || handled.current === wanted) return;
    handled.current = wanted;
    const record = records.find((entry) => entry.id === wanted);
    if (!record) return;
    document
      .querySelector(`[${anchorAttribute}="${CSS.escape(wanted)}"]`)
      ?.scrollIntoView({ block: "center" });
    open?.(record);
  }, [wanted, records, anchorAttribute, open]);
}
