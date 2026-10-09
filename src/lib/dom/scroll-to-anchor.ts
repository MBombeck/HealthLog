/**
 * Scroll to the element with `id` once it exists, for a link that lands on a
 * card of a page that is still loading (a Settings section is its own lazy
 * chunk, and some cards wait for their reads).
 *
 * The shell resets the page's scroll on every route change, in an effect
 * that can run after the card has already appeared; the scroll therefore
 * waits two frames, and looks once more a moment later and scrolls again if
 * the card is no longer near the top. It gives up after `timeoutMs` and
 * returns a cancel function.
 *
 * With `pathname`, an element only counts once the URL is on that page, so a
 * same-named element on the page being left is never the one scrolled to.
 */
export function scrollToAnchorWhenReady(
  id: string,
  options: { pathname?: string; timeoutMs?: number } = {},
): () => void {
  const { pathname, timeoutMs = 5000 } = options;
  if (typeof document === "undefined" || id === "") return () => {};
  let done = false;
  const timers: number[] = [];
  let observer: MutationObserver | null = null;

  const finish = () => {
    done = true;
    observer?.disconnect();
    for (const timer of timers) window.clearTimeout(timer);
  };

  const scroll = (el: HTMLElement) => {
    el.scrollIntoView({ block: "start" });
  };

  const land = (el: HTMLElement) => {
    observer?.disconnect();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (done) return;
        scroll(el);
        timers.push(
          window.setTimeout(() => {
            const target = document.getElementById(id);
            if (!done && target) {
              const top = target.getBoundingClientRect().top;
              if (top < 0 || top > window.innerHeight * 0.4) scroll(target);
            }
            finish();
          }, 300),
        );
      }),
    );
  };

  const look = () => {
    if (pathname !== undefined && window.location.pathname !== pathname) {
      return false;
    }
    const el = document.getElementById(id);
    if (el && el.getClientRects().length > 0) {
      land(el);
      return true;
    }
    return false;
  };

  if (!look()) {
    observer = new MutationObserver(() => {
      if (!done && look()) observer?.disconnect();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "style"],
    });
    timers.push(window.setTimeout(finish, timeoutMs));
  }
  return finish;
}
