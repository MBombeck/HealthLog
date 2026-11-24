/**
 * The authenticated shell's geometry decisions, which no browser under test
 * can show going wrong: Playwright's WebKit and Chromium have no floating
 * toolbar, no rotation and no home indicator, so `100dvh` always equals the
 * window there. On an iPad it does not, and that disagreement was the strip
 * under the shell and the cut-off card. These hold the decisions that take
 * the disagreement out; `e2e/tablet-shell.spec.ts` measures the result.
 */
import { describe, expect, it } from "vitest";

import { readSource } from "@/__tests__/helpers/source-files";

import {
  MAIN_CONTENT_WRAPPER_CLASS,
  MAIN_SCROLL_CLASS,
  RAIL_ACCOUNT_BAND,
  RAIL_WIDTH_COLLAPSED,
  RAIL_WIDTH_EXPANDED,
  SHELL_HEADER_BAND,
  SHELL_ROOT_CLASS,
  SUB_SHELL_GRID_FLOOR,
} from "../shell-metrics";

const shellSource = () =>
  readSource("src/components/layout/auth-shell.tsx", [
    "SHELL_ROOT_CLASS",
    'data-slot="main-content-wrapper"',
  ]);
const classes = (value: string) => value.split(/\s+/).filter(Boolean);

describe("the shell takes the window's edges", () => {
  it("takes its height from the initial containing block, never from a viewport unit", () => {
    const shell = classes(SHELL_ROOT_CLASS);
    expect(shell).toEqual(
      expect.arrayContaining(["shell-safe-area", "absolute", "inset-0"]),
    );
    // `fixed` re-rasterises the whole app in its own layer and traps the
    // bottom bar's z-index in a stacking context.
    expect(shell.filter((c) => /(^|:)fixed$/.test(c))).toEqual([]);
    expect(SHELL_ROOT_CLASS).not.toMatch(
      /\b(?:min-)?h-(?:dvh|svh|lvh|screen)\b/,
    );
    expect(SHELL_ROOT_CLASS).not.toMatch(/\d+(?:d|s|l)?vh/);
  });

  it("AuthShell renders that box and flags the document for it", () => {
    const source = shellSource();
    expect(source).toContain(
      '<div data-slot="app-shell" className={SHELL_ROOT_CLASS}>',
    );
    expect(source).not.toMatch(/shell-safe-area flex h-dvh/);
    expect(source).toMatch(
      /useDocumentScrollMode\(\s*isBodyScrolled \? "body" : rendersAppShell \? "shell" : null/,
    );
    const css = readSource("src/app/globals.css", '[data-scroll="shell"]');
    expect(css).toMatch(
      /html\[data-scroll="shell"\],\s*html\[data-scroll="shell"\] body\s*\{\s*height:\s*100%;\s*overflow:\s*hidden;\s*overscroll-behavior:\s*none;/,
    );
  });
});

describe("the home-indicator inset has one source", () => {
  it("is env() behind one property, which every owner of the bottom edge reads", () => {
    const css = readSource("src/app/globals.css", "--safe-area-bottom");
    expect(css).toMatch(
      /--safe-area-bottom:\s*env\(safe-area-inset-bottom,\s*0px\);/,
    );
    for (const [path, anchor] of [
      ["src/components/layout/sidebar-nav.tsx", "export function SidebarNav"],
      ["src/components/layout/bottom-nav.tsx", 'data-slot="bottom-nav"'],
    ] as const) {
      expect(readSource(path, anchor)).toContain("--safe-area-bottom");
    }
    expect(MAIN_SCROLL_CLASS).not.toContain("safe-area-inset-bottom");
  });
});

/** The value a `:root` token is declared with, per shell. */
function tokens(css: string) {
  const start = css.indexOf("  :root {\n    --safe-area-top:");
  const block = css.slice(start, css.indexOf("\n  }\n", start));
  const desktopAt = block.indexOf("@variant shell-desktop");
  const read = (part: string) =>
    Object.fromEntries(
      [...part.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
        m[1],
        m[2].replace(/\s+/g, " ").trim(),
      ]),
    );
  const phone = read(block.slice(0, desktopAt));
  return { phone, desktop: { ...phone, ...read(block.slice(desktopAt)) } };
}

function rems(value: string, t: Record<string, string>): number {
  // Lengths in rem only; the safe areas count as zero (they add to both
  // sides of every comparison below alike).
  let resolved = value;
  for (let i = 0; i < 8 && resolved.includes("var("); i += 1) {
    resolved = resolved.replace(/var\((--[\w-]+)\)/g, (_, name: string) =>
      name.startsWith("--safe-area-") ? "0rem" : `(${t[name]})`,
    );
  }
  const expr = resolved
    .replace(/calc\(/g, "(")
    .replace(/(\d+(?:\.\d+)?)rem/g, "$1")
    .replace(/0px/g, "0");
  expect(expr).toMatch(/^[\d.+\-*/()\s]+$/);
  return Function(`return ${expr}`)() as number;
}

describe("the bottom edge is cleared in both shells, from one set of tokens", () => {
  const css = readSource("src/app/globals.css", "--floating-action-clearance");
  const shells = tokens(css);
  const fab = readSource(
    "src/components/insights/layout-coach-fab.tsx",
    'data-slot="coach-fab"',
  );

  it("main clears the bottom chrome and the frame clears the floating button", () => {
    expect(classes(MAIN_SCROLL_CLASS)).toContain("pb-(--chrome-bottom)");
    expect(classes(MAIN_SCROLL_CLASS).filter((c) => /pb-/.test(c))).toEqual([
      "pb-(--chrome-bottom)",
    ]);
    expect(MAIN_CONTENT_WRAPPER_CLASS).toBe(
      classes(MAIN_CONTENT_WRAPPER_CLASS).join(" "),
    );
    expect(
      classes(MAIN_CONTENT_WRAPPER_CLASS).filter((c) => /pb-/.test(c)),
    ).toEqual(["pb-(--floating-action-clearance)"]);
    expect(shellSource()).toContain(": MAIN_CONTENT_WRAPPER_CLASS");
  });

  it("the Coach button stands on the floating-action tokens", () => {
    expect(fab).toContain("bottom-(--floating-action-bottom)");
    expect(fab).toContain("size-(--floating-action-size)");
  });

  it.each(["phone", "desktop"] as const)(
    "the last line scrolls clear of the Coach button in the %s shell",
    (shell) => {
      const t = shells[shell];
      // Measured from the window's bottom edge: the scroller's padding plus
      // the frame's against the top of the button.
      const pageEnd =
        rems(t["--chrome-bottom"], t) +
        rems(t["--floating-action-clearance"], t);
      const fabTop =
        rems(t["--floating-action-bottom"], t) +
        rems(t["--floating-action-size"], t);
      expect(pageEnd - fabTop).toBeGreaterThanOrEqual(1);
    },
  );

  it("the phone shell has a bar, the desktop shell none", () => {
    expect(rems(shells.phone["--bottom-bar-height"], shells.phone)).toBe(4);
    expect(rems(shells.desktop["--bottom-bar-height"], shells.desktop)).toBe(0);
  });

  it("the sub-shell floor follows the frame's padding", () => {
    expect(SUB_SHELL_GRID_FLOOR).toBe(
      "md:min-h-[calc(100dvh-5.5rem-var(--floating-action-clearance))]",
    );
  });
});

describe("the strip beyond the layout is painted, never covered", () => {
  const css = readSource("src/app/globals.css", "--chrome-bottom-surface");
  const shells = tokens(css);

  it("the root paints the colour of what owns the bottom edge", () => {
    expect(css).toMatch(
      /html\[data-scroll="shell"\]\s*\{\s*background-color:\s*var\(--chrome-bottom-surface\);\s*\}/,
    );
    // The phone shell's bottom edge is the bar's; the bar is `bg-card`.
    expect(shells.phone["--chrome-bottom-surface"]).toBe("var(--card)");
    expect(
      readSource(
        "src/components/layout/bottom-nav.tsx",
        'data-slot="bottom-nav"',
      ),
    ).toMatch(/data-slot="bottom-nav"[\s\S]*?className="bg-card /);
    expect(shells.desktop["--chrome-bottom-surface"]).toBe("var(--background)");
  });

  it("the shell box paints the page colour itself", () => {
    const block = /\.shell-safe-area\s*\{([\s\S]*?)\n  \}/.exec(css)![1];
    expect(block).toMatch(
      /background:\s*linear-gradient\(var\(--card\), var\(--card\)\) top \/ 100%\s+var\(--safe-area-top\) no-repeat var\(--background\);/,
    );
  });

  it("the shell box takes the window's edges and no correction moves it", () => {
    // 1.48.4 extended the shell and the bar over the strip and looped on
    // iOS 27 (#1426). Geometry stays on the initial containing block.
    expect(SHELL_ROOT_CLASS).toBe(
      "shell-safe-area absolute inset-0 flex flex-col",
    );
    expect(css).not.toMatch(/--viewport-bottom/);
  });
});

/**
 * The side insets. An iPad in a Safari tab laid the shell out 10 px in from
 * the left edge in portrait; the shell padded that inset and its strip showed
 * the page colour beside the rail, from the logo band to the account row.
 * Desktop browsers report no side inset, so `e2e/tablet-shell.spec.ts`
 * simulates one through `--safe-area-left` and measures the result; these
 * hold the decisions that route the inset to the rail.
 */
describe("the side insets belong to what meets them", () => {
  const css = () => readSource("src/app/globals.css", ".shell-safe-area {");
  const rail = () =>
    readSource(
      "src/components/layout/sidebar-nav.tsx",
      "export function SidebarNav",
    );

  it("are env() behind one property each, which the shell and the rail read", () => {
    const root = readSource("src/app/globals.css", "--safe-area-left");
    expect(root).toMatch(
      /--safe-area-left:\s*env\(safe-area-inset-left,\s*0px\);/,
    );
    expect(root).toMatch(
      /--safe-area-right:\s*env\(safe-area-inset-right,\s*0px\);/,
    );
    expect(css()).not.toMatch(/padding-(?:left|right):\s*env\(/);
  });

  it("the desktop shell pads no side, the phone shell pads both", () => {
    const block = /\.shell-safe-area\s*\{([\s\S]*?)\n  \}/.exec(css())![1];
    expect(block).toMatch(/padding-left:\s*var\(--safe-area-left\);/);
    expect(block).toMatch(/padding-right:\s*var\(--safe-area-right\);/);
    expect(block).toMatch(
      /@variant shell-desktop\s*\{\s*padding-right:\s*0;\s*padding-left:\s*0;\s*\}/,
    );
  });

  it("the rail takes the left inset inside its own background", () => {
    const source = rail();
    expect(source).toMatch(/<aside[\s\S]*?pl-\(--safe-area-left\)/);
    expect(RAIL_WIDTH_COLLAPSED).toBe("w-[calc(4rem+var(--safe-area-left))]");
    expect(RAIL_WIDTH_EXPANDED).toBe("w-[calc(16rem+var(--safe-area-left))]");
  });

  it("the account band mirrors the logo band", () => {
    const height = (value: string) => /\bh-(\d+)\b/.exec(value)?.[1];
    expect(height(RAIL_ACCOUNT_BAND)).toBe(height(SHELL_HEADER_BAND));
    expect(RAIL_ACCOUNT_BAND).toContain("border-t");
  });
});
