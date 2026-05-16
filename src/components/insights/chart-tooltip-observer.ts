/**
 * v1.4.33 (F15) — chart-tooltip active observer.
 *
 * The mobile Coach FAB at `bottom-right` of every routed `/insights`
 * sub-page used to overlay the Recharts tooltip bubble when a user
 * tapped a data point near the bottom-right of the chart. We can't
 * route a `tooltipActive` boolean directly from the chart to the FAB
 * because the chart sits inside the routed page subtree while the FAB
 * is mounted at the layout level — and the chart component itself is
 * out of this work-item's touch surface.
 *
 * Instead, listen at the DOM level. Recharts paints every active
 * tooltip into a div whose class always carries `recharts-tooltip-
 * wrapper`. The `<TooltipBoundingBox>` upstream component flips the
 * inline `visibility` from `hidden` (idle) to `visible` (cursor over
 * a point or long-press on touch). A single shared `MutationObserver`
 * watches every such wrapper for `style`-attribute changes and feeds
 * a tiny external store; consumers subscribe via `useSyncExternalStore`
 * to avoid prop-drilling or react-context coupling between unrelated
 * subtrees.
 *
 * The store is module-scoped so the listener stays a singleton — the
 * observer connects on the first subscriber and disconnects on the
 * last unmount. SSR-safe: every browser API touch is gated on
 * `typeof document`.
 */

let activeCount = 0;
const listeners = new Set<() => void>();

let observer: MutationObserver | null = null;
let listening = false;

// Track wrappers we've already seen so we don't double-count their
// visibility transitions. A `WeakSet` lets the GC reclaim removed
// wrapper elements naturally.
const knownWrappers = new WeakSet<HTMLElement>();

function isVisible(wrapper: HTMLElement): boolean {
  // Recharts surfaces `visibility: visible` via inline style when the
  // tooltip should paint, and clears it otherwise. We mirror that exact
  // contract — `getComputedStyle()` is not required because the inline
  // style is always set.
  return wrapper.style.visibility === "visible";
}

function emit() {
  for (const fn of listeners) fn();
}

function syncWrapperState(wrapper: HTMLElement, nextVisible: boolean) {
  const flagged = wrapper.dataset.coachTooltipActive === "1";
  if (nextVisible && !flagged) {
    wrapper.dataset.coachTooltipActive = "1";
    activeCount += 1;
    emit();
  } else if (!nextVisible && flagged) {
    delete wrapper.dataset.coachTooltipActive;
    activeCount = Math.max(0, activeCount - 1);
    emit();
  }
}

function adoptWrapper(wrapper: HTMLElement) {
  if (knownWrappers.has(wrapper)) return;
  knownWrappers.add(wrapper);
  // Seed the active-count with whatever state the wrapper carried on
  // first sight so a tooltip already painted before our observer
  // attached still counts.
  syncWrapperState(wrapper, isVisible(wrapper));
}

function scanForWrappers(root: ParentNode) {
  // `querySelectorAll` returns every existing wrapper inside the
  // mutated subtree on every mutation — cheap because the DOM
  // typically holds 0–1 wrappers at a time.
  const wrappers = root.querySelectorAll<HTMLElement>(
    '[class*="recharts-tooltip-wrapper"]',
  );
  for (const wrapper of wrappers) adoptWrapper(wrapper);
}

function handleMutations(mutations: MutationRecord[]) {
  for (const mutation of mutations) {
    if (mutation.type === "childList") {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('[class*="recharts-tooltip-wrapper"]')) {
          adoptWrapper(node);
        } else {
          scanForWrappers(node);
        }
      }
      for (const node of mutation.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        // Removed wrappers cannot contribute to active count anymore;
        // drop the flag so a re-added wrapper re-counts cleanly.
        if (node.dataset?.coachTooltipActive === "1") {
          delete node.dataset.coachTooltipActive;
          activeCount = Math.max(0, activeCount - 1);
          emit();
        }
      }
    } else if (mutation.type === "attributes" && mutation.target instanceof HTMLElement) {
      const target = mutation.target;
      if (target.matches('[class*="recharts-tooltip-wrapper"]')) {
        syncWrapperState(target, isVisible(target));
      }
    }
  }
}

function start() {
  if (listening) return;
  if (typeof document === "undefined") return;
  listening = true;
  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["style"],
  });
  // Seed with wrappers that already exist in the DOM at subscribe-time.
  scanForWrappers(document.body);
}

function stop() {
  if (!listening) return;
  listening = false;
  observer?.disconnect();
  observer = null;
  // Reset the counter — re-seeding on the next subscriber re-scans
  // the DOM anyway.
  activeCount = 0;
}

/**
 * Subscribe-API used by `useSyncExternalStore`. Connects the singleton
 * observer on the first subscriber and disconnects on the last.
 */
export function subscribeChartTooltipActive(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/**
 * Snapshot getter for `useSyncExternalStore`. Returns `true` while at
 * least one Recharts tooltip wrapper is currently visible.
 */
export function getChartTooltipActive(): boolean {
  return activeCount > 0;
}

/**
 * SSR snapshot — no chart tooltip can be active on the server, so we
 * always return `false`. Keeps the hook safe on the initial render
 * before hydration.
 */
export function getChartTooltipActiveServer(): boolean {
  return false;
}

/**
 * Test-only reset hook. Vitest tears the DOM down between tests but
 * the module-scoped counter survives the teardown; exposing a reset
 * keeps cross-test state from bleeding.
 */
export function __resetChartTooltipObserverForTests(): void {
  activeCount = 0;
  listeners.clear();
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  listening = false;
}
