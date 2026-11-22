/**
 * Structural guard: the state of a dose is resolved in one place.
 *
 * `src/lib/medications/dose-state/resolve.ts` turns a slot's band (from the
 * shared band minter) and what is recorded on it into pending / due /
 * overdue / missed / taken / taken late / skipped. Every surface that shows
 * that state reads it from there: the today list, `currentDose`, the card
 * pill, the Telegram keyboard, the MCP schedule tool. A surface that re-derives
 * it from its own window arithmetic drifts from the others, which is how the
 * phone, the web and Telegram came to disagree about one dose.
 *
 * So the set of files that touch the window arithmetic is frozen here: the
 * band fields (`onTimeEnd`, `overdueEnd`), the default window constants and
 * the client late/missed minute thresholds. A file on the list says why it may;
 * a new file that reaches for them is a re-implementation and fails, and
 * should read `resolveDoseState` / `resolveLedgerSlot` instead.
 *
 * Limits, stated plainly. The matcher is textual and finds the names, not
 * every way to spell a window; it proves a file names the arithmetic, not that
 * a listed file uses it only for its stated reason. The card, the table, the
 * take-all sweep and the intake pickers read the server's resolved dose
 * (`dose-state/pill.ts`); the browser fallback they once kept is gone.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const WINDOW_ARITHMETIC =
  /\b(?:onTimeEnd|overdueEnd|dailyOnTimeMinutes|dailyOverdueMinutes|weeklyOnTimeDays|weeklyOverdueDays|lateMinutes|missedMinutes)\b/;

const MAY_TOUCH_WINDOWS: Record<string, string> = {
  // The resolver and the engine it reads.
  "lib/medications/dose-state/resolve.ts": "the resolver",
  "lib/medications/scheduling/attribution.ts": "mints the band fields",
  "lib/medications/scheduling/band-minter.ts": "mints the bands",
  "lib/medications/scheduling/attribute-intake.ts":
    "binds a take to a band (write side)",
  "lib/medications/scheduling/dose-history.ts":
    "the ledger: attributes takes to bands, which the resolver reads",
  "lib/medications/scheduling/dose-window-defaults.ts":
    "the default window constants",
  "lib/medications/scheduling/worker-helpers.ts":
    "reminder phase windows of the worker",
  "lib/analytics/compliance/dose-status.ts":
    "the default band of a dose the ledger has not minted, resolved by the resolver",
  // Write and job paths: they decide what to record, not what to show.
  "lib/medications/auto-take.ts": "which slots the auto-take records",
  "lib/medications/intake-slot-dedup.ts": "which duplicate rows merge",
  "lib/jobs/intake-auto-skip.ts": "when the auto-miss pass closes a slot",
  "lib/medications/scheduling/next-due.ts":
    "which slot is the next due one (the resolver then states it)",
  // Settings: the configured thresholds themselves.
  "lib/app-settings.ts": "stores the configured thresholds",
  "lib/analytics/compliance/parsing.ts": "parses the configured thresholds",
  "app/api/admin/notifications/reminder-check/route.ts":
    "admin diagnostic of the reminder worker",
  "lib/openapi/routes/settings.ts": "documents the thresholds",
  "lib/openapi/routes/medications/schemas.ts": "documents the windows",
  "components/medications/scheduling/dose-window.ts":
    "the schedule editor's window preview",
  "lib/medications/scheduling/dose-window-plan.ts":
    "the wizard's plain-words window plan, read off the band minter",
  "lib/daily/digest.ts": "the digest's due-soon horizon",
  "components/medications/sections/inventory-section.tsx":
    "passes the thresholds to the card it renders",
};

function files(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((file) => !/__tests__|\.test\.|^generated\//.test(file))
    .filter((file) =>
      WINDOW_ARITHMETIC.test(stripComments(readSourceText(join(SRC, file)))),
    );
}

describe("dose state is resolved in one place", () => {
  const found = files();

  it("finds the window arithmetic at all", () => {
    expect(found.length).toBeGreaterThan(10);
  });

  it("no new file re-derives a dose's state", () => {
    expect(found.filter((f) => !(f in MAY_TOUCH_WINDOWS))).toEqual([]);
  });

  it("lists no file that no longer touches the windows", () => {
    expect(
      Object.keys(MAY_TOUCH_WINDOWS).filter((f) => !found.includes(f)),
    ).toEqual([]);
  });
});
