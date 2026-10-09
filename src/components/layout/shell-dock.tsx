"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import { SHELL_HEADER_BAND } from "./shell-metrics";
import { createShellSlot } from "./shell-slot";

/**
 * The docked panels' strips (v1.42): from 1280 px every docked panel (the
 * day on every page, the Coach's conversations on `/coach`) keeps its own
 * narrow vertical strip at the right edge of the window, visible whether the
 * panel is open or not. The strips stand side by side in one column of the
 * shell, right of the panels (`ShellSidePanel`), in the same order as their
 * panels: conversations (`order-1`), then the day (`order-2`). A panel opens
 * to the left of the strips; the strips never move or change shape.
 *
 * Each strip starts below the top bar's band. The band above them is empty
 * and draws the top bar's bottom line on through, so nothing in the strips
 * meets the command palette at the end of the top bar.
 */
const strips = createShellSlot("shell-strips");

/** Where the shell paints the strips. Empty unless a docked panel fills it. */
export const ShellStripOutlet = strips.Outlet;

/** Render a strip into the shell's strip column. */
export const ShellStrip = strips.Portal;

/**
 * The slide every docked panel shares: the panel's box animates its width
 * between the open column and nothing, and its content keeps the open width,
 * pinned to the box's left edge, so it slides out under the strip instead of
 * squeezing. The Coach's conversations introduced it; the day takes the same
 * duration and easing. No motion under reduced motion.
 */
export const DOCK_SLIDE =
  "relative h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear motion-reduce:transition-none";

/** The slide's length in milliseconds, for content that waits it out. */
export const DOCK_SLIDE_MS = 200;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * `value` while it is set, and for the length of the slide after it is
 * cleared: a closing panel keeps painting what it showed while its width
 * runs to nothing. Cleared at once under reduced motion, where nothing
 * slides.
 */
export function useLingering<T>(value: T | null): T | null {
  const [held, setHeld] = useState<T | null>(value);
  if (value !== null && held !== value) setHeld(value);
  useEffect(() => {
    if (value !== null || held === null) return;
    const id = window.setTimeout(
      () => setHeld(null),
      prefersReducedMotion() ? 0 : DOCK_SLIDE_MS,
    );
    return () => window.clearTimeout(id);
  }, [value, held]);
  return value ?? held;
}

export interface DockStripProps {
  ref?: React.Ref<HTMLButtonElement>;
  /** `data-slot` of the strip; its button is `<slot>-toggle`. */
  slot: string;
  /** Left to right: conversations 1, day 2. */
  order: 1 | 2;
  /** The id of the panel the strip opens and closes. */
  controls: string;
  expanded: boolean;
  /** The strip's visible, vertical label. */
  label: string;
  /** The button's accessible name (what a click does). */
  actionLabel: string;
  icon: LucideIcon;
  onToggle: () => void;
  /** Called when the pointer or focus reaches the strip (load ahead). */
  onPreload?: () => void;
  /** Extra attributes for the strip (`data-day`). */
  data?: Record<`data-${string}`, string>;
}

/**
 * One strip: an empty cell of the top bar's band, then a button the rest of
 * the window's height that opens and closes its panel. The label reads
 * top to bottom; the strip is marked while its panel is open.
 */
export function DockStrip({
  ref,
  slot,
  order,
  controls,
  expanded,
  label,
  actionLabel,
  icon: Icon,
  onToggle,
  onPreload,
  data,
}: DockStripProps) {
  return (
    <div
      data-slot={slot}
      data-state={expanded ? "open" : "closed"}
      {...data}
      className={cn(
        "bg-sidebar text-sidebar-foreground flex h-full w-10 shrink-0 flex-col",
        order === 1 ? "order-1" : "order-2",
      )}
    >
      <div
        aria-hidden="true"
        className={cn(SHELL_HEADER_BAND, "border-sidebar-border shrink-0")}
      />
      <button
        ref={ref}
        type="button"
        data-slot={`${slot}-toggle`}
        aria-expanded={expanded}
        aria-controls={controls}
        aria-label={actionLabel}
        title={actionLabel}
        onClick={onToggle}
        onPointerEnter={onPreload}
        onFocus={onPreload}
        className={cn(
          "border-sidebar-border flex min-h-0 flex-1 cursor-pointer flex-col items-center gap-2 border-l py-3 text-xs font-medium transition-colors outline-none",
          "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:ring-inset",
          expanded
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="truncate [writing-mode:vertical-rl]">{label}</span>
      </button>
    </div>
  );
}
