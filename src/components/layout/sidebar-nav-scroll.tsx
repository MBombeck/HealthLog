"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The rail's destination list as a scroll region: the one part of the rail
 * that gives up height, between the pinned logo band above and the pinned
 * footer group and account row below (`sidebar-nav.tsx`).
 */

/**
 * The nav list's scroll region. `scroll-py-6` keeps a focused row clear of
 * the edge fades; under a finger `scroll-py-12` keeps it clear of the scroll
 * cue as well, which is 44 px tall. `overscroll-contain` is the own-scroll
 * list rule (ui-standards §2), taken under a finger, where the swipe that
 * reaches an end is the problem. A mouse or trackpad has nothing to chain
 * to (the app shell's document neither scrolls nor bounces), and on Chromium
 * the property moves the list into a layer of its own, which re-rasterised
 * every label in the rail by a shade.
 */
export const RAIL_NAV_SCROLL =
  "min-h-0 flex-1 scroll-py-6 pointer-coarse:scroll-py-12 overflow-y-auto pointer-coarse:overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * The scroll cue at an edge of the nav list that has more destinations
 * beyond it, under a finger only.
 *
 * A touch tablet keeps the 44 px rows, so in landscape (an iPad is 670 to
 * 830 px tall in Safari) three to seven destinations sit below the fold, and
 * the list has no scrollbar: iOS paints none on an element at rest. The fade
 * alone did not read as "swipe here", and the rail looked as if it simply
 * ended. The cue says so and is a way there in itself: a tap scrolls the
 * list most of a screen on.
 *
 * It is a pointer shortcut and nothing else. The keyboard reaches every row
 * by Tab (focus scrolls the row into view) and a screen reader reads the
 * list whole, so the cue stays out of the focus order and the accessibility
 * tree. A mouse scrolls with the wheel and never sees it.
 */
export function RailScrollCue({
  direction,
  navRef,
}: {
  direction: "up" | "down";
  navRef: React.RefObject<HTMLElement | null>;
}) {
  const Icon = direction === "down" ? ChevronDown : ChevronUp;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      data-slot="sidebar-nav-scroll-cue"
      data-direction={direction}
      onClick={() => {
        const nav = navRef.current;
        if (!nav) return;
        const reduce = window.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        nav.scrollBy({
          top: (direction === "down" ? 1 : -1) * nav.clientHeight * 0.75,
          behavior: reduce ? "auto" : "smooth",
        });
      }}
      className={cn(
        "absolute inset-x-0 z-10 hidden h-11 justify-center outline-none pointer-coarse:flex",
        direction === "down"
          ? "bottom-0 items-end pb-1"
          : "top-0 items-start pt-1",
      )}
    >
      <span className="bg-sidebar border-sidebar-border text-foreground flex size-7 items-center justify-center rounded-full border shadow-sm">
        <Icon className="size-4" />
      </span>
    </button>
  );
}

/** Height of the fade at a scroll edge that has more content beyond it. */
const RAIL_FADE = "1.5rem";

/**
 * The fade mask for the list's scroll edges: a top fade while there is
 * content above, a bottom fade while there is content below. A mask paints
 * alpha only, so it reads the same in light and dark and never moves layout.
 */
function railFadeMask(
  top: boolean,
  bottom: boolean,
): React.CSSProperties | undefined {
  if (!top && !bottom) return undefined;
  const image = `linear-gradient(to bottom, ${top ? "transparent" : "#000"} 0, #000 ${top ? RAIL_FADE : "0px"}, #000 calc(100% - ${bottom ? RAIL_FADE : "0px"}), ${bottom ? "transparent" : "#000"} 100%)`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * Whether the nav list is taller than the room the rail leaves it, i.e.
 * whether it scrolls, and which of its edges have more content beyond them.
 * Re-measured when the nav (viewport height) or the list (entries arriving
 * as modules resolve) changes size, and on scroll.
 */
export function useNavOverflows(navRef: React.RefObject<HTMLElement | null>): {
  overflows: boolean;
  moreAbove: boolean;
  moreBelow: boolean;
} {
  const [edges, setEdges] = useState({
    overflows: false,
    moreAbove: false,
    moreBelow: false,
  });
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    // Strict: any overflow, the same test that makes the list scroll.
    const update = () => {
      const overflows = nav.scrollHeight > nav.clientHeight;
      const moreAbove = overflows && nav.scrollTop > 0.5;
      const moreBelow =
        overflows && nav.scrollTop + nav.clientHeight < nav.scrollHeight - 0.5;
      setEdges((prev) =>
        prev.overflows === overflows &&
        prev.moreAbove === moreAbove &&
        prev.moreBelow === moreBelow
          ? prev
          : { overflows, moreAbove, moreBelow },
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    if (nav.firstElementChild) observer.observe(nav.firstElementChild);
    nav.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      nav.removeEventListener("scroll", update);
    };
  }, [navRef]);
  return edges;
}

/**
 * The list's region: the `<nav>` that scrolls, with its edge fades, and the
 * touch cues over its edges.
 *
 * The list scrolls without a native scrollbar (a classic scrollbar with
 * arrow buttons read as a foreign body in the rail); fades at the edges say
 * there is more, and focus keeps the focused row clear of them.
 * `overscroll-contain` (under a finger) keeps a swipe that reaches either end
 * inside the rail: on iOS it chained to the document, which rubber-banded and
 * held the next swipe, so the list seemed not to scroll.
 */
export function RailNavList({
  navRef,
  edges,
  label,
  className,
  children,
}: {
  navRef: React.RefObject<HTMLElement | null>;
  edges: { moreAbove: boolean; moreBelow: boolean };
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-slot="sidebar-nav-region"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <nav
        ref={navRef}
        aria-label={label}
        className={cn(RAIL_NAV_SCROLL, className)}
        style={railFadeMask(edges.moreAbove, edges.moreBelow)}
        data-fade-top={edges.moreAbove ? "true" : undefined}
        data-fade-bottom={edges.moreBelow ? "true" : undefined}
        onFocus={(event) => {
          event.target.scrollIntoView?.({ block: "nearest" });
        }}
      >
        {children}
      </nav>
      {edges.moreAbove && <RailScrollCue direction="up" navRef={navRef} />}
      {edges.moreBelow && <RailScrollCue direction="down" navRef={navRef} />}
    </div>
  );
}
