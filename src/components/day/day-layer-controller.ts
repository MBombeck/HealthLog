"use client";

import { useSyncExternalStore } from "react";

import { DAY_QUERY_PARAM, type DateKey } from "@/lib/day/contract";
import { currentUrlSearch, writeUrlState } from "@/lib/url-state";

import {
  dayHistoryState,
  historyEntryOwnedByLayer,
  parseDayParam,
} from "./day-url";
import { shiftDateKey } from "@/lib/tz/format";

/**
 * Opening, stepping and closing the day layer from anywhere in the app.
 *
 * The URL is the state. `openDay` writes `?day=` with `history.pushState`, so
 * the browser's Back closes the layer and Forward opens it again; Next keeps
 * `useSearchParams` in step with those writes, and the layer mounted in the
 * shell reads the parameter and nothing else. Stepping to the neighbouring day
 * replaces the entry instead of adding one, so five steps still need a single
 * Back to leave. Opening another day while one is open (a second chart point
 * beside the docked panel) swaps the day the same way.
 *
 * Two things do not belong in the URL and live here for the length of one
 * open: the value the person tapped to get here (the focus card at the top of
 * the day) and the element that opened the layer, which gets the focus back
 * when it closes.
 */

/**
 * What the person was looking at when they opened the day: a chart point or a
 * list row. Shown at the top of the day with the comparison the opening
 * surface already knows. Formatted by that surface, in its own words.
 */
export interface DayFocus {
  date: DateKey;
  /** The `MeasurementType` the value is, to mark its tile and its notes. */
  types?: readonly string[];
  /** What it is and where it came from, e.g. "Blood pressure · 07:12". */
  label: string;
  /** The value, formatted. */
  value: string;
  unit?: string;
  /** The comparison the opening surface knows (an earlier result). */
  compare?: { label: string; value: string };
}

interface LayerMemory {
  focus: DayFocus | null;
  trigger: HTMLElement | null;
  /** The day the layer shows, as the mounted layer resolved it. */
  open: DateKey | null;
  /** The trigger's top edge on screen when it opened the layer. */
  triggerTop: number | null;
}

const memory: LayerMemory = {
  focus: null,
  trigger: null,
  open: null,
  triggerTop: null,
};
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The focus of the open day, or null when the day was opened without one. */
export function useDayFocus(date: DateKey | null): DayFocus | null {
  const focus = useSyncExternalStore(
    subscribe,
    () => memory.focus,
    () => null,
  );
  return focus !== null && focus.date === date ? focus : null;
}

/**
 * The open day, for the surfaces that mark it (the dashed line in a chart,
 * the highlighted row in a list). Written by the mounted layer only, so a
 * surface never reads `useSearchParams` and needs no Suspense boundary.
 */
export function useOpenDay(): DateKey | null {
  return useSyncExternalStore(
    subscribe,
    () => memory.open,
    () => null,
  );
}

/** Called by the mounted layer whenever the day it shows changes. */
export function publishOpenDay(date: DateKey | null): void {
  if (memory.open === date) return;
  memory.open = date;
  emit();
  // The layer has caught up with the URL: the steps that waited for it go
  // now, in one write, from the day it shows.
  const waiting = pendingStep;
  pendingStep = null;
  if (waiting !== null && date !== null) {
    stepDay(waiting.delta, waiting.today);
  }
}

/**
 * The element that opened the layer and where it stood on screen at that
 * moment, without handing it over: the docked column keeps it there while
 * the page beside it reflows.
 */
export function peekDayTriggerAt(): { el: HTMLElement; top: number } | null {
  return memory.trigger && memory.triggerTop !== null
    ? { el: memory.trigger, top: memory.triggerTop }
    : null;
}

/** The element focus returns to when the layer closes. */
export function takeDayTrigger(): HTMLElement | null {
  const trigger = memory.trigger;
  memory.trigger = null;
  return trigger;
}

export interface OpenDayOptions {
  focus?: DayFocus | null;
  /** Defaults to the element that has focus now. */
  trigger?: HTMLElement | null;
}

