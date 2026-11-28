/**
 * Every path the server sends for the care page derives from one constant.
 *
 * The page is `/care` in the web app, but iOS builds before 1.7 parse only
 * `/checkups`, `/checkups?visit=<id>` and `/checkups?view=visits` in a push
 * target and in an API `href` / `path` (the Today hero action, the next-visit
 * line, the day view). So the wire spelling is `CARE_WIRE_PATH` in
 * `src/lib/encounters/visit-links.ts`, and everything on the wire is built
 * from it. It switches to `/care` once iOS 1.7 has been in the App Store for
 * one release cycle, by changing that one line and the pin below. The
 * `/checkups` redirect in `next.config.ts` stays after the switch.
 *
 * Two rules:
 *
 *  1. Every wire path equals the constant or a builder over it, and each
 *     module that sends the page names the constant.
 *  2. Neither `/checkups` nor `/care` appears as a path literal for this page
 *     anywhere in `src/lib` or `src/app/api` outside `visit-links.ts`
 *     (code only; comments are stripped). The web spelling is a constant
 *     there too, so the web-only modules that name the page carry no literal.
 *
 * And a link to a visit is built by `visit-links.ts` too. Visits are the
 * second tab of `/care`; the bare path opens the first, the preventive-care
 * list, which never lists an appointment. Four surfaces (the dashboard's
 * next-appointment line, the Today rail item, the Today overview fact and
 * the appointment's push) linked an appointment to the bare path, each
 * spelled by hand, so a tap landed on the list it is not on. Over all of
 * `src`, components included:
 *
 *  3. The visit and tab query forms (`/care?visit=`, `/care?view=`, the same
 *     under `/checkups`, and either built on `CARE_WIRE_PATH` or
 *     `CARE_WEB_PATH`) appear only in the builder.
 *  4. The bare `/care` or `/checkups` literal appears only where the target
 *     IS the checkups list, counted per file. A new occurrence fails until
 *     someone decides whether it names a checkup (add it to
 *     `BARE_CHECKUPS`, with the reason) or a visit (use the builder).
 *
 * Not matched, stated rather than hidden: a path assembled from parts
 * (`"/check" + "ups"`). `/api/care/...` and `"nav:/care"` are other things
 * and do not start with the page's slash.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CARE_VISITS_PATH,
  CARE_WEB_PATH,
  CARE_WIRE_PATH,
  VISITS_PATH,
  careVisitPath,
  visitPath,
  visitsPath,
} from "@/lib/encounters/visit-links";
import { NOTIFICATION_TAP_PATHS } from "@/lib/notifications/tap-target";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(__dirname, "..");
const HOME = "lib/encounters/visit-links.ts";

/** The modules that send the page to a client, and what they send. */
const WIRE_SENDERS: Record<string, string> = {
  "lib/notifications/tap-target.ts": "a checkup push target",
  "lib/daily/digest.ts": "the due check-ups rail action",
  "lib/day/records.ts": "a check-up satisfied that day",
};

/** Modules that name the page for the browser, through the web constant. */
const WEB_USERS: Record<string, string> = {
  "lib/navigation/shared-record.ts": "browser route families, not links",
  "lib/onboarding/tour-state.ts": "the tour step's route in the browser",
};

describe("wire paths for the care page", () => {
  it("keeps /checkups on the wire for now", () => {
    expect(CARE_WIRE_PATH).toBe("/checkups");
    expect(CARE_WEB_PATH).toBe("/care");
  });

  it("derives every wire path from the constant", () => {
    expect(NOTIFICATION_TAP_PATHS.MEASUREMENT_REMINDER).toBe(CARE_WIRE_PATH);
    expect(visitPath("v 1")).toBe(`${CARE_WIRE_PATH}?visit=v%201`);
    expect(VISITS_PATH).toBe(`${CARE_WIRE_PATH}?view=visits`);
    expect(visitsPath(["v1"])).toBe(`${CARE_WIRE_PATH}?visit=v1`);
    expect(visitsPath(["v1", "v2"])).toBe(VISITS_PATH);
  });

  it("derives the web links from the web constant", () => {
    expect(careVisitPath("v1")).toBe(`${CARE_WEB_PATH}?visit=v1`);
    expect(CARE_VISITS_PATH).toBe(`${CARE_WEB_PATH}?view=visits`);
  });

  it("each module that names the page imports its constant", () => {
    // Imported from visit-links, and used beyond the import line.
    const uses = (path: string, name: string) => {
      const code = stripComments(readSourceText(join(SRC, path)), path);
      const imported = new RegExp(
        `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"@/lib/encounters/visit-links"`,
      ).test(code);
      const mentions = code.match(new RegExp(`\\b${name}\\b`, "g")) ?? [];
      return imported && mentions.length >= 2;
    };
    for (const path of Object.keys(WIRE_SENDERS)) {
      expect(uses(path, "CARE_WIRE_PATH"), path).toBe(true);
    }
    for (const path of Object.keys(WEB_USERS)) {
      expect(uses(path, "CARE_WEB_PATH"), path).toBe(true);
    }
  });
});

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
};

