"use client";

import { createShellSlot } from "./shell-slot";

/**
 * A page-owned column on the right of the shell, beside the top bar and
 * `<main>` rather than inside `<main>`. A panel portalled here runs the full
 * height of the content row, from the top of the window (below any banner
 * strip) to the bottom, and the top bar ends at its left edge instead of
 * running underneath it. The Coach's docked conversations panel is the one
 * user. See `shell-slot.tsx`.
 */
const slot = createShellSlot("shell-side-panel");

/** Where the shell paints a page's side panel. Empty unless a page fills it. */
export const ShellSidePanelOutlet = slot.Outlet;

/** Render `children` into the shell's side-panel column. */
export const ShellSidePanel = slot.Portal;
