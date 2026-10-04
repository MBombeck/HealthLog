"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * How far ahead of the visible area a deferred section mounts. Roughly half a
 * phone screen: far enough that a section is usually painted before it
 * scrolls in, close enough that a visit that never scrolls never asks for it.
 */
export const DEFER_UNTIL_NEAR_MARGIN = "400px 0px";

/** The nearest ancestor that scrolls vertically, or `null` for the viewport. */
function scrollRoot(el: HTMLElement): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Mount `children` only once their slot comes near the visible area.
 *
 * Until then a 1 px sentinel holds the slot, so a section that owns its own
 * reads does not send them on page entry. Observed against the nearest
 * scroll container (the app shell scrolls inside `<main>`, not the window),
 * since a root margin only widens the root and an observer on the viewport
 * would not see a section until it was already on screen.
 *
 * Once mounted the children stay mounted, and the sentinel leaves no wrapper
 * behind: the rendered tree is the same as an eager mount. Without
 * `IntersectionObserver` the children mount on the next task.
 */
export function DeferUntilNear({
  id,
  children,
}: {
  /** Names the slot for tests: `data-deferred-section`. */
  id: string;
  children: ReactNode;
}) {
  const [near, setNear] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (near) return;
    const el = sentinelRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // No observer to wait on: mount on the next task instead of never.
      const timer = setTimeout(() => setNear(true));
      return () => clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: scrollRoot(el), rootMargin: DEFER_UNTIL_NEAR_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  if (near) return <>{children}</>;
  return (
    <div
      ref={sentinelRef}
      data-deferred-section={id}
      aria-hidden="true"
      className="h-px"
    />
  );
}
