/**
 * Structural guard — every reader of medication schedules honours the
 * per-medication intake-tracking switch (#1033).
 *
 * An as-needed medication is "never due, never reminded, never counted"
 * structurally: it carries no schedule rows, so every reader that expands
 * schedules into slots finds nothing to expand. A medication with intake
 * tracking off (`Medication.trackIntake = false`) keeps its schedule rows as a
 * record. Nothing about the rows themselves says "do not derive a due dose
 * from me", so the promise holds only as long as every reader asks. A new
 * reminder path, compliance surface or projection that reads `schedules` and
 * forgets the flag would quietly start reminding a person who asked not to be
 * reminded.
 *
 * So the set of schedule readers is frozen here. A file that reads medication
 * schedules through Prisma either uses the shared vocabulary in
 * `src/lib/medications/intake-tracking.ts` (or `expectsDoses`, whose required
 * `trackIntake` field makes the type checker enforce the same thing), or it is
 * on the allowlist below with the reason it may see every stored row.
 *
 * Limits, stated plainly. The matcher is textual: it finds a Prisma
 * `schedules: true` / `schedules: { … }` include or select and the
 * `medicationSchedule.find*` delegates. A schedule read spelt some other way
 * (raw SQL on `medication_schedules`, a helper that returns rows it read
 * elsewhere) is invisible to it. It proves a file names the vocabulary, not
 * that the named helper is applied to the right query. The behavioural tests
 * beside each consumer carry that half.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** A Prisma read (or write payload) that touches medication schedule rows. */
const SCHEDULE_READ =
  /\bschedules\s*:\s*(?:true\b|\{)|\bmedicationSchedule\s*\.\s*find(?:Many|First|Unique)\b/;

/** The vocabulary that honours the switch. */
const HONOURS =
  /\b(?:TRACKED_INTAKE_WHERE|TRACKED_INTAKE_EVENT_WHERE|dueSchedules|scheduleWireFields|expectsDoses)\b/;

/**
 * Readers that may see every stored schedule row, and why. Each reason says
 * why no due dose, reminder or adherence figure can come out of the file.
 */
const MAY_READ_EVERY_ROW: Record<string, string> = {
  // Record-keeping: a backup, a restore and an export carry the medication
  // as stored, schedule and switch included.
  "lib/export/full-backup-payload.ts": "backup carries the stored rows",
  "lib/export/restore-backup.ts": "restore writes the stored rows back",
  "app/api/export/route.ts": "data export of the stored record",
  "app/api/export/medications/route.ts": "medication CSV export of the record",
  // Intake WRITE helpers: they run only when a dose is being recorded, bind
  // it to the slot it belongs to and consume stock. They derive nothing due.
  "lib/medications/scheduling/slot-upsert.ts":
    "binds a recorded dose to its slot",
  "lib/medications/inventory/consumption.ts":
    "units consumed by a recorded dose",
  "lib/medications/intake-slot-dedup.ts":
    "folds duplicate rows of doses already recorded",
  // Readers that hand the rows to a builder whose input TYPE requires
  // `trackIntake` and which gates on it: the per-medication compliance
  // payload (`buildCompliancePayload`, INTAKE_NOT_TRACKED) and the doctor
  // report's ledger compliance (`expectsDoses`). The report's medication
  // list shows the stored schedule as information.
  "app/api/medications/[id]/compliance/route.ts":
    "buildCompliancePayload gates on the type-required trackIntake",
  "lib/doctor-report/collect.ts":
    "buildLedgerCompliance gates via expectsDoses; list is information",
  // The MCP medication resources list the stored schedule as information,
  // with `intakeTracked` beside it; they carry no due time or rate.
  "lib/mcp/resources.ts":
    "schedule as information, intakeTracked flag beside it",
  // The Coach's GLP-1 block reads the stored cadence as information and
  // gates its next-injection prediction on the flag inline.
  "lib/ai/coach/glp1-snapshot.ts":
    "cadence as information; prediction gated on trackIntake",
};

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

/** Drop line and block comments so a mention in prose never counts. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function code(rel: string): string {
  return stripComments(readFileSync(join(SRC, rel), "utf8"));
}

const readers = sourceFiles().filter((rel) => SCHEDULE_READ.test(code(rel)));

describe("medication intake tracking — schedule readers honour the switch", () => {
  it("finds the schedule readers it exists to police", () => {
    // An empty match set would agree with any allowlist. Pin the floor and
    // the readers whose silence would matter most.
    expect(readers.length).toBeGreaterThanOrEqual(30);
    for (const known of [
      "lib/jobs/reminder/medication-reminder-check.ts",
      "lib/medications/scheduling/project-today-intakes.ts",
      "lib/dashboard/meds-today.ts",
      "lib/medications/list-read.ts",
      "lib/jobs/intake-auto-skip.ts",
    ]) {
      expect(readers).toContain(known);
    }
  });

  it("every schedule reader uses the vocabulary or is allowlisted", () => {
    const offenders = readers.filter(
      (rel) => !(rel in MAY_READ_EVERY_ROW) && !HONOURS.test(code(rel)),
    );
    expect(
      offenders,
      "These files read medication schedules without honouring " +
        "Medication.trackIntake. Filter with TRACKED_INTAKE_WHERE, derive " +
        "from dueSchedules(), shape the wire with scheduleWireFields(), or " +
        "add the file to MAY_READ_EVERY_ROW with the reason it derives " +
        "nothing due.",
    ).toEqual([]);
  });

  it("the allowlist names no file that stopped reading schedules", () => {
    const stale = Object.keys(MAY_READ_EVERY_ROW).filter(
      (rel) => !readers.includes(rel),
    );
    expect(stale).toEqual([]);
  });

  it("the matchers catch the shapes they claim to", () => {
    // Defeat check: the guard must be able to fail.
    expect(SCHEDULE_READ.test("include: { schedules: true }")).toBe(true);
    expect(SCHEDULE_READ.test("schedules: {\n select: X }")).toBe(true);
    expect(
      SCHEDULE_READ.test("prisma.medicationSchedule\n  .findMany({})"),
    ).toBe(true);
    expect(SCHEDULE_READ.test("const schedules = m.schedules;")).toBe(false);
    expect(HONOURS.test(stripComments("// dueSchedules(m)"))).toBe(false);
    expect(HONOURS.test("where: { ...TRACKED_INTAKE_WHERE }")).toBe(true);
  });
});
