"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

/**
 * A page-owned slot in the shell's chrome.
 *
 * The shell knows nothing about pages; a page that needs to paint into the
 * chrome (the Coach's panel toggle in the top bar, its docked conversations
 * panel beside the content column) renders the slot's `Portal` anywhere in
 * its own tree and the content is portalled into the slot's `Outlet`.
 * Portalling keeps the content inside the page's React tree, so it reads
 * the page's state and context directly and no node has to be handed across
 * a context on every render.
 *
 * The slot empties itself when the page unmounts: the portal goes with the
 * component that rendered it, so no other route ever shows stale content.
 *
 * The outlet's element is held in a module-level store rather than a context
 * provider. The shell mounts each outlet exactly once, so a store keeps the
 * shell's tree untouched. On the server, and before the outlet has mounted,
 * there is no target and the portal renders nothing.
 */
export function createShellSlot(slot: string) {
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

  function Outlet({ className }: { className?: string }) {
    return <div ref={setOutlet} data-slot={slot} className={className} />;
  }

  function Portal({ children }: { children: React.ReactNode }) {
    const target = useSyncExternalStore(
      subscribe,
      () => outlet,
      () => null,
    );
    if (!target) return null;
    return createPortal(children, target);
  }

  return { Outlet, Portal };
}
