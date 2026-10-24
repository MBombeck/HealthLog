/**
 * Guard: an integration or e2e fixture dated near "now" must not feed a time
 * window.
 *
 * A fixture written today with an absolute date (`new Date("2026-07-15…")`,
 * `?date=2026-07-02`) next to a window parameter passes on the day it is
 * written and fails months later, when the date slides out of a window the
 * route counts back from the clock. The suite then goes red on a release
 * branch that changed nothing near it, and the fix is archaeology. That has
 * happened more than once (chart tabs, the 90-day share-link window).
 *
 * The rule: an absolute ISO date within the last 400 days (or in the future)
 * that sits within two lines of a window parameter (`days=`, `from=`, `to=`,
 * `since`, `until`, `date=`, `range=`, `rangeDays`, `windowDays`,
 * `lookbackDays`) is a
 * finding. Fix it by dating the fixture relative to now
 * (`new Date(Date.now() - 3 * DAY_MS)`, a `daysAgo(n)` helper), or, when the
 * window is fixed on both ends and the route never measures it against the
 * clock, allowlist the file below with that reason and the number of findings
 * it may carry, so a new one in the same file still fails.
 *
 * What it cannot see: a fixture date and a relative window that are further
 * apart than two lines (a seed helper at the top of the file, `days=90` in a
 * request at the bottom). It is a textual net for the common shape, not a
 * proof; the clock-shifted run described in the allowlist reasons is what
 * proved the allowlisted files fixed.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const SCAN_ROOTS = ["tests/integration", "e2e"];
const DAY_MS = 86_400_000;
/** How far back an absolute date still counts as "near now". */
const HORIZON_DAYS = 400;
/** Lines either side of a date searched for a window parameter. */
const NEIGHBOURHOOD = 2;

const ISO_DATE = /\b(20\d\d)-(\d\d)-(\d\d)/g;
const WINDOW_PARAM =
  /[?&](?:days|from|to|since|until|date|range|rangeDays|windowDays)=|\b(?:since|until|rangeDays|windowDays|lookbackDays)\b\s*[:=]/;

/**
 * Files whose flagged dates feed windows fixed on both ends, which the routes
 * never compare with the clock. `max` is the number of findings the file may
 * carry; one more fails.
 */
const ALLOWLIST: Record<string, { max: number; reason: string }> = {
  // Each entry passed with the test clock moved a year forward, which is what
  // an aging fixture fails under; the reason says why it cannot age.
  "tests/integration/day-view.test.ts": {
    max: 21,
    reason:
      "day index, timeline and notable reads are asked for explicit from/to windows; the reminder since/until params are fixture data, not a window counted from now",
  },
  "tests/integration/sharing-delegable-routes.test.ts": {
    max: 5,
    reason:
      "day-log reads name one explicit calendar day (?date=), never a window counted from now",
  },
  "tests/integration/measurements-aggregate-daily.test.ts": {
    max: 5,
    reason: "every series read passes both from and to",
  },
  "tests/integration/cycle-routes.test.ts": {
    max: 5,
    reason:
      "day-log reads name one explicit day and the calendar read passes both from and to",
  },
  "tests/integration/medication-auto-mark-taken.test.ts": {
    max: 2,
    reason: "the cases pin the clock with fake timers around the fixed dates",
  },
  "tests/integration/medication-course-end.test.ts": {
    max: 1,
    reason:
      "the cases pin the clock with fake timers; the history read starts on the fixed day the course was ended",
  },
  "tests/integration/symptoms.test.ts": {
    max: 1,
    reason:
      "the discovery matrix reads from a fixed since forward; the fixture days stay inside it as now moves on",
  },
};

export interface AgingFinding {
  file: string;
  line: number;
  text: string;
}

/** Every near-now absolute date within reach of a window parameter. */
export function findAgingFixtureDates(
  files: ReadonlyArray<{ file: string; source: string }>,
  now: number,
): AgingFinding[] {
  const floor = now - HORIZON_DAYS * DAY_MS;
  const findings: AgingFinding[] = [];
  for (const { file, source } of files) {
    const lines = source.split("\n");
    lines.forEach((text, index) => {
      for (const match of text.matchAll(ISO_DATE)) {
        const at = Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
        );
        if (Number.isNaN(at) || at < floor) continue;
        const around = lines
          .slice(Math.max(0, index - NEIGHBOURHOOD), index + NEIGHBOURHOOD + 1)
          .join("\n");
        if (WINDOW_PARAM.test(around)) {
          findings.push({ file, line: index + 1, text: text.trim() });
          break;
        }
      }
    });
  }
  return findings;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx|mts)$/.test(entry.name) ? [full] : [];
  });
}

function scannedFiles() {
  return SCAN_ROOTS.flatMap((root) => walk(path.join(ROOT, root))).map(
    (full) => ({
      file: path.relative(ROOT, full),
      source: fs.readFileSync(full, "utf8"),
    }),
  );
}

describe("aging fixture dates", () => {
  const files = scannedFiles();

  it("scans the integration and e2e trees (never vacuously)", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.file.startsWith("e2e/"))).toBe(true);
  });

  it("no near-now absolute date feeds a window outside the allowlist", () => {
    const findings = findAgingFixtureDates(files, Date.now());
    const byFile = new Map<string, AgingFinding[]>();
    for (const finding of findings) {
      const list = byFile.get(finding.file) ?? [];
      list.push(finding);
      byFile.set(finding.file, list);
    }
    const offenders: string[] = [];
    for (const [file, list] of byFile) {
      const allowed = ALLOWLIST[file]?.max ?? 0;
      if (list.length > allowed) {
        offenders.push(
          ...list.map(
            (f) =>
              `${f.file}:${f.line}  ${f.text}\n    -> date it relative to now (Date.now() - n * DAY_MS), or allowlist a fixed window with its reason`,
          ),
        );
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every allowlist entry still names a file with findings", () => {
    // A stale entry would quietly allow the next finding in that file.
    const findings = findAgingFixtureDates(files, Date.now());
    for (const file of Object.keys(ALLOWLIST)) {
      expect(
        findings.some((f) => f.file === file),
        `${file} has no findings left; drop its allowlist entry`,
      ).toBe(true);
    }
  });

  it("flags a near-now fixture next to a window, and nothing older", () => {
    const now = Date.UTC(2026, 9, 15);
    const findings = findAgingFixtureDates(
      [
        {
          file: "a.test.ts",
          source: [
            'const takenAt = new Date("2026-07-15T08:00:00Z");',
            'await get("/api/series?kind=pulse&days=90");',
          ].join("\n"),
        },
        { file: "b.test.ts", source: 'get("/api/day-logs?date=2026-07-02");' },
        {
          file: "c.test.ts",
          source: 'get("/api/labs?from=2019-04-01T00:00:00Z&to=2019-05-01");',
        },
        { file: "d.test.ts", source: 'const at = new Date("2026-07-15");' },
      ],
      now,
    );
    expect(findings.map((f) => `${f.file}:${f.line}`)).toEqual([
      "a.test.ts:1",
      "b.test.ts:1",
    ]);
  });
});
