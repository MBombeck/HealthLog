"use client";

import { useCallback, useRef } from "react";

/**
 * v1.7.0 — Roving-tabindex helper for hand-rolled ARIA radiogroups.
 *
 * Several controls render `role="radiogroup"` with `<button role="radio">`
 * children (the unit-preference segmented control, the health-record export
 * format buttons, the mood-level picker, the side-effect entry/severity
 * chips). An ARIA radiogroup is expected to behave like a native one: the
 * group is a single tab stop, the checked option carries `tabindex=0` and the
 * rest `tabindex=-1`, and Arrow keys move both focus and selection between
 * options (Home/End jump to the first/last enabled option). This hook centres
 * that behaviour so every control shares one tested implementation instead of
 * copy-pasting a keydown handler per surface.
 *
 * Mouse / touch behaviour is untouched — callers keep their own `onClick`.
 * The hook only adds the keyboard layer and the per-item `tabIndex` / `ref`
 * wiring.
 */

export interface RovingRadioOptions {
  /** Total number of options in the group. */
  readonly count: number;
  /**
   * Index of the currently selected option, or `-1` when nothing is selected
   * yet. The selected option (or the first enabled option when none is
   * selected) is the group's single tab stop.
   */
  readonly selectedIndex: number;
  /** Invoked with the option index when Arrow / Home / End picks a new one. */
  readonly onSelect: (index: number) => void;
  /**
   * Optional per-index disabled predicate. Disabled options are skipped by
   * Arrow / Home / End navigation and never become the tab stop.
   */
  readonly isDisabled?: (index: number) => boolean;
}

export interface RovingRadioItemProps {
  ref: (el: HTMLElement | null) => void;
  tabIndex: number;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/**
 * Pure navigation math: given the current index and a key, return the next
 * option index to select, or `null` when the key is not a navigation key (or
 * no enabled option exists). Exported for direct unit testing — the React
 * harness here is SSR-only, so the keyboard logic is verified at this level
 * rather than through a simulated DOM event.
 *
 * ARIA radiogroup convention: ArrowRight/ArrowDown advance, ArrowLeft/ArrowUp
 * retreat, both wrapping. Home/End jump to the first/last enabled option.
 */
export function rovingRadioNextIndex(
  key: string,
  current: number,
  count: number,
  isDisabled?: (index: number) => boolean,
): number | null {
  if (count <= 0) return null;

  const enabled = (i: number) => !(isDisabled?.(i) ?? false);

  // Resolve the cursor we step from: the current option when it's a real,
  // enabled index, otherwise the first enabled option so the very first
  // Arrow press lands somewhere sensible.
  const firstEnabled = firstEnabledIndex(count, enabled);
  if (firstEnabled === null) return null;
  const cursor =
    current >= 0 && current < count && enabled(current) ? current : firstEnabled;

  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return stepEnabled(cursor, count, +1, enabled);
    case "ArrowLeft":
    case "ArrowUp":
      return stepEnabled(cursor, count, -1, enabled);
    case "Home":
      return firstEnabled;
    case "End":
      return lastEnabledIndex(count, enabled);
    default:
      return null;
  }
}

function firstEnabledIndex(
  count: number,
  enabled: (i: number) => boolean,
): number | null {
  for (let i = 0; i < count; i++) if (enabled(i)) return i;
  return null;
}

function lastEnabledIndex(
  count: number,
  enabled: (i: number) => boolean,
): number | null {
  for (let i = count - 1; i >= 0; i--) if (enabled(i)) return i;
  return null;
}

/** Step in `dir` from `from`, wrapping, skipping disabled options. */
function stepEnabled(
  from: number,
  count: number,
  dir: 1 | -1,
  enabled: (i: number) => boolean,
): number {
  let next = from;
  for (let n = 0; n < count; n++) {
    next = (next + dir + count) % count;
    if (enabled(next)) return next;
  }
  return from;
}

export function useRovingRadioGroup({
  count,
  selectedIndex,
  onSelect,
  isDisabled,
}: RovingRadioOptions): {
  getRadioProps: (index: number) => RovingRadioItemProps;
} {
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  const enabled = useCallback(
    (i: number) => !(isDisabled?.(i) ?? false),
    [isDisabled],
  );

  // The tab stop is the selected option; when nothing is selected (or the
  // selection is disabled) it falls to the first enabled option so the group
  // is always reachable by Tab.
  const tabStopIndex =
    selectedIndex >= 0 && selectedIndex < count && enabled(selectedIndex)
      ? selectedIndex
      : (firstEnabledIndex(count, enabled) ?? -1);

  const getRadioProps = useCallback(
    (index: number): RovingRadioItemProps => ({
      ref: (el: HTMLElement | null) => {
        itemRefs.current[index] = el;
      },
      tabIndex: index === tabStopIndex ? 0 : -1,
      onKeyDown: (event: React.KeyboardEvent) => {
        const next = rovingRadioNextIndex(
          event.key,
          selectedIndex,
          count,
          isDisabled,
        );
        if (next === null) return;
        event.preventDefault();
        onSelect(next);
        // Move focus to the newly selected option so the roving tab stop and
        // keyboard focus stay in lock-step.
        itemRefs.current[next]?.focus();
      },
    }),
    [count, selectedIndex, onSelect, isDisabled, tabStopIndex],
  );

  return { getRadioProps };
}
