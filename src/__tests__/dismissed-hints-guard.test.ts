/**
 * One-time hints are dismissed on the account, never in browser storage.
 *
 * A dismissal kept in local storage forgot itself on every other device and
 * whenever the browser evicted the site's storage, so the timeline's
 * readiness card, the AI setup hint and their siblings came back after being
 * closed. They now all go through `useDismissedHints`
 * (`src/lib/hints/dismissible-hints.ts`).
 *
 * The guard: no storage key named for a dismissal (`healthlog…dismiss…`)
 * appears anywhere in `src/` outside the files listed below, each with its
 * reason; and every registered hint family has a reader.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { DISMISSIBLE_HINTS } from "@/lib/hints/dismissible-hints";

const ROOT = join(process.cwd(), "src");

const ALLOWED: Record<string, string> = {
  "lib/hints/legacy-dismissals.ts":
    "reads the keys hints were dismissed under before the move, once, to carry them to the account",
  "lib/onboarding/checklist-storage.ts":
    "names the checklist's former keys for the carry-over; writes only the open state",
  "components/onboarding/tour-launcher.tsx":
    "session storage: the tour put away for this tab only; finishing it is on the account (onboardingTourCompleted)",
  "components/admin/backups/use-backup-restores.ts":
    "an operator's finished restore panels, one per run; status, not a hint",
};

/** Files whose only dismissal keys are the former ones: never written. */
const LEGACY_ONLY = [
  "lib/hints/legacy-dismissals.ts",
  "lib/onboarding/checklist-storage.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "__tests__" || name === "generated") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(ROOT).map((full) => ({
  path: relative(ROOT, full),
  text: readFileSync(full, "utf8"),
}));

const DISMISSAL_KEY = /["'`]healthlog[^"'`\n]*dismiss/i;

describe("dismissed hints live on the account", () => {
  it("finds the files it is meant to look at", () => {
    expect(FILES.length).toBeGreaterThan(500);
    // The matcher is not empty: the allowed files do carry such keys.
    expect(
      FILES.filter((f) => DISMISSAL_KEY.test(f.text)).length,
    ).toBeGreaterThan(0);
  });

  it("no storage key for a dismissal outside the listed files", () => {
    const offenders = FILES.filter(
      (f) => DISMISSAL_KEY.test(f.text) && !(f.path in ALLOWED),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("the former keys are only read and removed, never written", () => {
    for (const path of LEGACY_ONLY) {
      const file = FILES.find((f) => f.path === path);
      expect(file, path).toBeDefined();
      const writes = [
        ...file!.text.matchAll(/(?:setItem|useDevicePreference)\(\s*([^,)]*)/g),
      ].map((m) => m[1]);
      expect(
        writes.filter((arg) => /dismiss/i.test(arg)),
        path,
      ).toEqual([]);
    }
    // And nothing anywhere persists through the former names.
    for (const f of FILES) {
      expect(
        /(?:setItem|useDevicePreference)\(\s*(?:READINESS_CARD_DISMISSED_KEY|CHECKLIST_DISMISSED_\w+|DISMISSED_\w+_KEY)/.test(
          f.text,
        ) && !(f.path in ALLOWED),
        f.path,
      ).toBe(false);
    }
  });

  it.each(DISMISSIBLE_HINTS)("hint %s has a reader", (family) => {
    const reader = new RegExp(`(?:isDismissed|hintId)\\(\\s*"${family}"`);
    const readers = FILES.filter(
      (f) => f.path.startsWith("components/") && reader.test(f.text),
    );
    expect(readers.length).toBeGreaterThan(0);
  });
});
