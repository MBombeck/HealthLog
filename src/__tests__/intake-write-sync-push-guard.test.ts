/**
 * Structural guard: every write that changes what a device shows as due
 * tells the owner's devices, through the one seam `afterDoseChange`
 * (`lib/medications/after-dose-change.ts`).
 *
 * A web take queued the silent cross-device intake sync, so a running Live
 * Activity and the widgets reconciled. Telegram, the ingest hook and the
 * auto-miss cron wrote the same rows without it, and changes to the
 * medication itself (a dose time moved, a course ended, tracking off, a
 * deletion) sent nothing at all: the phone kept a dose as due that no longer
 * existed until it was opened. So both sets of writers are frozen here: a
 * file that writes `MedicationIntakeEvent` rows, or the medication, its
 * schedules, courses or schedule eras, calls `afterDoseChange`, or it is
 * listed below with the reason it may not. Nothing but the seam calls the
 * sync queue directly.
 *
 * Limits, stated plainly. The matcher is textual: a Prisma write on one of
 * the delegates (whitespace-tolerant, so a call split over two lines still
 * counts) or a call of the shared slot write. A write spelt as raw SQL is
 * invisible to it. It proves a file names the seam, not that every branch
 * reaches it; the behavioural tests beside each writer carry that half.
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

const PUSHES = /\b(?:afterDoseChange|afterMedicationChange)\s*\(/;

/** A write on the medication or what decides its doses. */
const MEDICATION_WRITE =
  /\b(?:medication|medicationSchedule|medicationCourse|medicationScheduleRevision)\s*\.\s*(?:update|updateMany|upsert|create|createMany|delete|deleteMany)\s*\(/;

/** The seam itself and the queue behind it. */
const SEAM = "lib/medications/after-dose-change.ts";
const QUEUE = "lib/notifications/medication-intake-sync.ts";

/** Writers that may not queue the push themselves, and why. */
const EXEMPT: Record<string, string> = {
  "lib/medications/scheduling/slot-upsert.ts":
    "the shared slot write; every caller calls the seam",
  "lib/medications/scheduling/slot-move.ts":
    "the locked by-id write; update-intake-status.ts and update-intake-event.ts call the seam",
  "lib/medications/update-intake-status/take.ts":
    "called by update-intake-status.ts, which calls the seam",
  "lib/medications/record-intake/write.ts":
    "called by record-intake.ts, which calls the seam",
  "lib/medications/intake-bulk/entry-write.ts":
    "called by intake-bulk/ingest.ts, which calls the seam",
  "lib/medications/ad-hoc-intake.ts":
    "the shared ad-hoc insert; every caller calls the seam",
  "lib/medications/inventory/consumption.ts":
    "stamps the stock consumption on a row, no dose state",
  "lib/medications/scheduling/project-today-intakes.ts":
    "mints pending slots inside the very read the client is making",
  "lib/jobs/reminder/medication-reminder-check.ts":
    "mints a pending row for a slot the reminder fires for, and clears snoozes that already ran out: the devices read the same instants",
  "lib/medications/course-end-placeholders.ts":
    "runs inside a course write of courses.ts, which calls the seam",
  "lib/medications/update-medication/write.ts":
    "called by update-medication.ts, which calls the seam",
  "lib/export/medications-restore.ts":
    "one pass of a whole-account restore; restore-backup.ts calls the seam once it commits",
};

/** Medication writers that may not call the seam themselves, and why. */
const MEDICATION_EXEMPT: Record<string, string> = {
  "lib/jobs/medication-low-stock.ts":
    "stamps the low-stock notice, nothing about a dose",
  "lib/medications/lifecycle.ts":
    "the one-shot active flip, called by intake writers that call the seam",
  "lib/medications/auto-take.ts":
    "moves the auto-take floor inside a medication write that calls the seam",
  "lib/medications/update-medication/write.ts":
    "called by update-medication.ts, which calls the seam",
  "lib/medications/record-intake/write.ts":
    "clears the snooze of the dose record-intake.ts records, which calls the seam",
  "lib/medications/update-intake-status/take.ts":
    "clears the snooze of the dose update-intake-status.ts records, which calls the seam",
  "lib/jobs/reminder/medication-reminder-check.ts":
    "clears snoozes that already ran out: the devices read the same instant",
  "lib/documents/commit.ts":
    "files an as-needed medication with no schedule: nothing turns due",
  "lib/import/fhir-bundle/records.ts":
    "files a medication record with no schedule rows: nothing turns due",
  "lib/export/medications-restore.ts":
    "one pass of a whole-account restore; restore-backup.ts calls the seam once it commits",
};

function source(file: string): string {
  return stripComments(readSourceText(join(SRC, file)));
}

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 }).filter(
    (file) => !/__tests__|\.test\.|^generated\//.test(file),
  );
}

