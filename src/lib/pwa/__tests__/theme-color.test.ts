import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyThemeColor,
  parseThemeChoice,
  resolveTheme,
  THEME_BOOT_SCRIPT,
  THEME_COLOR,
} from "@/lib/pwa/theme-color";

/** Every stored value a browser can hold, the odd ones included. */
const STORED_VALUES = [null, "light", "dark", "system", "", "auto"] as const;

function fakeMeta(content: string) {
  const attrs = new Map<string, string>([["content", content]]);
  return {
    attrs,
    setAttribute: (k: string, v: string) => attrs.set(k, v),
  };
}

describe("applyThemeColor", () => {
  it("rewrites both media-keyed tags to the theme the page painted", () => {
    // A phone in light mode, the app set to dark: the light tag is
    // the one the browser applies, and it must carry the dark colour.
    const light = fakeMeta(THEME_COLOR.light);
    const dark = fakeMeta(THEME_COLOR.dark);
    const doc = {
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('meta[name="theme-color"]');
        return [light, dark];
      },
    } as unknown as Document;

    applyThemeColor(doc, "dark");
    expect(light.attrs.get("content")).toBe(THEME_COLOR.dark);
    expect(dark.attrs.get("content")).toBe(THEME_COLOR.dark);

    applyThemeColor(doc, "light");
    expect(light.attrs.get("content")).toBe(THEME_COLOR.light);
    expect(dark.attrs.get("content")).toBe(THEME_COLOR.light);
  });

  it("matches each theme's --background in globals.css", () => {
    const css = readFileSync(
      resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    // The dark palette is declared in hex; the bar colour must be it exactly.
    expect(css).toMatch(
      new RegExp(`--background:\\s*${THEME_COLOR.dark};`, "i"),
    );
  });
});

describe("THEME_BOOT_SCRIPT", () => {
  function boot(
    stored: string | null,
    systemDark: boolean,
    { storageThrows = false } = {},
  ) {
    const metas = [fakeMeta(THEME_COLOR.light), fakeMeta(THEME_COLOR.dark)];
    const classes = new Set<string>();
    const listeners = new Map<string, () => void>();
    const document = {
      documentElement: { classList: { add: (c: string) => classes.add(c) } },
      querySelectorAll: () => metas,
      addEventListener: (type: string, fn: () => void) =>
        listeners.set(type, fn),
    };
    const window = {
      matchMedia: () => ({ matches: systemDark }),
    };
    const localStorage = {
      getItem: () => {
        if (storageThrows) throw new Error("SecurityError");
        return stored;
      },
    };
    new Function("window", "document", "localStorage", THEME_BOOT_SCRIPT)(
      window,
      document,
      localStorage,
    );
    return { metas, classes, listeners };
  }

  it("follows the device with nothing stored", () => {
    expect([...boot(null, false).classes]).toEqual(["light"]);
    expect([...boot(null, true).classes]).toEqual(["dark"]);
  });

  it("keeps a stored dark choice on a light device", () => {
    // The light-keyed tag is the one the browser applies, so it must carry
    // the dark colour before hydration.
    const { metas, classes } = boot("dark", false);
    expect([...classes]).toEqual(["dark"]);
    for (const meta of metas) {
      expect(meta.attrs.get("content")).toBe(THEME_COLOR.dark);
    }
  });

  it("still follows the device when storage is refused", () => {
    expect([...boot(null, false, { storageThrows: true }).classes]).toEqual([
      "light",
    ]);
  });

  it("paints what the app resolves, for every stored value and device", () => {
    for (const stored of STORED_VALUES) {
      for (const systemDark of [false, true]) {
        const expected = resolveTheme(stored, systemDark);
        const { classes, metas } = boot(stored, systemDark);
        expect([...classes], `${stored} / dark=${systemDark}`).toEqual([
          expected,
        ]);
        for (const meta of metas) {
          expect(meta.attrs.get("content")).toBe(THEME_COLOR[expected]);
        }
      }
    }
  });

  it("follows a stored light choice on a dark system", () => {
    const { metas, classes } = boot("light", true);
    expect([...classes]).toEqual(["light"]);
    for (const meta of metas) {
      expect(meta.attrs.get("content")).toBe(THEME_COLOR.light);
    }
  });

  it("repeats the rewrite once the document is parsed", () => {
    const { listeners } = boot("system", true);
    expect(listeners.has("DOMContentLoaded")).toBe(true);
  });
});

describe("resolveTheme", () => {
  it("follows the system unless light or dark was chosen", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice("system")).toBe("system");
    expect(parseThemeChoice("auto")).toBe("system");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice("light")).toBe("light");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});
