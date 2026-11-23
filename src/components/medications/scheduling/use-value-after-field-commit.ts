"use client";

import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";

/**
 * Read a form's value after a field still being typed in has committed.
 *
 * A time typed into a field reaches the form's state when the field blurs.
 * The returned function blurs a focused input synchronously and then returns
 * the value as of that commit, so a save reads the time. The save button must
 * keep focus off itself on press (`onMouseDown={(e) => e.preventDefault()}`):
 * a blur at press time would grow the form with the new chip and its window
 * row before the release, and the click would land off the button.
 */
export function useValueAfterFieldCommit<T>(value: T): () => T {
  // The value as of the last commit, read after the flush below.
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.tagName === "INPUT") {
      flushSync(() => active.blur());
    }
    return ref.current;
  };
}
