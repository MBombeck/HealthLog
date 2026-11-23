/**
 * A link to a visit is built by `src/lib/encounters/visit-links.ts`, and a
 * bare `/care` (or `/checkups`, its spelling on the wire until 1.50) is a link
 * to the checkups, never to a visit.
 *
 * Visits are the second tab of `/care`. The bare path opens the first
 * one, the preventive-care list, which never lists an appointment. Four
 * surfaces showed an upcoming appointment and linked it to the bare path —
 * the dashboard's next-appointment line, the Today rail item, the Today
 * overview fact and the appointment's push — so a tap on the appointment
 * landed on the list it is not on. Each had spelled the path by hand.
 *
 * Two rules, both over code lines (comments are skipped):
 *
 *  1. The visit and tab query forms (`/care?visit=`, `/care?view=`, and the
 *     same under `/checkups`) appear only in the builder.
 *  2. The bare `/care` or `/checkups` literal appears only where the target IS the
 *     checkups list, counted per file. A new occurrence fails the run until
 *     someone decides whether it names a checkup (add it here, with the
 *     reason) or a visit (use the builder).
 *
 * Not matched, stated rather than hidden: a path assembled from parts
 * (`"/check" + "ups"`), and a `/*` inside a string on the same line as the
 * literal, which the comment skipper reads as a comment.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(__dirname, "..");
const BUILDER = "lib/encounters/visit-links.ts";

/**
 * Where a bare `/care` is right, and how often: each names the
 * preventive-care list itself, or lists routes rather than linking one.
 */
const BARE_CHECKUPS: Record<string, { count: number; why: string }> = {
  "components/layout/nav-model.ts": { count: 1, why: "the page's nav entry" },
  "hooks/use-nav-counts.ts": {
    count: 1,
    why: "the key of the checkups count in the navigation, not a link",
  },
  "components/layout/context-links.tsx": {
    count: 1,
    why: "the key of the checkups page's own context-link row, not a link",
  },
  "components/measurement-reminders/vorsorge-section.tsx": {
    count: 1,
    why: "the checkups page mounting its own context-link row",
  },
  "components/measurement-reminders/vorsorge-dashboard-card.tsx": {
    count: 1,
    why: "the checkups card's empty state opens the checkups",
  },
  "components/illness/illness-episode-detail.tsx": {
    count: 2,
    why: "the body-site view (`?site=`); the bare fallback never renders",
  },
  "lib/navigation/shared-record.ts": {
    count: 2,
    why: "route lists for domain visibility, not links",
  },
  "lib/daily/digest.ts": {
    count: 1,
    why: "the due check-ups rail item (wire spelling)",
  },
  "lib/day/records.ts": {
    count: 1,
    why: "a check-up satisfied that day (wire spelling)",
  },
  "lib/onboarding/tour-state.ts": { count: 1, why: "the checkups tour step" },
  "lib/notifications/tap-target.ts": {
    count: 1,
    why: "a checkup push (wire spelling); an appointment's names its visit as override",
  },
};

/** The code on each line, with line and block comments removed. */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of source.split("\n")) {
    let line = raw;
    let code = "";
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf("*/");
        if (end === -1) {
          line = "";
          break;
        }
        inBlock = false;
        line = line.slice(end + 2);
        continue;
      }
      const start = line.indexOf("/*");
      const lineComment = line.search(/(^|[^:])\/\//);
      if (lineComment !== -1 && (start === -1 || lineComment < start)) {
        code += line.slice(
          0,
          lineComment + (line[lineComment] === "/" ? 0 : 1),
        );
        line = "";
        break;
      }
      if (start === -1) {
        code += line;
        line = "";
        break;
      }
      code += line.slice(0, start);
      inBlock = true;
      line = line.slice(start + 2);
    }
    out.push(code);
  }
  return out;
}

const QUERY_FORM = /\/(?:care|checkups)\?(visit|view)=/;
// The bare page, or the page with a query the builder does not own.
const BARE = /["'`]\/(?:care|checkups)(?:["'`]|\?(?!visit=|view=))/g;

function scan(files: { path: string; source: string }[]) {
  const queryForms: string[] = [];
  const bare: Record<string, number> = {};
  for (const { path, source } of files) {
    for (const line of codeLines(source)) {
      if (QUERY_FORM.test(line)) queryForms.push(path);
      const hits = line.match(BARE)?.length ?? 0;
      if (hits > 0) bare[path] = (bare[path] ?? 0) + hits;
    }
  }
  return { queryForms: [...new Set(queryForms)].sort(), bare };
}

describe("links to a visit go through the visit-links builder", () => {
  const files = walkSourceFiles(SRC, { floor: 2500 })
    .filter((p) => !p.includes("__tests__/") && !p.startsWith("generated/"))
    .map((path) => ({ path, source: readFileSync(join(SRC, path), "utf8") }));

  it("walks the tree", () => {
    expect(files.length).toBeGreaterThan(2000);
  });

  it("spells the visit and tab paths only in the builder", () => {
    // The builder itself must match, or the matcher proves nothing.
    expect(
      scan(files).queryForms,
      "Build a link to a visit with visitPath() / visitsPath() / VISITS_PATH from src/lib/encounters/visit-links.ts.",
    ).toEqual([BUILDER]);
  });

  it("links the bare checkups page only where the target is the checkups", () => {
    const { bare } = scan(files);
    delete bare[BUILDER];
    const expected = Object.fromEntries(
      Object.entries(BARE_CHECKUPS).map(([path, { count }]) => [path, count]),
    );
    expect(
      bare,
      "A new bare `/care`: if it leads to a visit, use the visit-links builder; if it really is the checkups list, add it to BARE_CHECKUPS with the reason.",
    ).toEqual(expected);
  });

  it("skips comments and keeps code", () => {
    const { queryForms, bare } = scan([
      {
        path: "a.tsx",
        source: [
          "/**",
          " * `/care?visit=<id>` in a docblock",
          " */",
          '// "/care" in a line comment',
          '{/* a JSX comment naming "/care"',
          '    over two lines "/care" */}',
          'const url = "https://example.test/x"; const bad = "/care";',
        ].join("\n"),
      },
      { path: "b.ts", source: "const p = `/care?visit=${id}`;" },
      { path: "c.ts", source: "const q = `/care?${params}`;" },
    ]);
    expect(queryForms).toEqual(["b.ts"]);
    expect(bare).toEqual({ "a.tsx": 1, "c.ts": 1 });
  });
});
