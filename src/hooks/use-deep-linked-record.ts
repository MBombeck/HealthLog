"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Open the record a link points at: `/vaccinations?dose=<id>`,
 * `/care?visit=<id>`.
 *
 * The link chips on a document name the record they point at, and a chip that
 * lands on a list with nothing selected leaves the person searching the list
 * for the one row they just tapped. Once the list has loaded, the row named by
 * `param` is scrolled into view and handed to `open` (the page's own edit
 * sheet, or nothing for a reader who may not edit). Each id is acted on once,
 * so closing the sheet does not reopen it on the next render.
 *
 * An id the list does not hold (deleted since, outside what this grant shows,
 * or older than the bounded list reads) is handed to `resolve` when the page
 * gives one, and the record it returns is opened; without `resolve`, or when
 * it finds nothing, the page simply renders as it would without the link.
 */
export function useDeepLinkedRecord<T extends { id: string }>({
  param,
  records,
  anchorAttribute,
  open,
  resolve,
}: {
  /** The query parameter carrying the id. */
  param: string;
  /** The loaded list, or undefined while it loads. */
  records: readonly T[] | undefined;
  /** The data attribute each row carries its id in, for the scroll. */
  anchorAttribute: string;
  /** Called once with the linked record; omit to only scroll. */
  open?: (record: T) => void;
  /**
   * Read one record the list does not hold, by its id, or null. Only asked
   * when `open` is given: a record that is not on the page cannot be
   * scrolled to.
   */
  resolve?: (id: string) => Promise<T | null>;
}): void {
  // Null outside the app router (a component rendered on its own, as the
  // unit tests do): no link, nothing to open.
  const wanted = useSearchParams()?.get(param) ?? null;
  const handled = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!wanted || !records || handled.current === wanted) return;
    handled.current = wanted;
    void openDeepLinked({
      wanted,
      records,
      open,
      resolve,
      // Still on the page, and still the link it was asked for.
      stillWanted: () => mounted.current && handled.current === wanted,
      scrollTo: (id) =>
        document
          .querySelector(`[${anchorAttribute}="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: "center" }),
    });
  }, [wanted, records, anchorAttribute, open, resolve]);
}

/**
 * What a link does once the list has loaded, apart from React: a record the
 * list holds is scrolled to and opened; one it does not hold (older than the
 * bounded read, say the newest hundred visits) is read on its own through
 * `resolve` and opened when it comes back and the link is still wanted.
 * Resolves to which of the three happened.
 */
export async function openDeepLinked<T extends { id: string }>(args: {
  wanted: string;
  records: readonly T[];
  open?: (record: T) => void;
  resolve?: (id: string) => Promise<T | null>;
  stillWanted: () => boolean;
  scrollTo: (id: string) => void;
}): Promise<"listed" | "resolved" | "none"> {
  const { wanted, records, open, resolve } = args;
  const record = records.find((entry) => entry.id === wanted);
  if (record) {
    args.scrollTo(wanted);
    open?.(record);
    return "listed";
  }
  if (!resolve || !open) return "none";
  let found: T | null;
  try {
    found = await resolve(wanted);
  } catch {
    // Gone or refused: the page stays as it would without the link.
    return "none";
  }
  if (!found || !args.stillWanted()) return "none";
  open(found);
  return "resolved";
}
