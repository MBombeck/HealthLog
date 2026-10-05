"use client";

import { createShellSlot } from "./shell-slot";

/**
 * A page-owned slot at the trailing edge of the top bar: the Coach's
 * conversations-panel toggle renders `<TopBarActions>` anywhere in its own
 * tree and lands in `<TopBarActionsOutlet>`. See `shell-slot.tsx`.
 */
const slot = createShellSlot("top-bar-actions");

/** Where the top bar paints page actions. Empty unless a page fills it. */
export const TopBarActionsOutlet = slot.Outlet;

/** Render `children` into the top bar's action slot. */
export const TopBarActions = slot.Portal;

/**
 * A page-owned slot at the leading edge of the top bar on desktop: where
 * the page says where the reader is (the Coach's "Coach › conversation").
 * Phones keep the logo there.
 */
const context = createShellSlot("top-bar-context");

/** Where the top bar paints the page's context. Empty unless a page fills it. */
export const TopBarContextOutlet = context.Outlet;

/** Render `children` into the top bar's context slot. */
export const TopBarContext = context.Portal;
