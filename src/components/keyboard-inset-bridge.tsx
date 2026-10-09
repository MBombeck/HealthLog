"use client";

import { useEffect } from "react";

import { trackKeyboardInset } from "@/lib/pwa/keyboard-inset";

/**
 * Publishes the on-screen keyboard's height for the whole app, once (see
 * `src/lib/pwa/keyboard-inset.ts` for the measurement and `globals.css` for
 * what reads it: bottom sheets stand on the keyboard, the bottom bar and the
 * Coach button step aside).
 */
export function KeyboardInsetBridge(): null {
  useEffect(() => trackKeyboardInset(window, document.documentElement), []);
  return null;
}
