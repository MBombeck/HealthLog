"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The Coach page's conversations panel: whether it sits docked beside the
 * thread, and whether the person last left it open there.
 *
 * Docked means a viewport of at least 1280 px (`xl`). Below that the panel is
 * a sheet over the page and opens only when asked, so nothing here applies.
 * At `xl` it is open on a first visit and remembers the last choice per
 * device after that.
 *
 * The choice is a convenience, not a record: it lives in `localStorage`, every
 * read and write is wrapped because storage can throw (private windows,
 * blocked site data), and an unreadable store falls back to the first-visit
 * default. Both values come through `useSyncExternalStore`, so the server and
 * the hydrating client agree (docked = false, open = true) and the live value
 * lands on the first client render after hydration.
 */
export const COACH_PANEL_STORAGE_KEY = "healthlog.coach.panelOpen";

/** The breakpoint at which the panel docks beside the thread. */
export const COACH_PANEL_DOCKED_QUERY = "(min-width: 1280px)";

/** Same-tab change signal; the `storage` event only fires in other tabs. */
const CHANGE_EVENT = "healthlog:coach-panel-open";

/**
 * The last choice made in this tab. Read when the store has nothing, so a
 * click still sticks for the session where storage refuses every write.
 */
let sessionChoice: boolean | null = null;

/**
 * The remembered choice. `null` = nothing stored yet (a first visit), or a
 * store that cannot be read; the caller treats both as "open".
 */
export function readCoachPanelPreference(
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(COACH_PANEL_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

/** Persist the choice. Returns false when the store refused the write. */
export function writeCoachPanelPreference(
  storage: Pick<Storage, "setItem"> | null | undefined,
  open: boolean,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(COACH_PANEL_STORAGE_KEY, String(open));
    return true;
  } catch {
    return false;
  }
}

/** The open state the docked panel paints: a first visit opens it. */
export function resolveCoachPanelOpen(stored: boolean | null): boolean {
  return stored ?? true;
}

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function subscribePreference(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === COACH_PANEL_STORAGE_KEY) {
      callback();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

function subscribeDocked(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(COACH_PANEL_DOCKED_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function readDocked(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(COACH_PANEL_DOCKED_QUERY).matches;
}

/**
 * `docked`: the viewport is wide enough for the panel to sit beside the
 * thread. `open`: the remembered docked state (meaningful only when docked).
 * `setOpen` persists and notifies every subscriber in this tab.
 */
export function useCoachPanelOpen(): {
  docked: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const docked = useSyncExternalStore(subscribeDocked, readDocked, () => false);
  const open = useSyncExternalStore(
    subscribePreference,
    () =>
      resolveCoachPanelOpen(
        readCoachPanelPreference(safeLocalStorage()) ?? sessionChoice,
      ),
    () => true,
  );
  const setOpen = useCallback((next: boolean) => {
    sessionChoice = next;
    writeCoachPanelPreference(safeLocalStorage(), next);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(CHANGE_EVENT));
    }
  }, []);
  return { docked, open, setOpen };
}
