/**
 * What leaves the server still says `/checkups`.
 *
 * The page moved to `/care` in the web app, but the released iPhone app
 * parses only `/checkups`, `/checkups?visit=<id>` and `/checkups?view=visits`
 * in a push target and in an API `href` / `path` (the Today hero action, the
 * next-visit line). `/checkups` stays on the wire for iOS builds before 1.7 and
 * switches to `/care` in 1.50; the browser follows the permanent redirect.
 *
 * This pins the wire spellings, and walks the server code (`src/lib`,
 * `src/app/api`) for a `/care` path literal, so a later edit cannot move a
 * payload to `/care` ahead of the app. The few web-only modules under `src/lib`
 * that name the page are listed with the reason.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CARE_VISITS_PATH,
  VISITS_PATH,
  careVisitPath,
  visitPath,
  visitsPath,
} from "@/lib/encounters/visit-links";
import { NOTIFICATION_TAP_PATHS } from "@/lib/notifications/tap-target";

import {
  readSource,
  readSourceText,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(__dirname, "..");

describe("wire paths for the care page", () => {
  it("push targets and API links keep /checkups", () => {
    expect(NOTIFICATION_TAP_PATHS.MEASUREMENT_REMINDER).toBe("/checkups");
    expect(visitPath("v1")).toBe("/checkups?visit=v1");
    expect(VISITS_PATH).toBe("/checkups?view=visits");
    expect(visitsPath(["v1"])).toBe("/checkups?visit=v1");
    expect(visitsPath(["v1", "v2"])).toBe("/checkups?view=visits");
  });

  it("links the web renders itself use /care", () => {
    expect(careVisitPath("v1")).toBe("/care?visit=v1");
    expect(CARE_VISITS_PATH).toBe("/care?view=visits");
  });

  it("the digest and the day view carry the bare page as /checkups", () => {
    // The anchor is the assertion: readSource throws when it is missing.
    for (const file of ["src/lib/daily/digest.ts", "src/lib/day/records.ts"]) {
      expect(readSource(file, 'href: "/checkups",')).toContain("/checkups");
    }
  });
});

/** Server modules that may name `/care`: none of them builds a payload. */
const WEB_ONLY: Record<string, string> = {
  "lib/encounters/visit-links.ts": "the web spelling beside the wire one",
  "lib/navigation/shared-record.ts": "browser route families, not links",
  "lib/onboarding/tour-state.ts": "the tour step's route in the browser",
};

describe("server code does not send /care", () => {
  const files = walkSourceFiles(SRC, { floor: 2500 })
    .filter(
      (p) =>
        (p.startsWith("lib/") || p.startsWith("app/api/")) &&
        !p.includes("__tests__/") &&
        /\.tsx?$/.test(p),
    )
    .map((path) => ({ path, source: readSourceText(join(SRC, path)) }));

  it("walks the server tree", () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it("finds a /care path literal only in the web-only modules", () => {
    const literal = /["'`]\/care(?:[?/"'`])/;
    const hits = files
      .filter(({ source }) =>
        source
          .split("\n")
          .some(
            (line) => literal.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line),
          ),
      )
      .map(({ path }) => path)
      .sort();
    expect(hits).toEqual(Object.keys(WEB_ONLY).sort());
  });
});
