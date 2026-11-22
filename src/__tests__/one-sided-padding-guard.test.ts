/**
 * A box pads its left and right alike, unless a control sits over one edge.
 *
 * The medication wizard's body carried `p-4 pr-12`: 16 px on the left and
 * 48 px on the right. The 48 px were the header's reserve for the sheet's
 * close button, copied onto the body, where there is no button, so every
 * field of every step ended 32 px short of the edge its own footer ended
 * on. The reserve is right on a header; anywhere else it is a box that sits
 * off-centre.
 *
 * Matched: one class literal that carries a padding for all sides or both
 * horizontal sides (`p-N`, `px-N`) together with a different `pl-M` or
 * `pr-M` at the same breakpoint. Each remaining site is listed with the
 * control its wider edge makes room for; a new one fails.
 *
 * Not matched (stated, not hidden): a class list assembled from several
 * literals (`cn("p-4", wide && "pr-12")`), and a side padding with no
 * all-sides padding beside it (`pl-5` on a list is an indent, not a
 * reserve).
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(__dirname, "..");

/** `path: classes` of each one-sided box, with the control it makes room for. */
const RESERVES: Record<string, string> = {
  "components/ui/sheet.tsx: p-4 pr-12":
    "the sheet header, under the close button",
  "components/medications/wizard/medication-wizard-dialog.tsx: p-4 pr-12 sm:p-6 sm:pr-14":
    "the wizard's stepper band, under the sheet's close button",
  "components/medications/sections/api-tokens-row.tsx: p-3 pr-10":
    "a token's code block, under its copy button",
  "components/settings/coach-conversations-memory-card.tsx: p-1.5 pl-3":
    "a list row whose text starts at the row inset and whose icon buttons bring their own",
};

const LITERAL_RE = /"([^"\n]*)"|`([^`]*)`/g;
const BREAKPOINTS = ["", "sm:", "md:", "lg:", "xl:"];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The paddings of a class list that disagree across its two sides. */
function oneSidedPadding(classList: string): string | null {
  const tokens = classList.split(/\s+/);
  const hits: string[] = [];
  for (const bp of BREAKPOINTS) {
    const all = tokens.find((t) =>
      new RegExp(`^${escape(bp)}px?-[0-9.]+$`).test(t),
    );
    if (!all) continue;
    const step = all.slice(all.lastIndexOf("-") + 1);
    const sides = tokens.filter(
      (t) =>
        new RegExp(`^${escape(bp)}p[lr]-[0-9.]+$`).test(t) &&
        t.slice(t.lastIndexOf("-") + 1) !== step,
    );
    if (sides.length > 0) hits.push(all, ...sides);
  }
  return hits.length > 0 ? hits.join(" ") : null;
}

function findOneSidedBoxes(
  files: { path: string; source: string }[],
): string[] {
  // Every site, not every distinct one: the wizard's body repeated its
  // header's classes to the letter, in the same file.
  const found: string[] = [];
  for (const { path, source } of files) {
    for (const match of source.matchAll(LITERAL_RE)) {
      const padding = oneSidedPadding(match[1] ?? match[2] ?? "");
      if (padding) found.push(`${path}: ${padding}`);
    }
  }
  return found.sort();
}

describe("a box pads both sides alike", () => {
  const files = walkSourceFiles(SRC, { floor: 1200, extensions: [".tsx"] })
    .filter(
      (p) =>
        (p.startsWith("components/") || p.startsWith("app/")) &&
        !p.includes("__tests__/"),
    )
    .map((path) => ({ path, source: readSourceText(join(SRC, path)) }));

  it("recognises the shape it exists to refuse", () => {
    expect(
      findOneSidedBoxes([
        {
          path: "components/x.tsx",
          source:
            '<div className="flex flex-col gap-6 p-4 pr-12 sm:gap-8 sm:p-6 sm:pr-14" />',
        },
        {
          path: "components/y.tsx",
          source: '<div className="p-4 sm:p-6" /><ul className="pl-5" />',
        },
        { path: "components/z.tsx", source: '<div className="px-3 pl-3" />' },
        {
          path: "components/x.tsx",
          source: '<div className="border-b p-4 pr-12 sm:p-6 sm:pr-14" />',
        },
      ]),
    ).toEqual([
      "components/x.tsx: p-4 pr-12 sm:p-6 sm:pr-14",
      "components/x.tsx: p-4 pr-12 sm:p-6 sm:pr-14",
    ]);
  });

  it("finds none but the listed reserves", () => {
    expect(findOneSidedBoxes(files)).toEqual(Object.keys(RESERVES).sort());
  });
});
