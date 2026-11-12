type ClickLike = Pick<
  MouseEvent,
  | "defaultPrevented"
  | "button"
  | "metaKey"
  | "ctrlKey"
  | "shiftKey"
  | "altKey"
  | "target"
>;

/**
 * Whether a click would leave the open page for another one of this app while
 * the browser is offline.
 *
 * Signed-in pages are never cached (the proxy sends them `no-store`), so that
 * navigation can only end on the service worker's offline page and throws
 * away a page that was still readable. Clicks the browser handles on its own
 * (new tab, download, another origin) and links within the same page are left
 * alone.
 */
export function isOfflineNavigationClick(
  event: ClickLike,
  here: Pick<Location, "origin" | "pathname" | "search">,
  online: boolean,
): boolean {
  if (online || event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const anchor = (event.target as Partial<Element> | null)?.closest?.(
    "a[href]",
  ) as HTMLAnchorElement | null | undefined;
  // An SVG `<a>` carries an animated string, not a URL.
  if (!anchor || typeof anchor.href !== "string") return false;
  if (anchor.target && anchor.target !== "_self") return false;
  if (anchor.hasAttribute("download")) return false;
  let url: URL;
  try {
    url = new URL(anchor.href, here.origin);
  } catch {
    return false;
  }
  if (url.origin !== here.origin) return false;
  return url.pathname !== here.pathname || url.search !== here.search;
}
