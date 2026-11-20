"use client";

import { useEffect } from "react";

import { trackKeyboardInset } from "@/lib/pwa/keyboard-inset";
import { trackStandaloneViewportGap } from "@/lib/pwa/standalone-viewport-gap";

/**
 * Publishes the on-screen keyboard's height for the whole app, once (see
 * `src/lib/pwa/keyboard-inset.ts` for the measurement and `globals.css` for
 * what reads it: bottom sheets stand on the keyboard, the bottom bar and the
 * Coach button step aside), and the strip an installed iOS app can leave
 * out of its layout at the bottom (`src/lib/pwa/standalone-viewport-gap.ts`),
 * which the shell, the bottom bar and the bottom sheets extend over.
 */
export function KeyboardInsetBridge(): null {
  useEffect(() => {
    const root = document.documentElement;
    const stopKeyboard = trackKeyboardInset(window, root);
    const stopGap = trackStandaloneViewportGap(window, root);
    return () => {
      stopKeyboard();
      stopGap();
    };
  }, []);
  return null;
}
