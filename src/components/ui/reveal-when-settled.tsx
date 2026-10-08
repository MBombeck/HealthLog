"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";

/**
 * Holds a page body out of layout until its first reads have settled, then
 * shows it in one step.
 *
 * Some bodies stack several cards whose final height depends on data — a
 * day-by-day timeline, a paginated list, a card that turns out empty. Each
 * resolving on its own pushed everything beneath it down the page a few
 * times in the first few hundred milliseconds (CLS well above 0.1 at
 * desktop width). A skeleton cannot know a list's real length; this does
 * not need to.
 *
 * The children mount immediately, so their queries start at once; they sit
 * in a `hidden` container (out of layout, so nothing in it can shift) while
 * the `fallback` holds the place. The body reveals when no query is in
 * flight for two frames running, or after `maxWaitMs` at the latest, so a
 * slow or polling read elsewhere in the app can delay it but never strand
 * it. Revealing is latched: a later background refetch does not hide the
 * body again.
 */
export function RevealWhenSettled({
  children,
  fallback,
  maxWaitMs = 2000,
  className = "space-y-6",
}: {
  children: ReactNode;
  /** The body's own rhythm: the wrapper is the one child of the page's
   *  stack, so the gap between the cards it holds is set here. */
  className?: string;
  /** The placeholder painted until the body reveals. */
  fallback: ReactNode;
  maxWaitMs?: number;
}) {
  const queryClient = useQueryClient();
  const fetching = useIsFetching();
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (revealed || fetching > 0) return;
    // Two frames: the children's query observers subscribe in their own
    // effects, so a count of zero on the first pass can simply mean nothing
    // has started yet.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (queryClient.isFetching() === 0) setRevealed(true);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [fetching, revealed, queryClient]);

  useEffect(() => {
    if (revealed) return;
    const timer = setTimeout(() => setRevealed(true), maxWaitMs);
    return () => clearTimeout(timer);
  }, [revealed, maxWaitMs]);

  return (
    <>
      {revealed ? null : fallback}
      <div
        data-slot="reveal-when-settled"
        data-revealed={revealed ? "true" : "false"}
        aria-busy={revealed ? undefined : true}
        className={revealed ? className : "hidden"}
      >
        {children}
      </div>
    </>
  );
}
