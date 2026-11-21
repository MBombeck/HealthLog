/**
 * Structural guard: push and notification code declares no dose window of
 * its own.
 *
 * Whether a dose is pending, due, overdue or missed is resolved once on the
 * server (`src/lib/medications/dose-state/resolve.ts`), from the medication's
 * own bands. The Live Activity relay pass used to carry a fixed 30-minute due
 * grace and a 3-hour overdue window beside it, so a medication with a stored
 * dose window read "overdue" on the lock screen while the app, the web and
 * the reminders said "due". This guard keeps that class out of
 * `src/lib/push-relay/` and `src/lib/notifications/`: no numeric constant
 * there may be named for a due, overdue or missed window, or for a dose.
 *
 * Shape-based, so its matcher is held to non-zero counts: it must see the
 * directories' other numeric constants, and it must catch the declarations
 * it was written against.
 */
import { describe, expect, it } from "vitest";
import { readSourceFolder } from "./helpers/source-files";

const DIRS = ["src/lib/push-relay", "src/lib/notifications"];

/** `const NAME = <arithmetic on numeric literals>`, across line breaks. */
const NUMERIC_CONST =
  /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*number\s*)?=\s*([-+*/()\s\d_.]+?)\s*;/g;
/** A name that states a dose window: an underscore-delimited token. */
const DOSE_WINDOW_NAME = /(?:^|_)(DUE|OVERDUE|MISSED|DOSE)(?:_|$)/;

/** The directories' non-test TypeScript, as `[path, text]`. */
const files = DIRS.flatMap((dir) =>
  readSourceFolder(dir, {
    floor: 10,
    extensions: [".ts"],
    include: (rel) => !rel.includes("__tests__") && !rel.endsWith(".test.ts"),
  }).map(([rel, text]) => [`${dir}/${rel}`, text] as const),
);

function numericConstants(text: string): string[] {
  return [...text.matchAll(NUMERIC_CONST)]
    .filter((m) => /\d/.test(m[2]!))
    .map((m) => m[1]!);
}

describe("dose windows in push and notification code", () => {
  it("reads the directories and sees their numeric constants", () => {
    expect(files.length).toBeGreaterThan(20);
    const all = files.flatMap(([, text]) => numericConstants(text));
    // PASS_LIMIT, COALESCE_WINDOW_MS, ACTIVITY_LEAD_MS and many more.
    expect(all.length).toBeGreaterThan(30);
    expect(all).toContain("ACTIVITY_LEAD_MS");
  });

  it("catches the declarations it was written against", () => {
    const planted = [
      "const DUE_GRACE_MS = 30 * 60_000;",
      "const OVERDUE_MS = 3 * 3600_000;",
      "export const LIVE_ACTIVITY_OVERDUE_MS =\n  3 * 60 * 60 * 1000;",
      "const DOSE_MISSED_AFTER_MIN: number = 240;",
    ].join("\n");
    expect(
      numericConstants(planted).filter((n) => DOSE_WINDOW_NAME.test(n)),
    ).toEqual([
      "DUE_GRACE_MS",
      "OVERDUE_MS",
      "LIVE_ACTIVITY_OVERDUE_MS",
      "DOSE_MISSED_AFTER_MIN",
    ]);
    // Neighbours that merely look alike stay legal.
    expect(DOSE_WINDOW_NAME.test("UNDELIVERED_GRACE_MS")).toBe(false);
    expect(DOSE_WINDOW_NAME.test("ACTIVITY_LEAD_MS")).toBe(false);
  });

  it("declares none: the state comes from the dose-state resolver", () => {
    const offenders = files.flatMap(([path, text]) =>
      numericConstants(text)
        .filter((n) => DOSE_WINDOW_NAME.test(n))
        .map((n) => `${path}: ${n}`),
    );
    expect(offenders).toEqual([]);
  });
});
