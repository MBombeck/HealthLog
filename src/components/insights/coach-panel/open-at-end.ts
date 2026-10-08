/**
 * Open a saved conversation at its end, and keep it there while the answers
 * finish laying out.
 *
 * A conversation opened from the history used to land at the top on a wide
 * screen and short of the last answer on a phone. Two things worked against
 * the thread's ordinary auto-scroll. It scrolled smoothly, and the scroll
 * events of that animation passed through positions that were not at the
 * bottom, so the thread concluded the reader had scrolled away and stopped
 * following. And the answers' charts and tables load after the messages, so
 * the end moved down after the scroll had already finished: about 70 px on a
 * phone, one chart's height.
 *
 * So the opening jump is instant, and for a short while afterwards every
 * growth of the thread's content moves the view to the new end. The settling
 * stops early the moment the reader does anything that means "let me look
 * around" (a wheel, a touch, a key, a pointer press inside the thread), and
 * on its own after {@link OPEN_AT_END_SETTLE_MS}.
 */

/** How long late layout (charts, tables, images) may still move the end. */
export const OPEN_AT_END_SETTLE_MS = 4000;

/** Events that mean the reader has taken over the scroll position. */
const READER_EVENTS = [
  "wheel",
  "touchstart",
  "keydown",
  "pointerdown",
] as const;

/** The part of an element the settling needs; a real `HTMLElement` fits. */
export interface OpenAtEndScroller {
  readonly scrollHeight: number;
  readonly children: ArrayLike<Element>;
  scrollTo(options: ScrollToOptions): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The observers to use; the browser's by default, fakes in a test. */
interface Observers {
  ResizeObserver?: typeof ResizeObserver;
  MutationObserver?: typeof MutationObserver;
}

/**
 * Jump to the end now and follow the end while the content settles. Returns
 * the function that stops following; call it on unmount or when another
 * conversation opens.
 */
export function openAtEnd(
  el: OpenAtEndScroller,
  observers: Observers = {
    ResizeObserver: globalThis.ResizeObserver,
    MutationObserver: globalThis.MutationObserver,
  },
): () => void {
  // `instant`, not `auto`: the thread carries `scroll-smooth`, and under it
  // `auto` animates, which is exactly the motion that lost the end before.
  const toEnd = () =>
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  toEnd();

  let stopped = false;
  const resize = observers.ResizeObserver
    ? new observers.ResizeObserver(() => {
        if (!stopped) toEnd();
      })
    : null;
  const watch = (node: Element) => resize?.observe(node);
  for (const child of Array.from(el.children)) watch(child);

  // A bubble that mounts after the opening (a lazily loaded answer part)
  // is watched from then on, and its own arrival moves the end too.
  const mutations = observers.MutationObserver
    ? new observers.MutationObserver((records) => {
        if (stopped) return;
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            // An element (nodeType 1), not a text node: only elements resize.
            if (node.nodeType === 1) watch(node as Element);
          }
        }
        toEnd();
      })
    : null;
  mutations?.observe(el as unknown as Node, { childList: true });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    resize?.disconnect();
    mutations?.disconnect();
    clearTimeout(timer);
    for (const type of READER_EVENTS) el.removeEventListener(type, stop);
  };
  for (const type of READER_EVENTS) el.addEventListener(type, stop);
  const timer = setTimeout(stop, OPEN_AT_END_SETTLE_MS);

  return stop;
}
