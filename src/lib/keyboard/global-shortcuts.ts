/**
 * The app-wide keyboard shortcuts, as pure logic.
 *
 * The listener in `src/components/layout/global-shortcuts.tsx` hands every
 * keydown to `createShortcutReader().read()` together with the scope the page
 * is in, and gets back an action, a "wait for the second key", or nothing.
 * Everything that decides whether a key is ours lives here, so it can be
 * pinned without a DOM:
 *
 *   - a key typed into a field is the field's (`isEditableTarget`);
 *   - a key held with Cmd, Ctrl or Alt belongs to the browser, the operating
 *     system or a screen reader (`blockedByModifier`), with one exception: a
 *     punctuation key the layout itself needs Alt or AltGr to type (`[` is
 *     Option+5 on a German Mac, AltGr+8 on a German PC) still counts, because
 *     for that person there is no other way to press it;
 *   - while a dialog, sheet, menu or popover is open the keys are its own,
 *     except over the day sheet, where `[` and `]` step the day it shows.
 *
 * `g` starts a two-key sequence; the second key has to follow within
 * `SEQUENCE_TIMEOUT_MS`. Escape is never handled here: every surface closes
 * itself on it, as before.
 */

/** How long `g` waits for its second key. */
export const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * `g` + key: where it goes. The destination is a nav href, or `settings`,
 * which lands wherever the Settings entry of the account menu lands (it
 * differs inside a shared record). Listed in navigation order, which is the
 * order the help dialog shows them in.
 */
export const GO_TO_SHORTCUTS = [
  { key: "d", destination: "/" },
  { key: "m", destination: "/medications" },
  { key: "l", destination: "/labs" },
  { key: "t", destination: "/timeline" },
  { key: "i", destination: "/insights" },
  { key: "c", destination: "/coach" },
  { key: "s", destination: "settings" },
] as const;

export type GoToKey = (typeof GO_TO_SHORTCUTS)[number]["key"];

export type ShortcutAction =
  | { type: "go"; key: GoToKey }
  | { type: "capture" }
  | { type: "help" }
  | { type: "day"; delta: -1 | 1 };

/**
 * Where the keyboard is:
 *  - `page`: nothing modal is open, every shortcut applies;
 *  - `day-sheet`: the day sheet is the only modal surface, `[` / `]` apply;
 *  - `off`: another dialog, sheet, menu or popover has the keys.
 */
export type ShortcutScope = "page" | "day-sheet" | "off";

/** What the reader needs from a `KeyboardEvent`. */
export interface ShortcutKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** `event.getModifierState("AltGraph")`. */
  altGraph?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: unknown;
}

/** Keys a layout may need Alt or AltGr for, and that still count then. */
const LAYOUT_CHARACTERS: ReadonlySet<string> = new Set(["[", "]", "?"]);

/** Pressing one of these alone never starts, ends or breaks a shortcut. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
  "Fn",
  "OS",
]);

/** Something a person types into, by element or by role. */
const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="spinbutton"]',
].join(", ");

/** Open surfaces that own the keyboard while they are up. */
export const MODAL_SURFACE_SELECTOR = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
  '[aria-modal="true"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
].join(", ");

/** The day layer's frame, docked or as a sheet (`day-layer.tsx`). */
const DAY_PANEL_SELECTOR = '[data-slot="day-panel"]';

/** True when the key went to a field, which keeps every key it gets. */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as {
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
  };
  if (el.isContentEditable === true) return true;
  if (typeof el.closest !== "function") return false;
  return el.closest(EDITABLE_SELECTOR) != null;
}

/**
 * True when a modifier makes the key somebody else's: Cmd and Ctrl always
 * (browser and screen-reader commands), Alt unless the layout needs it to
 * type one of our punctuation keys. Shift is free: it is how `?` is typed.
 */
export function blockedByModifier(event: ShortcutKeyEvent): boolean {
  if (event.metaKey) return true;
  const altGraph = event.altGraph === true;
  // AltGr reports as Ctrl+Alt on Windows; it is a layout key, not a command.
  if (event.ctrlKey && !altGraph) return true;
  if ((event.altKey || altGraph) && !LAYOUT_CHARACTERS.has(event.key)) {
    return true;
  }
  return false;
}

/** The scope the page is in, read from the open surfaces. */
export function shortcutScope(root: {
  querySelectorAll: (selector: string) => ArrayLike<unknown>;
}): ShortcutScope {
  const open = Array.from(root.querySelectorAll(MODAL_SURFACE_SELECTOR));
  if (open.length === 0) return "page";
  const onlyDay = open.every((el) => {
    const node = el as { closest?: (selector: string) => unknown };
    return (
      typeof node.closest === "function" &&
      node.closest(DAY_PANEL_SELECTOR) != null
    );
  });
  return onlyDay ? "day-sheet" : "off";
}

function normalise(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function isGoToKey(key: string): key is GoToKey {
  return GO_TO_SHORTCUTS.some((shortcut) => shortcut.key === key);
}

/**
 * A reader with the one piece of state a sequence needs: when `g` was
 * pressed. `read` returns the action a key completes, `"pending"` after `g`,
 * or `null` for a key that is not ours (which also drops a pending `g`).
 */
export function createShortcutReader(timeoutMs = SEQUENCE_TIMEOUT_MS) {
  let pendingSince: number | null = null;

  function read(
    event: ShortcutKeyEvent,
    scope: ShortcutScope,
    now: number,
  ): ShortcutAction | "pending" | null {
    if (event.isComposing) return null;
    if (MODIFIER_KEYS.has(event.key)) return null;
    if (event.repeat) return null;

    const pending = pendingSince;
    pendingSince = null;

    if (scope === "off") return null;
    if (isEditableTarget(event.target)) return null;
    if (blockedByModifier(event)) return null;

    const key = normalise(event.key);

    if (key === "[" || key === "]") {
      return { type: "day", delta: key === "[" ? -1 : 1 };
    }
    if (scope !== "page") return null;

    if (pending !== null && now - pending <= timeoutMs) {
      // The second key of a sequence: a destination, or nothing at all, so
      // a mistyped `g n` does not open the add menu.
      if (isGoToKey(key)) return { type: "go", key };
      if (key !== "g") return null;
    }
    if (key === "g") {
      pendingSince = now;
      return "pending";
    }
    if (key === "n") return { type: "capture" };
    if (key === "?") return { type: "help" };
    return null;
  }

  return {
    read,
    /** Forget a pending `g`. */
    reset() {
      pendingSince = null;
    },
  };
}

/** What this session may open, as the navigation offers it. */
export interface ShortcutOffer {
  /** The hrefs of the visible nav destinations. */
  navHrefs: ReadonlyArray<string>;
  /** Where the Settings entry lands, or null when there is none. */
  settingsHref: string | null;
}

/**
 * The href `g` + `key` opens, or null when the destination is not offered: a
 * switched-off module, a Coach without an AI provider, a page a shared record
 * does not cover. Read from the same lists the navigation renders, so a
 * shortcut never opens a door the sidebar does not show.
 */
export function resolveGoTo(key: GoToKey, offer: ShortcutOffer): string | null {
  const shortcut = GO_TO_SHORTCUTS.find((s) => s.key === key);
  if (!shortcut) return null;
  if (shortcut.destination === "settings") return offer.settingsHref;
  return offer.navHrefs.includes(shortcut.destination)
    ? shortcut.destination
    : null;
}
