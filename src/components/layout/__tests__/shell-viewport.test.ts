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
/** The page frame's class list: the one `mx-auto max-w-screen-xl` literal. */
const MAIN_CONTENT_WRAPPER_CLASS =
  /"([^"]*\bmx-auto max-w-screen-xl\b[^"]*)"/.exec(shellSource())![1];
const classes = (value: string) => value.split(/\s+/).filter(Boolean);

/** Tailwind spacing step or `[calc(env(...)+Nrem)]` offset, in rem. */
function rem(token: string): number {
  const calc = /\+(\d+(?:\.\d+)?)rem\)\]$/.exec(token);
  if (calc) return Number(calc[1]);
  const step = /-(\d+(?:\.\d+)?)$/.exec(token);
  if (step) return Number(step[1]) / 4;
  throw new Error(`no length in ${token}`);
}

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
    expect(source).toContain("<div className={SHELL_ROOT_CLASS}>");
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
      /:root\s*\{\s*--safe-area-bottom:\s*env\(safe-area-inset-bottom,\s*0px\);/,
    );
    for (const [path, anchor] of [
      ["src/components/layout/sidebar-nav.tsx", "export function SidebarNav"],
      ["src/components/layout/bottom-nav.tsx", 'data-slot="bottom-nav"'],
      ["src/components/insights/layout-coach-fab.tsx", 'data-slot="coach-fab"'],
    ] as const) {
      expect(readSource(path, anchor)).toContain("--safe-area-bottom");
    }
    expect(MAIN_SCROLL_CLASS).not.toContain("safe-area-inset-bottom");
    // Where a WKWebView browser keeps the page out of the strip over the
    // home indicator, it fills it with the root's colour: the content's.
    expect(css).toMatch(
      /html\[data-scroll="shell"\]\s*\{\s*background-color:\s*var\(--background\);\s*\}/,
    );
  });
});

describe("the bottom edge is cleared in both shells", () => {
  const fab = readSource(
    "src/components/insights/layout-coach-fab.tsx",
    'data-slot="coach-fab"',
  );
  const fabSize = rem(/\bsize-(\d+)\b/.exec(fab)![0]);
  const phoneFabBottom = rem(
    /(?<![\w:-])bottom-\[calc\(var\(--safe-area-bottom\)\+[\d.]+rem\)\]/.exec(
      fab,
    )![0],
  );
  const desktopFabBottom = rem(
    /shell-desktop:bottom-\[calc\(var\(--safe-area-bottom\)\+[\d.]+rem\)\]/.exec(
      fab,
    )![0],
  );
  const wrapper = classes(MAIN_CONTENT_WRAPPER_CLASS);
  const main = classes(MAIN_SCROLL_CLASS);

  it("the desktop shell's main keeps the home indicator off the last line", () => {
    expect(main).not.toContain("shell-desktop:pb-0");
    expect(main).toContain("shell-desktop:pb-(--safe-area-bottom)");
  });

  it("the last line scrolls clear of the Coach button in the phone shell", () => {
    const mainPad = Number(
      /^pb-\[calc\((\d+(?:\.\d+)?)rem\+var\(--safe-area-bottom\)\)\]$/.exec(
        main.find((c) => c.startsWith("pb-[calc("))!,
      )![1],
    );
    const wrapperPad = rem(wrapper.find((c) => /^pb-\d+$/.test(c))!);
    expect(mainPad + wrapperPad).toBeGreaterThan(phoneFabBottom + fabSize);
  });

  it("the last line scrolls clear of the Coach button in the desktop shell", () => {
    const wrapperPad = rem(
      wrapper.find((c) => /^shell-desktop:pb-\d+$/.test(c))!,
    );
    expect(wrapperPad).toBeGreaterThan(desktopFabBottom + fabSize);
  });

  it("the sub-shell floor follows the desktop shell's padding", () => {
    // Top bar 4rem + pt-6 + the wrapper's bottom padding.
    const desktopPad = rem(
      wrapper.find((c) => /^shell-desktop:pb-\d+$/.test(c))!,
    );
    expect(SUB_SHELL_GRID_FLOOR).toContain(
      `shell-desktop:min-h-[calc(100dvh-${4 + 1.5 + desktopPad}rem)]`,
    );
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
