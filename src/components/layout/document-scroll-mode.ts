"use client";

import { useEffect } from "react";

/**
 * Who scrolls the page, published on `<html>` as `data-scroll` for the rules
 * in `globals.css`.
 *
 * - `"body"`: the body-scrolled shells (login / register / onboarding /
 *   standalone legal pages), where the document itself overflows. They get
 *   the document-level `scrollbar-gutter`. The authenticated branch
 *   scrolls inside its own `<main>`, which reserves its own gutter; the
 *   document gutter there too produced a second, never-painted gutter on
 *   classic-scrollbar platforms.
 * - `"shell"`: the app shell. It takes the window's edges and `<main>` is its
 *   one vertical scroller, so the document gets no scroll and no rubber band
 *   of its own. On iOS a bounce of the document held the next swipe, and the
 *   list under the finger did not move.
 * - `null`: anything else (the refusal panel, the loading states) keeps the
 *   browser's defaults.
 */
export type DocumentScrollMode = "body" | "shell" | null;

export function useDocumentScrollMode(mode: DocumentScrollMode): void {
  useEffect(() => {
    const root = document.documentElement;
    if (mode) {
      root.setAttribute("data-scroll", mode);
    } else {
      root.removeAttribute("data-scroll");
    }
    return () => {
      root.removeAttribute("data-scroll");
    };
  }, [mode]);
}
