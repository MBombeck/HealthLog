/**
 * Query-count probe: resolving the dose state of many medications costs a
 * fixed number of database round trips, whatever the number of medications.
 *
 * The today list used to read each medication's dose ledger one after the
 * other: two queries per medication, awaited in a loop, so fifteen
 * medications cost thirty-one queries in sixteen consecutive waves before
 * the response could leave. Every query is counted here, and so is every
 * wave (a query issued after an earlier one had to finish first).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ op: string; wave: number }> = [];
let wave = 0;
let inFlight = 0;

function counted<T>(op: string, value: () => T) {
  return vi.fn(async () => {
    // A query that starts while none is in flight starts a new wave.
    if (inFlight === 0) wave += 1;
    inFlight += 1;
    calls.push({ op, wave });
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return value();
  });
}

let medications: unknown[] = [];

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: counted("medication.findMany", () => medications) },
    medicationIntakeEvent: {
      findMany: counted("intake.findMany", () => []),
      findFirst: counted("intake.findFirst", () => null),
    },
    $queryRaw: counted("$queryRaw", () => []),
  },
}));

import { resolveDosesAt, resolveDosesByRow } from "../today";

function medicationsOf(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `med-${i}`,
    userId: "user-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    startsOn: null,
    endsOn: null,
    endedAt: null,
    oneShot: false,
    trackIntake: true,
    asNeeded: false,
    schedules: [],
    scheduleRevisions: [],
    courses: [],
  }));
}

beforeEach(() => {
  calls.length = 0;
  wave = 0;
  inFlight = 0;
});

const now = new Date("2026-11-22T10:00:00Z");

describe("dose state of many medications", () => {
  it.each([5, 15, 30])(
    "resolveDosesByRow reads %i medications in three queries and two waves",
    async (count) => {
      medications = medicationsOf(count);
      await resolveDosesByRow({
        userId: "user-1",
        userTz: "Europe/Berlin",
        medications: medications.map((m) => (m as { id: string }).id),
        takenViaByRow: new Map(),
        from: new Date("2026-11-21T23:00:00Z"),
        to: new Date("2026-11-22T23:00:00Z"),
        now,
      });
      expect(calls.length).toBe(3);
      expect(wave).toBe(2);
      expect(calls.some((c) => c.op === "intake.findFirst")).toBe(false);
    },
  );

  it.each([5, 15, 30])(
    "resolveDosesAt reads %i medications in three queries and two waves",
    async (count) => {
      medications = medicationsOf(count);
      await resolveDosesAt({
        userId: "user-1",
        userTz: "Europe/Berlin",
        at: new Map(
          medications.map((m, i) => [
            (m as { id: string }).id,
            new Date(now.getTime() + i * 60_000),
          ]),
        ),
        now,
      });
      expect(calls.length).toBe(3);
      expect(wave).toBe(2);
    },
  );
});
