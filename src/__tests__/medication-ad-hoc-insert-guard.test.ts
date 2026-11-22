/**
 * Structural guard: an intake row is created by a slot writer or by the one
 * ad-hoc insert, nowhere else.
 *
 * An ad-hoc dose is anchored on its own instant (`scheduledFor = takenAt`),
 * and since migration 0515 one live row holds an instant per medication. Four
 * writers created their ad-hoc rows by hand: the per-medication route, the
 * bulk route, the ingest hook and the Telegram buttons. An extra dose logged
 * on the exact minute of a slot answered 500 on the first, `duplicate` without
 * an id on the second (the dose was gone), and rolled back on every Telegram
 * redelivery. `createAdHocIntake` (`src/lib/medications/ad-hoc-intake.ts`)
 * moves the row to the next free millisecond, and this test holds every
 * `medicationIntakeEvent.create(` outside it to the slot writers below, each
 * of which aims at a slot instant on purpose and answers its own conflict.
 *
 * The matcher is textual and whitespace-tolerant. A create spelt through a
 * different delegate name or raw SQL is invisible to it; `createMany` (the
 * projector, restore and import, which write slot or archive rows in bulk) is
 * out of its scope.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanSourceMatches } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

const CREATE = /\bmedicationIntakeEvent\s*\.\s*create\s*\(/g;

/** Files that may create an intake row directly, and why. */
const SLOT_WRITERS: Record<string, string> = {
  "lib/medications/ad-hoc-intake.ts": "the ad-hoc insert itself",
  "lib/medications/scheduling/slot-upsert.ts":
    "the canonical slot write: re-finds and converges on a slot conflict",
  "lib/jobs/intake-auto-take.ts":
    "an automatic take on its slot instant; a conflict is the next pass's",
  "lib/jobs/reminder/medication-reminder-check.ts":
    "the missed-dose row on its slot instant, minted only when the slot is free",
};

/** The writers that record ad-hoc doses, each through the shared insert. */
const AD_HOC_WRITERS = [
  "lib/medications/record-intake/write.ts",
  "lib/medications/intake-bulk/entry-write.ts",
  "app/api/ingest/medication/route.ts",
  "lib/telegram-dose-writes.ts",
];

describe("intake rows are created by a slot writer or the ad-hoc insert", () => {
  const matches = scanSourceMatches(SRC, CREATE, {
    fileFloor: 1000,
    matchFloor: 4,
    stripComments: true,
    include: (rel) =>
      !rel.includes("__tests__") && !rel.startsWith("generated/"),
  });

  it("no other file creates an intake row by hand", () => {
    const offenders = matches
      .filter((m) => !(m.file in SLOT_WRITERS))
      .map((m) => `${m.file}:${m.line}`);
    expect(offenders).toEqual([]);
  });

  it("every allowed slot writer still creates one (the list is not stale)", () => {
    const files = new Set(matches.map((m) => m.file));
    expect(Object.keys(SLOT_WRITERS).filter((f) => !files.has(f))).toEqual([]);
  });

  it("every ad-hoc writer goes through createAdHocIntake", () => {
    const calls = scanSourceMatches(SRC, /\bcreateAdHocIntake\s*\(/g, {
      fileFloor: AD_HOC_WRITERS.length,
      matchFloor: AD_HOC_WRITERS.length,
      stripComments: true,
      include: (rel) => AD_HOC_WRITERS.includes(rel),
    });
    const files = new Set(calls.map((m) => m.file));
    expect(AD_HOC_WRITERS.filter((f) => !files.has(f))).toEqual([]);
  });
});
