/**
 * Structural guards for the installed app on a phone — the parts no browser
 * in CI can show, because neither Chromium nor WebKit under Playwright
 * reports a safe-area inset or opens an on-screen keyboard.
 *
 *   1. The authenticated shell takes the status-bar and side insets once,
 *      on its outer wrapper, and no 4rem header band pads itself inside its
 *      own height (which on a phone with a 59 px inset left the top bar a
 *      5 px content box and pushed the logo across its bottom border).
 *   2. The stylesheet carries the rules the shell and the keyboard bridge
 *      depend on.
 *   3. Every form-field primitive keeps 16 px type on a touch screen: iOS
 *      Safari zooms the page into a focused field below 16 px, and a width
 *      breakpoint alone (`md:text-sm`) handed 14 px to a phone held sideways
 *      and to every iPad. The small size is allowed only behind
 *      `pointer-fine:`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** Drop `//` and block comments so prose about a class cannot satisfy a check. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the shell owns the safe area", () => {
  it("the authenticated shell wrapper takes the insets", () => {
    const shell = code(read("src/components/layout/auth-shell.tsx"));
    expect(shell).toMatch(/className="shell-safe-area flex h-dvh flex-col"/);
  });

  it.each([
    "src/components/layout/top-bar.tsx",
    "src/components/insights/coach-panel/conversations-panel.tsx",
    "src/components/day/day-layer.tsx",
  ])("%s pads no header band with the status-bar inset", (path) => {
    const source = code(read(path));
    expect(source).not.toMatch(/paddingTop:\s*"env\(safe-area-inset-top/);
    expect(source).not.toMatch(/\bpt-\[env\(safe-area-inset-top/);
  });

  it("globals.css defines the shell band, the keyboard rules and pointer-fine", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(
      /\.shell-safe-area\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top/,
    );
    expect(css).toMatch(
      /\[data-sheet-side="bottom"\]\s*\{\s*bottom:\s*var\(--keyboard-inset/,
    );
    expect(css).toMatch(
      /html\[data-keyboard="open"\] \[data-keyboard-hide\]\s*\{\s*display:\s*none/,
    );
    expect(css).toMatch(/@custom-variant pointer-fine/);
  });

  it("bottom toasts clear the bar under the same query the bar follows", () => {
    // Sonner's own mobile offset stops at 600 px; the bar shows up to `md`
    // and on a phone held sideways, so the lift keys on `shell-mobile`.
    const css = code(read("src/app/globals.css"));
    expect(css).toMatch(
      /html \[data-sonner-toaster\]\[data-y-position="bottom"\]\s*\{\s*@variant shell-mobile\s*\{\s*bottom:\s*calc\(4rem \+ env\(safe-area-inset-bottom/,
    );
  });

  it("the bottom bar and the Coach button step aside for the keyboard", () => {
    expect(read("src/components/layout/bottom-nav.tsx")).toContain(
      'data-keyboard-hide=""',
    );
    expect(read("src/components/insights/layout-coach-fab.tsx")).toContain(
      'data-keyboard-hide=""',
    );
  });

  it("a bottom sheet on the keyboard drops its home-indicator padding", () => {
    // Standing on the keyboard, the safe-area inset left a ~34 px gap
    // between the sheet's last row and the keys.
    expect(code(read("src/app/globals.css"))).toMatch(
      /@custom-variant keyboard-open \(html\[data-keyboard="open"\] &\);/,
    );
    const sheet = code(read("src/components/ui/responsive-sheet.tsx"));
    const padded = (sheet.match(
      /"[^"]*pb-\[calc\(env\(safe-area-inset-bottom[^"]*"/g,
    ) ?? []) as string[];
    expect(padded.length).toBe(2);
    for (const cls of padded) expect(cls).toMatch(/\bkeyboard-open:pb-4\b/);
  });

  it("those rules sit under the utilities, and the bottom sheet sets no bottom utility", () => {
    // Unlayered, the rules outranked every utility on the same element: a
    // `bg-*` on the shell or a `bottom-*` on a sheet would have been ignored
    // without a trace. In the components layer a utility wins, so the bottom
    // sheet must not carry one that would pin it under the keyboard.
    const css = code(read("src/app/globals.css"));
    const start = css.indexOf("@layer components {");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let i = css.indexOf("{", start); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const layer = css.slice(start, end);
    expect(layer).toMatch(/\.shell-safe-area\s*\{/);
    expect(layer).toMatch(/\[data-sheet-side="bottom"\]\s*\{\s*bottom:/);
    expect(layer).toMatch(/\[data-keyboard-hide\]\s*\{\s*display:\s*none/);
    expect(layer).toMatch(/\[data-sheet-side="left"\]\s*\{\s*border-left:/);
    // Sonner's own rules are unlayered; the toast lift must stay so.
    expect(layer).not.toMatch(/data-sonner-toaster/);

    const sheet = code(read("src/components/ui/sheet.tsx"));
    const bottomBranch = sheet.match(/side === "bottom" &&\s*"([^"]*)"/)?.[1];
    expect(bottomBranch).toBeDefined();
    expect(bottomBranch).not.toMatch(/(?<![\w-])bottom-/);
  });

  it("the sheet primitive names its side for those rules", () => {
    expect(read("src/components/ui/sheet.tsx")).toMatch(
      /data-sheet-side=\{side\}/,
    );
  });
});

describe("form fields keep 16 px on a touch screen", () => {
  const FIELDS = [
    "src/components/ui/input.tsx",
    "src/components/ui/textarea.tsx",
    "src/components/ui/native-select.tsx",
    "src/components/ui/date-field.tsx",
    "src/components/ui/time-field.tsx",
  ];

  it.each(FIELDS)(
    "%s sets text-base and shrinks only under a fine pointer",
    (path) => {
      // The field's own box is the class string that draws its border; the
      // rest of the file (a picker's buttons, a caption) is not typed into.
      const boxes = (code(read(path)).match(
        /"[^"]*\bborder-input(?![\w-])[^"]*"/g,
      ) ?? []) as string[];
      expect(boxes.length, `${path} has no field class`).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(box).toMatch(/\btext-base\b/);
        // Any sub-16 px size must sit behind `pointer-fine:`; `file:` styles
        // the upload button, not typed text.
        const bare = box.match(
          /(?<![\w:-])(?:(?:sm|md|lg|xl):)?text-(?:xs|sm)(?![\w-])/g,
        );
        expect(bare ?? []).toEqual([]);
      }
    },
  );
});
