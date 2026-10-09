"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the command palette is open, reachable from anywhere: the top-bar
 * button, Cmd/Ctrl+K in the shortcut handler, and the palette itself. The
 * palette's code is a separate chunk (`command-palette.lazy.tsx`); this file
 * is the few lines every page carries.
 */
let open = false;
const listeners = new Set<() => void>();

export function setCommandPaletteOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function openCommandPalette(): void {
  setCommandPaletteOpen(true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false,
  );
}

/** Start loading the palette's chunk ahead of the click (hover, focus). */
export function preloadCommandPalette(): void {
  void import("./command-palette").catch(() => {
    // The click loads it again and reports a failure there.
  });
}
