/**
 * Structural guard: every path that answers a dose wakes the owner's iOS
 * devices.
 *
 * A web take queues the silent cross-device intake sync
 * (`queueMedicationIntakeSync`), so a running Live Activity and the widgets
 * reconcile. Telegram, the ingest hook and the auto-miss cron wrote the same
 * rows without it, and the phone learned of those doses only on its next
 * successful load. So the set of intake writers is frozen here: a file that
 * writes `MedicationIntakeEvent` rows either queues the sync itself, or it is
 * listed below with the reason it may not.
 *
 * Limits, stated plainly. The matcher is textual: a Prisma write on the
 * `medicationIntakeEvent` delegate (whitespace-tolerant, so a call split over
 * two lines still counts) or a call of the shared slot write. A write spelt as
 * raw SQL is invisible to it. It proves a file names the push, not that every
 * branch reaches it; the behavioural tests beside each writer carry that half.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const INTAKE_WRITE =
  /\bmedicationIntakeEvent\s*\.\s*(?:update|updateMany|upsert|create|createMany)\s*\(|\bapplyCanonicalSlotWrite\s*\(/;

const PUSHES = /\bqueueMedicationIntakeSync\s*\(/;

/** Writers that may not queue the push themselves, and why. */
const EXEMPT: Record<string, string> = {
  "lib/medications/scheduling/slot-upsert.ts":
    "the shared slot write; every caller queues the push",
  "lib/medications/update-intake-status/take.ts":
    "called by update-intake-status.ts, which queues the push",
  "lib/medications/record-intake/write.ts":
    "called by record-intake.ts, which queues the push",
  "lib/medications/intake-bulk/entry-write.ts":
    "called by intake-bulk/ingest.ts, which queues the push",
  "lib/medications/inventory/consumption.ts":
    "stamps the stock consumption on a row, no dose state",
  "lib/medications/scheduling/project-today-intakes.ts":
    "mints pending slots inside the very read the client is making",
  "lib/jobs/reminder/medication-reminder-check.ts":
    "mints a pending row for a slot the reminder fires for, no answer",
  "lib/medications/intake-slot-dedup.ts":
    "tombstones duplicate rows of one slot; the surviving row keeps the state",
  "lib/medications/courses.ts":
    "drops open placeholders after a course edit, no answered dose",
  "lib/medications/course-end-placeholders.ts":
    "drops open placeholders after the course end, no answered dose",
  "lib/medications/update-medication/write.ts":
    "drops open placeholders on a schedule replace, no answered dose",
  "lib/export/medications-restore.ts":
    "a whole-account restore; paired clients resync from the delta feed",
};

function source(file: string): string {
  return stripComments(readSourceText(join(SRC, file)));
}

function writers(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((file) => !/__tests__|\.test\.|^generated\//.test(file))
    .filter((file) => INTAKE_WRITE.test(source(file)));
}

describe("every intake writer queues the cross-device sync", () => {
  const found = writers();

  it("finds the writers at all", () => {
    expect(found.length).toBeGreaterThan(10);
  });

  it("pushes, or says why not", () => {
    const silent = found.filter((file) => {
      if (file in EXEMPT) return false;
      return !PUSHES.test(source(file));
    });
    expect(silent).toEqual([]);
  });

  it("lists no exemption that no longer writes", () => {
    expect(Object.keys(EXEMPT).filter((f) => !found.includes(f))).toEqual([]);
  });
});
