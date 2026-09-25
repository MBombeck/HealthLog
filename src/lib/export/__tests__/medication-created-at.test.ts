/**
 * A medication restored from a file without `createdAt` is dated by the
 * earliest thing the file says happened to it, never later than the restore.
 *
 * Mutation check: return `undefined` whenever the file has no `createdAt`
 * (the old behaviour) and the evidence cases go red; drop the cap at `now`
 * and the future-course case goes red.
 */
import { describe, expect, it } from "vitest";

import { restoredMedicationCreatedAt } from "@/lib/export/medication-created-at";
import { backupPayloadSchema } from "@/lib/validations/backup";

const NOW = new Date("2026-09-25T12:00:00.000Z");

function parse(
  medication: Record<string, unknown>,
  intakeEvents: unknown[] = [],
) {
  const payload = backupPayloadSchema.parse({
    schemaVersion: "1",
    exportedAt: "2026-09-20T00:00:00.000Z",
    userId: "user-1",
    medications: [
      { name: "Ramipril", dose: "5mg", schedules: [], ...medication },
    ],
    intakeEvents,
  });
  return {
    medication: payload.medications[0]!,
    intakeEvents: payload.intakeEvents,
  };
}

describe("restoredMedicationCreatedAt", () => {
  it("keeps the file's own creation date", () => {
    const { medication, intakeEvents } = parse({
      createdAt: "2024-01-02T00:00:00.000Z",
    });
    expect(restoredMedicationCreatedAt(medication, intakeEvents, NOW)).toEqual(
      new Date("2024-01-02T00:00:00.000Z"),
    );
  });

  it("takes the earliest dose of the medication when the file has no date", () => {
    const { medication, intakeEvents } = parse({}, [
      {
        medication: "Ramipril",
        scheduledFor: "2025-03-10T08:00:00.000Z",
        takenAt: "2025-03-10T08:05:00.000Z",
      },
      {
        medication: "Ramipril",
        scheduledFor: "2025-03-09T08:00:00.000Z",
        autoMissed: true,
      },
      // Another medication's dose is not evidence for this one.
      { medication: "Other", scheduledFor: "2020-01-01T08:00:00.000Z" },
    ]);
    expect(restoredMedicationCreatedAt(medication, intakeEvents, NOW)).toEqual(
      new Date("2025-03-09T08:00:00.000Z"),
    );
  });

  it("takes an earlier schedule revision or course start over the doses", () => {
    const { medication, intakeEvents } = parse(
      {
        startsOn: "2025-02-01T00:00:00.000Z",
        scheduleRevisions: [
          {
            validFrom: "2025-01-15T00:00:00.000Z",
            validUntil: "2025-02-01T00:00:00.000Z",
            payload: {},
          },
        ],
      },
      [{ medication: "Ramipril", scheduledFor: "2025-03-09T08:00:00.000Z" }],
    );
    expect(restoredMedicationCreatedAt(medication, intakeEvents, NOW)).toEqual(
      new Date("2025-01-15T00:00:00.000Z"),
    );
  });

  it("is never later than the restore", () => {
    const { medication, intakeEvents } = parse({
      startsOn: "2026-10-01T00:00:00.000Z",
    });
    expect(restoredMedicationCreatedAt(medication, intakeEvents, NOW)).toEqual(
      NOW,
    );
  });

  it("leaves the default when the file says nothing about the medication", () => {
    const { medication, intakeEvents } = parse({});
    expect(
      restoredMedicationCreatedAt(medication, intakeEvents, NOW),
    ).toBeUndefined();
  });
});
