import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { applyThemeColor, THEME_COLOR } from "@/lib/pwa/theme-color";

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