/** Open `date` over the current page. */
export function openDay(date: DateKey, options: OpenDayOptions = {}): void {
  if (typeof window === "undefined") return;
  memory.focus = options.focus?.date === date ? options.focus : null;
  const active = document.activeElement;
  const focused =
    typeof HTMLElement !== "undefined" &&
    active instanceof HTMLElement &&
    active !== document.body
      ? active
      : null;
  memory.trigger = options.trigger ?? focused ?? memory.trigger;
  memory.triggerTop = memory.trigger
    ? memory.trigger.getBoundingClientRect().top
    : null;
  emit();
  writeUrlState((params) => params.set(DAY_QUERY_PARAM, date), {
    mode: historyEntryOwnedByLayer(window.history.state) ? "replace" : "push",
    state: dayHistoryState(date),
  });
}

/**
 * Steps asked for while the layer had not yet shown the previous one. Kept
 * as one sum, with the `today` of the latest request.
 */
let pendingStep: { delta: number; today: DateKey } | null = null;

/**
 * Move the open day by `delta` calendar days, without a new history entry,
 * and never past `today`. Null when nothing is written now: no day is open,
 * the step would pass today, or it waits for the previous one.
 *
 * Two things keep quick steps (a key held down, `]` pressed twice) from
 * losing one.
 *
 * The step starts from the day in the URL, not from the day a caller last
 * rendered, which reaches it through `useSearchParams`, a render and an
 * effect and can be a step behind.
 *
 * And a step does not write while the layer still shows a different day
 * than the URL. The write goes past Next's router, which adopts it a render
 * later, and since Next 16.4 that render can land after a second write and
 * put the first one's URL back: `[` then `]` pressed quickly ended a day
 * short. So a step that finds the layer behind waits, and `publishOpenDay`
 * makes it as soon as the layer shows the day the URL names.
 */
export function stepDay(delta: number, today: DateKey): DateKey | null {
  if (typeof window === "undefined") return null;
  const from = parseDayParam(
    // The live address, a queued write included (`@/lib/url-state`).
    new URLSearchParams(currentUrlSearch()).get(DAY_QUERY_PARAM),
    today,
  );
  if (from === null) {
    pendingStep = null;
    return null;
  }
  const total = (pendingStep?.delta ?? 0) + delta;
  if (memory.open !== null && memory.open !== from) {
    pendingStep = { delta: total, today };
    return null;
  }
  pendingStep = null;
  const target = shiftDateKey(from, total);
  const next = target > today ? today : target;
  if (next === from) return null;
  jumpDay(next);
  return next;
}

/**
 * Swap the open day for `next` (a day picked from the header's calendar),
 * the way a step does: no new history entry, so one Back still leaves.
 */
export function jumpDay(next: DateKey): void {
  memory.focus = null;
  emit();
  const owned = historyEntryOwnedByLayer(window.history.state);
  writeUrlState((params) => params.set(DAY_QUERY_PARAM, next), {
    // A deep link stays a deep link: marking it as pushed would make a later
    // close go Back off the page the person arrived on.
    state: owned ? dayHistoryState(next) : null,
  });
}

/**
 * Set while the docked day collapses to make room for another panel (the
 * Coach's conversations below 1600 px): focus then stays with the control
 * that asked for the room instead of moving to the day's edge.
 */
let dayToggle: (() => void) | null = null;

/**
 * The mounted layer's open-or-close, the same as a click on the day's strip
 * (a sheet with the strip's day below the docking width). The layer
 * registers it; `g p` calls it through `toggleDay`.
 */
export function registerDayToggle(toggle: () => void): () => void {
  dayToggle = toggle;
  return () => {
    if (dayToggle === toggle) dayToggle = null;
  };
}

/** Open or close the day. False when no day layer is mounted. */
export function toggleDay(): boolean {
  if (dayToggle === null) return false;
  dayToggle();
  return true;
}

let yielding = false;

/** Collapse the docked day to its edge for a neighbouring panel. */
export function yieldDay(): void {
  yielding = true;
  memory.trigger = null;
  closeDay();
}

/** Read and clear the flag `yieldDay` set. */
export function takeDayYield(): boolean {
  const was = yielding;
  yielding = false;
  return was;
}

/**
 * Close the layer. An entry the layer pushed is consumed with Back, so the
 * next Back reaches the page before; a deep link only loses its parameter.
 */
export function closeDay(): void {
  if (typeof window === "undefined") return;
  memory.focus = null;
  emit();
  if (historyEntryOwnedByLayer(window.history.state)) {
    window.history.back();
    return;
  }
  writeUrlState((params) => params.delete(DAY_QUERY_PARAM));
}
