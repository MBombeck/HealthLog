import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyThemeColor,
  THEME_BOOT_SCRIPT,
  THEME_COLOR,
} from "@/lib/pwa/theme-color";

function fakeMeta(content: string) {
  const attrs = new Map<string, string>([["content", content]]);
  return {
    attrs,
    setAttribute: (k: string, v: string) => attrs.set(k, v),
  };
}

describe("applyThemeColor", () => {
  it("rewrites both media-keyed tags to the theme the page painted", () => {
    // A phone in light mode, the app in its dark default: the light tag is
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
  function boot(stored: string | null, systemDark: boolean) {
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
    const localStorage = { getItem: () => stored };
    new Function("window", "document", "localStorage", THEME_BOOT_SCRIPT)(
      window,
      document,
      localStorage,
    );
    return { metas, classes, listeners };
  }

  it("paints the status bar in the app's theme before hydration", () => {
    // A light system, the app in its dark default: the light-keyed tag is
    // the one the browser applies, so it must carry the dark colour already.
    const { metas, classes } = boot(null, false);
    expect([...classes]).toEqual(["dark"]);
    for (const meta of metas) {
      expect(meta.attrs.get("content")).toBe(THEME_COLOR.dark);
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
