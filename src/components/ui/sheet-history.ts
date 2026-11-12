"use client";

import { URL_STATE_EVENT } from "@/lib/url-state";

/**
 * Back closes the open sheet instead of leaving the page under it.
 *
 * Opening a sheet pushes one history entry with the page's own URL, marked
 * with the sheet's id. Back (the Android button, the edge swipe of an
 * installed app, the browser's button) then lands on the entry below, and
 * the sheet hears it as a close it may refuse: one with unsaved input asks
 * first and puts its entry back. Closing the sheet any other way takes its
 * entry off again, so one Back after a closed sheet still leaves the page.
 *
 * Four things keep that from fighting the router:
 *
 *   - Landing on the entry right below a sheet (by Back or by the sheet's
 *     own close) is never shown to Next: nothing changed for the page, and
 *     the entry below may still hold a URL the page has since replaced (a
 *     stripped `?add=`), which Next would restore and so reopen the sheet.
 *     That entry is given the page's current URL and state instead.
 *   - A history write made while the sheet's own Back is under way waits for
 *     it. A close followed by `router.push` would otherwise push the new page
 *     and have the queued Back undo it.
 *   - A navigation pushed while a sheet's entry is current (a link in the
 *     sheet) replaces that entry, so Back from the new page returns to the
 *     page, not to a sheet entry nobody shows any more.
 *   - A replace of a sheet's entry keeps the sheet's mark: the router
 *     rewrites the current entry on every update. A write that carries the
 *     mark of a sheet that has closed (the router copying an entry it read
 *     before our Back landed) loses it, or the entry would read as a sheet's
 *     and the next close would step one Back too far.
 *
 * A sheet's entry starts as a copy of the page entry's state, so landing
 * on the page entry gives it back its own keys (an open day's, the vault's).
 *
 * A sheet whose open state already lives in the URL (the vault's `?doc=`)
 * has its own entry and opts out (`ResponsiveSheet historyEntry={false}`).
 */

const SHEET_ENTRY = "__healthlogSheet";

/** How long a Back of our own may take before writes stop waiting for it. */
const SHEET_BACK_GRACE_MS = 500;

type HistoryWrite = (
  data: unknown,
  unused: string,
  url?: string | URL | null,
) => void;

