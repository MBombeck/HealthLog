"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A place above a page's view switch where the active view puts its header.
 *
 * A page that switches views with `Tabs` (Checkups: checkups, visits,
 * procedures, body sites) has one header per view, because each view owns
 * its title, its sentence and its actions. Rendered inside the panel, that
 * header stood under the tab strip, so the strip was the first thing on the
 * page and the H1 came second. Rendering the strip inside each panel instead
 * would unmount it on every switch and drop the keyboard focus that was on
 * it. The page leaves an element above the strip and provides it here; a
 * view's header portals into it and stays in the view's own React tree, so
 * its state and handlers are untouched.
 *
 * Without a provider the header renders where it stands. Under a provider
 * whose element has not mounted yet (the first commit) it renders nothing,
 * so it never paints under the strip for a frame and then jumps.
 */
const HeaderSlotContext = createContext<HTMLElement | null | undefined>(
  undefined,
);

export const HeaderSlotProvider = HeaderSlotContext.Provider;

export function InHeaderSlot({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  if (slot === undefined) return children;
  return slot ? createPortal(children, slot) : null;
}
