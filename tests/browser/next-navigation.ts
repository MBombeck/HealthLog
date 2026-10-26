/**
 * `next/navigation` for the browser project, aliased in `vitest.config.mts`.
 *
 * The App Router's hooks throw unless a router is mounted, and mounting one
 * means booting Next. What a component needs from them is smaller: the
 * current path and query, and a way to change them. This module answers both
 * from the page's real `location` and `history`, so `@/lib/url-state` writes
 * through the same `pushState` / `replaceState` it uses in the app.
 *
 * `useSearchParams` follows the address bar the way the router does: it
 * re-reads on `popstate` and on the URL-state event, one task after the write
 * rather than synchronously, which is the "adopted a render later" gap the
 * helper's queue exists for. A test that only asserts what the page shows
 * never sees the gap; one that writes twice in a row exercises it.
 *
 * `redirect` and `notFound` throw like Next's do, so a component that calls
 * one fails its test loudly instead of rendering past it.
 */
import { useMemo, useSyncExternalStore } from "react";

import { URL_STATE_EVENT } from "@/lib/url-state";

function subscribe(onChange: () => void): () => void {
  // The router adopts a write after the event loop turns, not inside the
  // dispatch that announced it.
  const deferred = () => setTimeout(onChange, 0);
  window.addEventListener("popstate", deferred);
  window.addEventListener(URL_STATE_EVENT, deferred);
  return () => {
    window.removeEventListener("popstate", deferred);
    window.removeEventListener(URL_STATE_EVENT, deferred);
  };
}

const readSearch = () => window.location.search;
const readPathname = () => window.location.pathname;

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, readSearch, readSearch);
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, readPathname, readPathname);
}

function navigate(mode: "push" | "replace", href: string): void {
  const url = new URL(href, window.location.href);
  if (mode === "push") window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const router = {
  push: (href: string) => navigate("push", href),
  replace: (href: string) => navigate("replace", href),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => {},
  prefetch: () => {},
};

export function useRouter(): typeof router {
  return router;
}

export function useParams(): Record<string, string> {
  return {};
}

export function useSelectedLayoutSegment(): string | null {
  return null;
}

export function useSelectedLayoutSegments(): string[] {
  return [];
}

export function redirect(href: string): never {
  throw new Error(`redirect(${href}) called in a browser test`);
}

export function permanentRedirect(href: string): never {
  throw new Error(`permanentRedirect(${href}) called in a browser test`);
}

export function notFound(): never {
  throw new Error("notFound() called in a browser test");
}