function writers(): string[] {
  return sourceFiles().filter((file) => INTAKE_WRITE.test(source(file)));
}

describe("every intake writer tells the devices", () => {
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

describe("every medication writer tells the devices", () => {
  const found = sourceFiles().filter((file) =>
    MEDICATION_WRITE.test(source(file)),
  );

  it("finds the writers at all", () => {
    expect(found.length).toBeGreaterThan(10);
  });

  it("calls the seam, or says why not", () => {
    expect(
      found.filter(
        (file) => !(file in MEDICATION_EXEMPT) && !PUSHES.test(source(file)),
      ),
    ).toEqual([]);
  });

  it("lists no exemption that no longer writes", () => {
    expect(
      Object.keys(MEDICATION_EXEMPT).filter((f) => !found.includes(f)),
    ).toEqual([]);
  });
});

describe("the sync queue has one caller", () => {
  it("is called by the seam only", () => {
    const callers = sourceFiles().filter(
      (file) =>
        file !== QUEUE && /\bqueueMedicationIntakeSync\s*\(/.test(source(file)),
    );
    expect(callers).toEqual([SEAM]);
  });
});

/**
 * Every path that records a take or a skip a person made also sends the
 * visible confirmation (`MEDICATION_INTAKE_RECORDED`) to the owner's other
 * devices, by passing `recorded` to the sync push. The rest push the silent
 * sync only, and say why.
 */
const CONFIRMS: readonly string[] = [
  "lib/medications/record-intake/record-intake.ts",
  "lib/medications/update-intake-status/update-intake-status.ts",
  "lib/medications/intake-bulk/ingest.ts",
  "lib/telegram-dose-writes.ts",
  "app/api/ingest/medication/route.ts",
];

const SILENT_ONLY: Record<string, string> = {
  "app/api/medications/[id]/intake/purge/route.ts": "deletes history",
  "app/api/medications/[id]/intake/bulk-delete/route.ts": "deletes history",
  "lib/medications/delete-intake-event.ts": "an undo reopens the dose",
  "lib/medications/delete-intakes-by-external-ids.ts":
    "Apple Health removed its own records",
  "lib/medications/update-intake-event.ts":
    "a correction of a dose already recorded",
  "lib/jobs/medication-intake-import.ts": "a file import of past doses",
  "lib/jobs/intake-auto-skip.ts": "the auto-miss pass, no person's decision",
  "lib/jobs/intake-auto-take.ts": "the auto-take pass, no person's decision",
  "lib/medications/intake-slot-dedup.ts": "collapses duplicate rows of a slot",
  "lib/telegram-dose-snooze.ts": "a snooze records no take or skip",
  "lib/medications/courses.ts": "a course change, no dose recorded",
  "lib/medications/create-medication.ts": "a new medication",
  "lib/medications/delete-medication.ts": "a deleted medication",
  "lib/medications/update-medication/update-medication.ts":
    "a schedule, pause, course or tracking change",
  "lib/import/medications-csv.ts": "imported medications",
  "lib/export/restore-backup.ts": "a whole-account restore",
  "app/api/medications/[id]/schedule-revisions/route.ts":
    "an archived schedule era",
  "app/api/medications/[id]/schedule-revisions/[revisionId]/route.ts":
    "an archived schedule era",
};

const CONFIRMING_PUSH = /\bafterDoseChange\s*\(\s*\{[^}]*\brecorded\b/;

describe("every recorded take or skip is confirmed on the other devices", () => {
  const pushers = sourceFiles()
    .filter((file) => file !== SEAM)
    .filter((file) => PUSHES.test(source(file)));

  it("the confirming writers pass `recorded`", () => {
    expect(CONFIRMS.filter((f) => !CONFIRMING_PUSH.test(source(f)))).toEqual(
      [],
    );
  });

  it("every other pusher is listed with its reason", () => {
    expect(
      pushers.filter((f) => !CONFIRMS.includes(f) && !(f in SILENT_ONLY)),
    ).toEqual([]);
  });
});
