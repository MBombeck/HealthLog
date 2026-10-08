"use client";

import { useSyncExternalStore } from "react";

import type { DateKey } from "@/lib/day/contract";

import {
  dayHistoryState,
  historyEntryOwnedByLayer,
  shiftDateKey,
  withDayHref,
} from "./day-url";

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

function currentLocation() {
  return { pathname: window.location.pathname, search: window.location.search };
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
  const { pathname, search } = currentLocation();
  const href = withDayHref(pathname, search, date);
  if (historyEntryOwnedByLayer(window.history.state)) {
    window.history.replaceState(dayHistoryState(date), "", href);
  } else {
    window.history.pushState(dayHistoryState(date), "", href);
  }
}

/** Move the open day by `delta` calendar days, without a new history entry. */
export function stepDay(from: DateKey, delta: number): DateKey {
  const next = shiftDateKey(from, delta);
  memory.focus = null;
  emit();
  const { pathname, search } = currentLocation();
  const owned = historyEntryOwnedByLayer(window.history.state);
  window.history.replaceState(
    // A deep link stays a deep link: marking it as pushed would make a later
    // close go Back off the page the person arrived on.
    owned ? dayHistoryState(next) : null,
    "",
    withDayHref(pathname, search, next),
  );
  return next;
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
  const { pathname, search } = currentLocation();
  window.history.replaceState(null, "", withDayHref(pathname, search, null));
}