const QUERY_FORM =
  /(?:\/(?:care|checkups)|\$\{CARE_(?:WIRE|WEB)_PATH\})\?(visit|view)=/;
// The bare page, or the page with a query the builder does not own.
const BARE = /["'`]\/(?:care|checkups)(?:["'`]|\?(?!visit=|view=))/g;

/** Query-form files and bare-literal counts per file, over stripped code. */
function scan(files: readonly { path: string; code: string }[]) {
  const queryForms: string[] = [];
  const bare: Record<string, number> = {};
  for (const { path, code } of files) {
    for (const line of code.split("\n")) {
      if (QUERY_FORM.test(line)) queryForms.push(path);
      const hits = line.match(BARE)?.length ?? 0;
      if (hits > 0) bare[path] = (bare[path] ?? 0) + hits;
    }
  }
  return { queryForms: [...new Set(queryForms)].sort(), bare };
}

const ALL = walkSourceFiles(SRC, { floor: 2500 })
  .filter((p) => !p.includes("__tests__/") && !p.startsWith("generated/"))
  .map((path) => ({
    path,
    code: stripComments(readSourceText(join(SRC, path)), path),
  }));

/** A path literal for the page: the bare page, a query, a hash or a subpath. */
const PAGE_LITERAL = /["'`]\/(?:checkups|care)(?=["'`?#/]|\$\{)/;

function literalHits(files: readonly { path: string; code: string }[]) {
  return files
    .filter(({ code }) => PAGE_LITERAL.test(code))
    .map(({ path }) => path)
    .sort();
}

describe("server code spells the page only in visit-links.ts", () => {
  const files = ALL.filter(
    ({ path }) => path.startsWith("lib/") || path.startsWith("app/api/"),
  );

  it("walks the server tree", () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it("finds a /checkups or /care literal only in visit-links.ts", () => {
    // The home itself must match, or the matcher proves nothing.
    expect(literalHits(files)).toEqual([HOME]);
  });

  it("the matcher sees literals and skips comments and other paths", () => {
    const probe = (code: string) =>
      literalHits([{ path: "x.ts", code: stripComments(code, "x.ts") }]);
    for (const hit of [
      'const a = "/checkups";',
      "const b = '/care';",
      "const c = `/checkups?visit=${id}`;",
      'const d = "/care?view=visits";',
      "const e = `/care${suffix}`;",
    ]) {
      expect(probe(hit), hit).toEqual(["x.ts"]);
    }
    for (const miss of [
      '// "/checkups" in a line comment',
      "/** `/care?visit=<id>` in a docblock */",
      'const f = "/api/care/feed/";',
      'const g = "nav:/care";',
      'const h = "/careers";',
    ]) {
      expect(probe(miss), miss).toEqual([]);
    }
  });
});

describe("links to a visit go through the visit-links builder", () => {
  it("walks the tree", () => {
    expect(ALL.length).toBeGreaterThan(2000);
  });

  it("spells the visit and tab paths only in the builder", () => {
    // The builder itself must match, or the matcher proves nothing.
    expect(
      scan(ALL).queryForms,
      "Build a link to a visit with visitPath() / visitsPath() / VISITS_PATH from src/lib/encounters/visit-links.ts.",
    ).toEqual([HOME]);
  });

  it("links the bare checkups page only where the target is the checkups", () => {
    const { bare } = scan(ALL);
    delete bare[HOME];
    const expected = Object.fromEntries(
      Object.entries(BARE_CHECKUPS).map(([path, { count }]) => [path, count]),
    );
    expect(
      bare,
      "A new bare `/care`: if it leads to a visit, use the visit-links builder; if it really is the checkups list, add it to BARE_CHECKUPS with the reason.",
    ).toEqual(expected);
  });

  it("skips comments and keeps code", () => {
    const probe = (path: string, source: string) => ({
      path,
      code: stripComments(source, path),
    });
    const { queryForms, bare } = scan([
      probe(
        "a.tsx",
        [
          "/**",
          " * `/care?visit=<id>` in a docblock",
          " */",
          '// "/care" in a line comment',
          '{/* a JSX comment naming "/care"',
          '    over two lines "/care" */}',
          'const url = "https://example.test/x"; const bad = "/care";',
        ].join("\n"),
      ),
      probe("b.ts", "const p = `/care?visit=${id}`;"),
      probe("c.ts", "const q = `/care?${params}`;"),
      probe("d.ts", "const r = `${CARE_WIRE_PATH}?view=visits`;"),
    ]);
    expect(queryForms).toEqual(["b.ts", "d.ts"]);
    expect(bare).toEqual({ "a.tsx": 1, "c.ts": 1 });
  });
});
