/**
 * The page's address, for URL-state tests in the browser project.
 *
 * Each test file runs in its own page, and `setup.ts` puts the address the
 * page started on back after every test, so a test may write the URL freely.
 * Only the query and hash are ever changed: the path is the test runner's
 * own, and a component that writes state keeps the path it found.
 */
import { resetUrlStateForTests } from "@/lib/url-state";

export interface HistoryRecord {
  /** Every `pushState` and `replaceState` since `recordHistory()`, in order. */
  writes: Array<{ mode: "push" | "replace"; search: string }>;
  pushes: () => string[];
  replaces: () => string[];
}

let restoreHistory: (() => void) | null = null;

/**
 * Record history writes without changing them: the real methods still run,
 * so the page's location moves exactly as it would in the app.
 */
export function recordHistory(): HistoryRecord {
  restoreHistory?.();
  const { history } = window;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  const writes: HistoryRecord["writes"] = [];
  const searchOf = (url: string | URL | null | undefined) =>
    url == null
      ? window.location.search
      : new URL(url, window.location.href).search;
  history.pushState = (data, unused, url) => {
    push(data, unused, url);
    writes.push({ mode: "push", search: searchOf(url) });
  };
  history.replaceState = (data, unused, url) => {
    replace(data, unused, url);
    writes.push({ mode: "replace", search: searchOf(url) });
  };
  restoreHistory = () => {
    history.pushState = push;
    history.replaceState = replace;
    restoreHistory = null;
  };
  return {
    writes,
    pushes: () => writes.filter((w) => w.mode === "push").map((w) => w.search),
    replaces: () =>
      writes.filter((w) => w.mode === "replace").map((w) => w.search),
  };
}

/** Start the test on `search` (`""` for a bare path). */
export function setSearch(search: string): void {
  const query = search === "" || search.startsWith("?") ? search : `?${search}`;
  window.history.replaceState(null, "", `${window.location.pathname}${query}`);
}

/**
 * Change the query the way the person would from outside the component:
 * Back, Forward or an edited address. The router hears `popstate`.
 */
export function navigateExternally(search: string): void {
  setSearch(search);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** The current query string, `?`-prefixed or empty. */
export function currentSearch(): string {
  return window.location.search;
}

let initialHref: string | null = null;

/** Called by `setup.ts` before each test. */
export function rememberAddress(): void {
  initialHref = window.location.href;
}

/** Called by `setup.ts` after each test. */
export function restoreAddress(): void {
  restoreHistory?.();
  resetUrlStateForTests();
  if (initialHref !== null && window.location.href !== initialHref) {
    window.history.replaceState(null, "", initialHref);
  }
}
