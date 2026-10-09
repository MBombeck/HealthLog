import { describe, expect, it } from "vitest";

import { visibleNavDestinations } from "@/components/layout/nav-model";
import {
  SEQUENCE_TIMEOUT_MS,
  blockedByModifier,
  createShortcutReader,
  isApplePlatform,
  isEditableTarget,
  resolveGoTo,
  shortcutScope,
  type ShortcutKeyEvent,
} from "@/lib/keyboard/global-shortcuts";

function key(
  k: string,
  over: Partial<ShortcutKeyEvent> = {},
): ShortcutKeyEvent {
  return {
    key: k,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    target: null,
    ...over,
  };
}

/** An element whose `closest` answers for the selectors it matches. */
function element(matches: (selector: string) => boolean) {
  return {
    closest: (selector: string) =>
      selector.split(", ").some((s) => matches(s)) ? {} : null,
  };
}

const input = element((s) => s === "input");
const textarea = element((s) => s === "textarea");
const select = element((s) => s === "select");
const combobox = element((s) => s === '[role="combobox"]');
const editable = { isContentEditable: true, closest: () => null };
const button = element(() => false);

describe("isEditableTarget", () => {
  it("treats fields, comboboxes and contenteditable as the field's", () => {
    for (const target of [input, textarea, select, combobox, editable]) {
      expect(isEditableTarget(target)).toBe(true);
    }
  });

  it("leaves buttons, the body and non-elements to the shortcuts", () => {
    expect(isEditableTarget(button)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});

describe("the reader ignores keys typed into a field", () => {
  it.each([
    ["input", input],
    ["textarea", textarea],
    ["select", select],
    ["combobox", combobox],
    ["contenteditable", editable],
  ])("%s: no action for g d, n, ? or [", (_name, target) => {
    const reader = createShortcutReader();
    expect(reader.read(key("g", { target }), "page", 0)).toBeNull();
    expect(reader.read(key("d", { target }), "page", 10)).toBeNull();
    expect(reader.read(key("n", { target }), "page", 20)).toBeNull();
    expect(reader.read(key("?", { target }), "page", 30)).toBeNull();
    expect(reader.read(key("[", { target }), "page", 40)).toBeNull();
  });

  it("a field between g and d breaks the sequence", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("g"), "page", 0)).toBe("pending");
    expect(reader.read(key("d", { target: input }), "page", 10)).toBeNull();
    expect(reader.read(key("d"), "page", 20)).toBeNull();
  });
});

describe("modifiers", () => {
  it("Cmd, Ctrl and Alt make a letter somebody else's", () => {
    const reader = createShortcutReader();
    for (const over of [
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
    ]) {
      expect(reader.read(key("n", over), "page", 0)).toBeNull();
      expect(reader.read(key("g", over), "page", 0)).toBeNull();
    }
    expect(reader.read(key("?", { metaKey: true }), "page", 0)).toBeNull();
    expect(reader.read(key("?", { ctrlKey: true }), "page", 0)).toBeNull();
  });

  it("a modified second key does not complete g", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("g"), "page", 0)).toBe("pending");
    expect(reader.read(key("d", { metaKey: true }), "page", 10)).toBeNull();
    expect(reader.read(key("d"), "page", 20)).toBeNull();
  });

  it("Shift alone, pressed to type ?, neither acts nor breaks a sequence", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("Shift"), "page", 0)).toBeNull();
    expect(reader.read(key("?"), "page", 5)).toEqual({ type: "help" });
    expect(reader.read(key("g"), "page", 10)).toBe("pending");
    expect(reader.read(key("Shift"), "page", 20)).toBeNull();
    expect(reader.read(key("D"), "page", 30)).toEqual({ type: "go", key: "d" });
  });

  it("[ typed with Option (German Mac) or AltGr (German PC) still steps the day", () => {
    expect(blockedByModifier(key("[", { altKey: true }))).toBe(false);
    expect(
      blockedByModifier(
        key("]", { altKey: true, ctrlKey: true, altGraph: true }),
      ),
    ).toBe(false);
    // Ctrl+Alt without AltGr is a command, not a layout key.
    expect(blockedByModifier(key("[", { altKey: true, ctrlKey: true }))).toBe(
      true,
    );
    expect(blockedByModifier(key("[", { metaKey: true }))).toBe(true);
    // An Alt+arrow is the day layer's own step and stays its own.
    expect(blockedByModifier(key("ArrowLeft", { altKey: true }))).toBe(true);
  });
});

describe("sequence timing", () => {
  it("g then a destination within the window goes there", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("g"), "page", 1000)).toBe("pending");
    expect(reader.read(key("t"), "page", 1000 + SEQUENCE_TIMEOUT_MS)).toEqual({
      type: "go",
      key: "t",
    });
  });

  it("a second key after the window does nothing", () => {
    const reader = createShortcutReader();
    reader.read(key("g"), "page", 0);
    expect(reader.read(key("t"), "page", SEQUENCE_TIMEOUT_MS + 1)).toBeNull();
  });

  it("a destination key without g does nothing", () => {
    const reader = createShortcutReader();
    for (const k of ["d", "t", "c", "m", "l", "i", "s"]) {
      expect(reader.read(key(k), "page", 0)).toBeNull();
    }
  });

  it("an unknown second key cancels; it does not fall through to n", () => {
    const reader = createShortcutReader();
    reader.read(key("g"), "page", 0);
    expect(reader.read(key("n"), "page", 10)).toBeNull();
    expect(reader.read(key("d"), "page", 20)).toBeNull();
  });

  it("g g restarts the window", () => {
    const reader = createShortcutReader();
    reader.read(key("g"), "page", 0);
    expect(reader.read(key("g"), "page", 900)).toBe("pending");
    expect(reader.read(key("s"), "page", 1800)).toEqual({
      type: "go",
      key: "s",
    });
  });

  it("a held key does not repeat the action", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("n", { repeat: true }), "page", 0)).toBeNull();
  });

  it("reset forgets a pending g", () => {
    const reader = createShortcutReader();
    reader.read(key("g"), "page", 0);
    reader.reset();
    expect(reader.read(key("d"), "page", 10)).toBeNull();
  });
});

