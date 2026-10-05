"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/**
 * A page-owned slot at the trailing edge of the top bar.
 *
 * The top bar is shell chrome and knows nothing about pages; a page that
 * needs a control up there (the Coach's conversations-panel toggle) renders
 * `<TopBarActions>` anywhere in its own tree and the content is portalled
 * into `<TopBarActionsOutlet>`. Portalling keeps the control inside the
 * page's React tree, so it reads the page's state and context directly and
 * no node has to be handed across a context on every render.
 *
 * The slot empties itself when the page unmounts: the portal goes with the
 * component that rendered it, so no other route ever shows a stale control.
 *
 * The outlet's element is held in a module-level store rather than a context
 * provider. The shell mounts exactly one top bar, so there is one outlet, and
 * a store keeps the shell's tree untouched.
 */
let outlet: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setOutlet(node: HTMLElement | null) {
  if (outlet === node) return;
  outlet = node;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Where the top bar paints page actions. Empty unless a page fills it. */
export function TopBarActionsOutlet({ className }: { className?: string }) {
  return (
    <div ref={setOutlet} data-slot="top-bar-actions" className={className} />
  );
}

/** Render `children` into the top bar's action slot. */
export function TopBarActions({ children }: { children: React.ReactNode }) {
  const target = useSyncExternalStore(
    subscribe,
    () => outlet,
    () => null,
  );
  if (!target) return null;
  return createPortal(children, target);
}
