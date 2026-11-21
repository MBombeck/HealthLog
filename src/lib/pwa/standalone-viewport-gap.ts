/**
 * The strip an installed iOS app leaves out of its own layout at the bottom.
 *
 * The installed app draws under the status bar (`viewport-fit=cover` with the
 * `black-translucent` status bar, `layout.tsx`), so its layout viewport should
 * run from the top of the screen to the bottom. iOS 26 can hand a home-screen
 * app a layout viewport that is short by the status bar's height instead: it
 * still starts at the top of the screen, but `innerHeight` is the screen minus
 * the top inset. Everything sized or anchored to that viewport ends that far
 * above the screen's bottom edge. The shell (`absolute inset-0`), the bottom
 * bar and every bottom sheet (`bottom: 0`) stopped short, with the page's
 * colour in the strip under them, exactly where Safari's toolbar would sit in
 * a browser tab.
 *
 * That shape is narrow enough to recognise without guessing:
 *
 *   - a home-screen app on iOS (`navigator.standalone`, which no other
 *     platform defines; an Android install legitimately keeps its status and
 *     navigation bars out of the viewport, and must not be pulled under them),
 *   - a window as wide as the screen in its current orientation (an iPad
 *     window in Split View or Stage Manager is smaller than the screen on
 *     purpose),
 *   - short by the top safe-area inset, to the pixel or two: the signature of
 *     this defect, and nothing a correct layout ever produces.
 *
 * The measured strip is published as `--viewport-bottom-gap` on `<html>`, and
 * the shell, the bottom bar, the bottom sheets and the overlays extend over it
 * (`globals.css`). Where the viewport is right, the gap is zero and nothing
 * moves; Safari in a tab is never standalone.
 */

/** No status bar is taller than this; a larger difference is something else. */
export const VIEWPORT_GAP_MAX_PX = 100;
/** How far the gap may differ from the top inset and still be that defect. */
export const VIEWPORT_GAP_TOLERANCE_PX = 2;

export interface ViewportGapInput {
  /** `navigator.standalone`: true only in an iOS home-screen app. */
  standalone: boolean;
  innerWidth: number;
  innerHeight: number;
  /** `screen.width` / `screen.height`, which iOS reports in portrait. */
  screenWidth: number;
  screenHeight: number;
  /** The resolved `env(safe-area-inset-top)` in px. */
  safeAreaTop: number;
}

export function standaloneViewportGap(input: ViewportGapInput): number {
  if (!input.standalone) return 0;
  if (input.safeAreaTop <= 0) return 0;
  const long = Math.max(input.screenWidth, input.screenHeight);
  const short = Math.min(input.screenWidth, input.screenHeight);
  const landscape = input.innerWidth > input.innerHeight;
  const screenWide = landscape ? long : short;
  const screenTall = landscape ? short : long;
  if (Math.abs(input.innerWidth - screenWide) > 1) return 0;
  const gap = screenTall - input.innerHeight;
  if (gap <= 0 || gap > VIEWPORT_GAP_MAX_PX) return 0;
  if (Math.abs(gap - input.safeAreaTop) > VIEWPORT_GAP_TOLERANCE_PX) return 0;
  return Math.round(gap);
}

export const VIEWPORT_GAP_PROPERTY = "--viewport-bottom-gap";

/**
 * How many changes of the gap, without a rotation, within
 * `VIEWPORT_GAP_FLAP_WINDOW_MS` count as a loop. A real correction by iOS
 * (the keyboard case below) flips once, and a flip back later is rare.
 */
export const VIEWPORT_GAP_FLAP_LIMIT = 3;
export const VIEWPORT_GAP_FLAP_WINDOW_MS = 5_000;

/**
 * The top inset, resolved. `env()` cannot be read from script, so a hidden
 * probe takes it as padding through `--safe-area-top` (globals.css), which a
 * test can also set where no desktop browser reports an inset.
 */
function readSafeAreaTop(doc: Document): number {
  const probe = doc.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-top:var(--safe-area-top, env(safe-area-inset-top, 0px))";
  doc.body.appendChild(probe);
  const value = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return value;
}

type GapWindow = Pick<
  Window,
  | "innerWidth"
  | "innerHeight"
  | "screen"
  | "navigator"
  | "addEventListener"
  | "removeEventListener"
  | "visualViewport"
>;

/**
 * Measure the gap on `win` and publish it on `root`, again on every resize and
 * rotation (iOS has been seen to correct the viewport after the keyboard has
 * been up once, and the gap must then go back to zero). Returns the cleanup.
 */
export function trackStandaloneViewportGap(
  win: GapWindow,
  root: HTMLElement,
  safeAreaTop: () => number = () => readSafeAreaTop(root.ownerDocument),
  now: () => number = () => Date.now(),
): () => void {
  const standalone =
    (win.navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!standalone) return () => {};

  let current = -1;
  // The inset is read at start, on rotation and on a window resize, never on a
  // `visualViewport` resize: reading it forces a style recalculation, and
  // `visualViewport` fires `resize` on every frame of the keyboard animation
  // and of a pinch, where that would stutter. iOS keeps the layout viewport
  // still while the keyboard moves, so the window's own `resize` stays rare.
  let inset = safeAreaTop();
  // Set once the published gap keeps changing by itself. Extending the
  // layout over the strip can make iOS hand back the full viewport, which
  // reads as "no gap" and pulls the layout back, which shortens the viewport
  // again: on iOS 27 that loop moved the bottom bar on every frame. A loop
  // like that ends with the gap off, which is the layout from before this
  // correction existed, until the device is rotated.
  let settledOff = false;
  const flips: number[] = [];
  const update = () => {
    if (settledOff) return;
    const gap = standaloneViewportGap({
      standalone,
      innerWidth: win.innerWidth,
      innerHeight: win.innerHeight,
      screenWidth: win.screen.width,
      screenHeight: win.screen.height,
      safeAreaTop: inset,
    });
    if (gap === current) return;
    if (current !== -1) {
      const at = now();
      flips.push(at);
      while (flips.length > 0 && at - flips[0] > VIEWPORT_GAP_FLAP_WINDOW_MS) {
        flips.shift();
      }
      if (flips.length >= VIEWPORT_GAP_FLAP_LIMIT) {
        settledOff = true;
        current = 0;
        root.style.removeProperty(VIEWPORT_GAP_PROPERTY);
        return;
      }
    }
    current = gap;
    if (gap > 0) root.style.setProperty(VIEWPORT_GAP_PROPERTY, `${gap}px`);
    else root.style.removeProperty(VIEWPORT_GAP_PROPERTY);
  };

  const remeasure = () => {
    inset = safeAreaTop();
    update();
  };

  const rotate = () => {
    settledOff = false;
    flips.length = 0;
    remeasure();
  };

  update();
  win.addEventListener("resize", remeasure);
  win.addEventListener("orientationchange", rotate);
  win.visualViewport?.addEventListener("resize", update);
  return () => {
    win.removeEventListener("resize", remeasure);
    win.removeEventListener("orientationchange", rotate);
    win.visualViewport?.removeEventListener("resize", update);
    root.style.removeProperty(VIEWPORT_GAP_PROPERTY);
  };
}