describe("scope", () => {
  it("an open dialog, menu or popover takes every key", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("n"), "off", 0)).toBeNull();
    expect(reader.read(key("?"), "off", 0)).toBeNull();
    expect(reader.read(key("["), "off", 0)).toBeNull();
    reader.read(key("g"), "page", 0);
    expect(reader.read(key("d"), "off", 10)).toBeNull();
  });

  it("over the day sheet only [ and ] act", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("["), "day-sheet", 0)).toEqual({
      type: "day",
      delta: -1,
    });
    expect(reader.read(key("]"), "day-sheet", 0)).toEqual({
      type: "day",
      delta: 1,
    });
    expect(reader.read(key("n"), "day-sheet", 0)).toBeNull();
    expect(reader.read(key("g"), "day-sheet", 0)).toBeNull();
  });

  it("Escape is never ours", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("Escape"), "page", 0)).toBeNull();
  });

  it("reads the scope from the open surfaces", () => {
    const none = { querySelectorAll: () => [] };
    expect(shortcutScope(none)).toBe("page");
    const daySheet = {
      querySelectorAll: () => [
        {
          closest: (s: string) => (s === '[data-slot="day-panel"]' ? {} : null),
        },
      ],
    };
    expect(shortcutScope(daySheet)).toBe("day-sheet");
    const other = { querySelectorAll: () => [{ closest: () => null }] };
    expect(shortcutScope(other)).toBe("off");
    const both = {
      querySelectorAll: () => [
        {
          closest: (s: string) => (s === '[data-slot="day-panel"]' ? {} : null),
        },
        { closest: () => null },
      ],
    };
    expect(shortcutScope(both)).toBe("off");
  });
});

describe("module gating", () => {
  function offer(modules: Record<string, boolean> | undefined) {
    return {
      navHrefs: visibleNavDestinations(modules).map((d) => d.href),
      settingsHref: "/settings/account",
    };
  }

  it("g t goes nowhere while the timeline module is off", () => {
    expect(resolveGoTo("t", offer({ timeline: false }))).toBeNull();
    expect(resolveGoTo("t", offer({ timeline: true }))).toBe("/timeline");
  });

  it("g m and g l follow the medications and labs modules", () => {
    expect(resolveGoTo("m", offer({ medications: false }))).toBeNull();
    expect(resolveGoTo("l", offer({ labs: false }))).toBeNull();
    expect(resolveGoTo("m", offer({ medications: true }))).toBe("/medications");
    expect(resolveGoTo("l", offer({ labs: true }))).toBe("/labs");
  });

  it("g c follows the coach entry, which carries the AI capability", () => {
    // `useNavModules` folds the capability into `coach`.
    expect(resolveGoTo("c", offer({ coach: false }))).toBeNull();
    expect(resolveGoTo("c", offer({ coach: true }))).toBe("/coach");
  });

  it("g d and g i belong to no module", () => {
    const off = offer({ timeline: false, labs: false, medications: false });
    expect(resolveGoTo("d", off)).toBe("/");
    expect(resolveGoTo("i", off)).toBe("/insights");
  });

  it("inside a shared record the doors sharing does not cover stay shut", () => {
    const shared = {
      navHrefs: visibleNavDestinations({}, true, true).map((d) => d.href),
      settingsHref: null,
    };
    expect(resolveGoTo("i", shared)).toBeNull();
    expect(resolveGoTo("c", shared)).toBeNull();
    expect(resolveGoTo("s", shared)).toBeNull();
    expect(resolveGoTo("d", shared)).toBe("/");
  });

  it("g s lands where the Settings entry lands", () => {
    expect(
      resolveGoTo("s", { navHrefs: [], settingsHref: "/settings/profile" }),
    ).toBe("/settings/profile");
  });
});

describe("Cmd/Ctrl+K opens the command palette", () => {
  it("with Cmd or Ctrl, on the page and from a field", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("k", { metaKey: true }), "page", 0)).toEqual({
      type: "palette",
    });
    expect(reader.read(key("k", { ctrlKey: true }), "page", 0)).toEqual({
      type: "palette",
    });
    expect(
      reader.read(key("K", { ctrlKey: true, target: input }), "page", 0),
    ).toEqual({ type: "palette" });
  });

  it("not with Alt, not as a bare k, not while a dialog is open", () => {
    const reader = createShortcutReader();
    expect(reader.read(key("k"), "page", 0)).toBeNull();
    expect(reader.read(key("k", { altKey: true }), "page", 0)).toBeNull();
    expect(
      reader.read(key("k", { metaKey: true, altKey: true }), "page", 0),
    ).toBeNull();
    expect(reader.read(key("k", { metaKey: true }), "off", 0)).toBeNull();
    expect(reader.read(key("k", { metaKey: true }), "day-sheet", 0)).toBeNull();
  });
});

describe("isApplePlatform", () => {
  it("reads the platform and the user agent", () => {
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(
      isApplePlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 18_0)" }),
    ).toBe(true);
    expect(
      isApplePlatform({ platform: "Win32", userAgent: "Windows NT" }),
    ).toBe(false);
    expect(isApplePlatform({})).toBe(false);
  });
});