export interface SheetHistoryHost {
  history: {
    readonly state: unknown;
    pushState: HistoryWrite;
    replaceState: HistoryWrite;
    back(): void;
  };
  location: { readonly href: string };
  addEventListener(
    type: "popstate",
    listener: (event: { stopImmediatePropagation(): void }) => void,
    capture: boolean,
  ): void;
  dispatchEvent(event: Event): boolean;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SheetHistoryEntry {
  /** The sheet closed some other way than Back: take its entry off. */
  release(): void;
  /** The sheet stayed open after Back (unsaved input): push its entry again. */
  restore(): void;
}

export interface SheetHistory {
  /**
   * A sheet opened. `onBack` runs when Back lands below its entry; the
   * entry is gone by then, and `restore` puts it back.
   */
  open(onBack: () => void): SheetHistoryEntry;
  /**
   * Whether the popstate being dispatched is ours: a Back we asked for, or
   * one that lands on a sheet's entry or right below the first sheet. Asked
   * by other capture listeners, which may hear it before we do.
   */
  ownsPopstate(): boolean;
}

interface Layer {
  id: string;
  onBack: () => void;
  /** The URL of the entry the sheet was opened over. */
  baseHref: string;
  /** Its own entry as last written, which the page entry takes on close. */
  snapshot: { state: unknown; href: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function markOf(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  const id = state[SHEET_ENTRY];
  return typeof id === "string" ? id : undefined;
}

function withMark(state: unknown, id: string | undefined): unknown {
  const rest = isRecord(state) ? { ...state } : {};
  delete rest[SHEET_ENTRY];
  if (id !== undefined) rest[SHEET_ENTRY] = id;
  return rest;
}

function samePage(a: string, b: string): boolean {
  const left = new URL(a);
  const right = new URL(b, a);
  return left.pathname === right.pathname && left.search === right.search;
}

/** `data` without the mark of a sheet that is no longer open. */
function withoutDeadMark(data: unknown, open: readonly Layer[]): unknown {
  const id = markOf(data);
  return id === undefined || open.some((layer) => layer.id === id)
    ? data
    : withMark(data, undefined);
}

let sequence = 0;

export function createSheetHistory(host: SheetHistoryHost): SheetHistory {
  const { history, location } = host;
  const prefix = Math.random().toString(36).slice(2, 8);
  const layers: Layer[] = [];
  /** Backs we asked for and whose popstate has not arrived yet. */
  let ownBacks = 0;
  /** What the entry we land on takes once our Backs have arrived. */
  let landing: { state: unknown; href: string } | null = null;
  /** Writes held back while our Back is under way. */
  let held: Array<() => void> = [];
  let grace: unknown = null;
  /** Set around our own writes, which pass the wrappers untouched. */
  let ours = false;
  let installed = false;
  let push: HistoryWrite = () => undefined;
  let replace: HistoryWrite = () => undefined;

  const layerOf = (id: string | undefined) =>
    id === undefined ? undefined : layers.find((layer) => layer.id === id);

  function write(kind: "push" | "replace", data: unknown, url?: string) {
    ours = true;
    try {
      // Through whatever wraps `history` (Next copies its own state in).
      if (kind === "push") history.pushState(data, "", url);
      else history.replaceState(data, "", url);
    } finally {
      ours = false;
    }
  }

  function snapshot() {
    const layer = layerOf(markOf(history.state));
    if (layer) layer.snapshot = { state: history.state, href: location.href };
  }

  function install() {
    if (installed) return;
    installed = true;
    const below = { push: history.pushState, replace: history.replaceState };
    push = (data, unused, url) => {
      if (ours) return below.push.call(history, data, unused, url);
      if (ownBacks > 0) {
        held.push(() => push.call(history, data, unused, url));
        return;
      }
      data = withoutDeadMark(data, layers);
      const current = layerOf(markOf(history.state));
      if (current && url != null && !samePage(location.href, String(url))) {
        below.replace.call(history, data, unused, url);
        return;
      }
      below.push.call(history, data, unused, url);
    };
    replace = (data, unused, url) => {
      if (ours) return below.replace.call(history, data, unused, url);
      if (ownBacks > 0) {
        held.push(() => replace.call(history, data, unused, url));
        return;
      }
      data = withoutDeadMark(data, layers);
      const id = markOf(history.state);
      const keep = layerOf(id) && markOf(data) === undefined;
      below.replace.call(
        history,
        keep ? withMark(data, id) : data,
        unused,
        url,
      );
      snapshot();
    };
    history.pushState = push;
    history.replaceState = replace;
    host.addEventListener("popstate", onPopState, true);
  }

  function armGrace() {
    if (grace !== null) host.clearTimeout(grace);
    grace = host.setTimeout(() => {
      // The Back never arrived (a traversal can be dropped while another
      // settles). Stop holding writes; where we stand is unknown, so the
      // landing is left alone.
      grace = null;
      ownBacks = 0;
      landing = null;
      flush();
    }, SHEET_BACK_GRACE_MS);
  }

  function goBack() {
    ownBacks += 1;
    history.back();
    armGrace();
  }

  function land(target: { state: unknown; href: string }) {
    write(
      "replace",
      withMark(target.state, markOf(history.state)),
      target.href,
    );
    snapshot();
  }

  function flush() {
    if (grace !== null) {
      host.clearTimeout(grace);
      grace = null;
    }
    const writes = held;
    held = [];
    for (const run of writes) run();
    // `useUrlSearch` readers were told about a write that only lands now.
    if (writes.length > 0) host.dispatchEvent(new Event(URL_STATE_EVENT));
  }

  function onPopState(event: { stopImmediatePropagation(): void }) {
    if (ownBacks > 0) {
      ownBacks -= 1;
      event.stopImmediatePropagation();
      if (ownBacks > 0) return;
      const id = markOf(history.state);
      if (id !== undefined && !layerOf(id)) {
        // The entry of a sheet that closed while another stood over it.
        goBack();
        return;
      }
      if (landing) land(landing);
      landing = null;
      flush();
      return;
    }

    const id = markOf(history.state);
    const kept = layerOf(id);
    const closing = layers.splice(kept ? layers.indexOf(kept) + 1 : 0);
    if (closing.length === 0) return;
    const top = closing[closing.length - 1];
    if (location.href === closing[0].baseHref) {
      // One step below the sheet, on the page it was opened over.
      event.stopImmediatePropagation();
      if (top.snapshot) land(top.snapshot);
    }
    for (const layer of closing.reverse()) layer.onBack();
  }

  function pushEntry(layer: Layer) {
    if (ownBacks > 0) {
      held.push(() => pushEntry(layer));
      return;
    }
    if (!layers.includes(layer)) return;
    layer.baseHref = location.href;
    write("push", withMark(history.state, layer.id));
    snapshot();
  }

  return {
    ownsPopstate: () =>
      ownBacks > 0 ||
      layerOf(markOf(history.state)) !== undefined ||
      (layers.length > 0 && location.href === layers[0].baseHref),
    open(onBack) {
      install();
      sequence += 1;
      const layer: Layer = {
        id: `${prefix}-${sequence}`,
        onBack,
        baseHref: location.href,
        snapshot: null,
      };
      layers.push(layer);
      pushEntry(layer);
      return {
        release() {
          const index = layers.indexOf(layer);
          if (index === -1) return;
          layers.splice(index, 1);
          // Below another sheet's entry, or taken by a navigation: a later
          // Back of ours steps over it, or there is nothing to take off.
          if (markOf(history.state) !== layer.id) return;
          if (ownBacks === 0) {
            landing = layer.snapshot ?? {
              state: history.state,
              href: location.href,
            };
          }
          goBack();
        },
        restore() {
          if (layers.includes(layer)) return;
          layers.push(layer);
          pushEntry(layer);
        },
      };
    },
  };
}

let shared: SheetHistory | null = null;

/** The one instance for the page, or null outside a browser. */
export function sheetHistory(): SheetHistory | null {
  if (typeof window === "undefined") return null;
  shared ??= createSheetHistory(window as unknown as SheetHistoryHost);
  return shared;
}

/** Whether the popstate under way belongs to an open or closing sheet. */
export function sheetHistoryOwnsPopstate(): boolean {
  return shared?.ownsPopstate() ?? false;
}
