/**
 * How much of the layout viewport the on-screen keyboard covers.
 *
 * iOS Safari, and Chrome on Android by default (`interactive-widget` left at
 * `resizes-visual`), do not shrink the layout viewport when the keyboard
 * opens; only the visual viewport shrinks. Everything `position: fixed` stays
 * anchored to the layout viewport, so a bottom sheet keeps its footer (Save,
 * the Coach composer) behind the keyboard. The covered height is what is left
 * of the layout viewport below the visual one:
 *
 *   innerHeight - (visualViewport.offsetTop + visualViewport.height)
 *
 * Two things shrink the visual viewport without a keyboard, and neither may
 * read as one: pinch-zoom (the scale moves off 1) and the few dozen pixels a
 * collapsing toolbar can account for. Hence the scale check and the floor.
 *
 * Published as the `--keyboard-inset` custom property and `data-keyboard` on
 * `<html>`; the rules that use them live in `globals.css`.
 */

/** Below this, the difference is browser chrome, not a keyboard. */
export const KEYBOARD_MIN_PX = 120;

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  scale: number;
}

export function keyboardInset(
  innerHeight: number,
  viewport: VisualViewportLike | null | undefined,
): number {
  if (!viewport) return 0;
  if (Math.abs(viewport.scale - 1) > 0.01) return 0;
  const covered = innerHeight - viewport.offsetTop - viewport.height;
  return covered >= KEYBOARD_MIN_PX ? Math.round(covered) : 0;
}

export const KEYBOARD_INSET_PROPERTY = "--keyboard-inset";
/**
 * The visible height above the keyboard, published beside the inset.
 *
 * A bottom sheet stands on the keyboard (`bottom: --keyboard-inset`), so
 * its top sits at its own height above the visual viewport's bottom edge.
 * Capping that height at "layout viewport minus inset" is only right while
 * the visual viewport starts at the top of the layout one. iOS pans it down
 * (`offsetTop`) to keep a low field in view, and the sheet's header then
 * sat above the visible area: a tall sheet (the symptom form, with its
 * chips) went off screen as soon as its note field took focus. The visual
 * viewport's own height is the cap that holds in both cases.
 */
export const KEYBOARD_VIEWPORT_PROPERTY = "--keyboard-viewport-height";
export const KEYBOARD_ATTRIBUTE = "data-keyboard";

/**
 * Track the keyboard on `win` and publish it on `root`. Returns the cleanup.
 * A browser without `visualViewport` gets nothing published, which leaves
 * every rule at its keyboard-closed default.
 */
export function trackKeyboardInset(
  win: Pick<Window, "innerHeight" | "visualViewport">,
  root: HTMLElement,
): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};

  let current = "";
  const update = () => {
    const inset = keyboardInset(win.innerHeight, viewport);
    const visible = inset > 0 ? Math.round(viewport.height) : 0;
    const key = `${inset}:${visible}`;
    if (key === current) return;
    current = key;
    if (inset > 0) {
      root.style.setProperty(KEYBOARD_INSET_PROPERTY, `${inset}px`);
      root.style.setProperty(KEYBOARD_VIEWPORT_PROPERTY, `${visible}px`);
      root.setAttribute(KEYBOARD_ATTRIBUTE, "open");
    } else {
      root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
      root.style.removeProperty(KEYBOARD_VIEWPORT_PROPERTY);
      root.removeAttribute(KEYBOARD_ATTRIBUTE);
    }
  };

  update();
  viewport.addEventListener("resize", update);
  // iOS pans the visual viewport to keep the focused field in view, which
  // moves `offsetTop` without a resize.
  viewport.addEventListener("scroll", update);
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    root.style.removeProperty(KEYBOARD_INSET_PROPERTY);
    root.style.removeProperty(KEYBOARD_VIEWPORT_PROPERTY);
    root.removeAttribute(KEYBOARD_ATTRIBUTE);
  };
}
