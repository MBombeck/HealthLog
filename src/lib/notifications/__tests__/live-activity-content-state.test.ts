/**
 * The content-state the server ends a medication Live Activity with must
 * decode in the iOS app. The app's decoder is synthesised, so a missing
 * required key fails the whole push; the fixture lists the struct's fields.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import contract from "./fixtures/medication-live-activity-content-state.json";
import {
  appleReferenceSeconds,
  endedMedicationContentState,
} from "../live-activity-content-state";

type Field = { type: string; enum?: string[] };

function matches(value: unknown, field: Field): boolean {
  if (field.type === "appleDate") return typeof value === "number";
  if (typeof value !== field.type) return false;
  return !field.enum || field.enum.includes(value as string);
}

describe("medication Live Activity content-state", () => {
  const state = endedMedicationContentState({
    resolvedAt: new Date("2026-11-21T09:10:00.000Z"),
    timeFormat: "H24",
  }) as unknown as Record<string, unknown>;
  const required = contract.required as Record<string, Field>;
  const optional = contract.optional as Record<string, Field>;

  it("carries every field the app requires, typed as it decodes them", () => {
    for (const [key, field] of Object.entries(required)) {
      expect(key in state, key).toBe(true);
      expect(matches(state[key], field), key).toBe(true);
    }
  });

  it("carries no field the app does not know", () => {
    const known = new Set([...Object.keys(required), ...Object.keys(optional)]);
    expect(Object.keys(state).filter((k) => !known.has(k))).toEqual([]);
  });

  it("writes dates as seconds since Foundation's reference date", () => {
    expect(appleReferenceSeconds(new Date("2001-01-01T00:00:00.000Z"))).toBe(0);
    expect(state.countdownTarget).toBe(
      (Date.parse("2026-11-21T09:10:00.000Z") -
        Date.parse("2001-01-01T00:00:00.000Z")) /
        1000,
    );
  });

  it("falls back to the device's own hour cycle without a preference", () => {
    expect(
      endedMedicationContentState({ resolvedAt: new Date(), timeFormat: null })
        .timeFormatRaw,
    ).toBe("AUTO");
  });
});

/**
 * The app's own fixture of content-state cases (shared by the iOS team),
 * dropped at `fixtures/app-medication-content-state.json`: every case the
 * app decodes as valid must carry the same keys as the state the server
 * builds. Skipped until the file is in the repository.
 */
const APP_FIXTURE = join(
  __dirname,
  "fixtures",
  "app-medication-content-state.json",
);

describe("the app's content-state fixture", () => {
  it.skipIf(!existsSync(APP_FIXTURE))(
    "the server's end state has the keys of the app's full case",
    () => {
      const cases = JSON.parse(readFileSync(APP_FIXTURE, "utf8")) as Record<
        string,
        unknown
      >;
      const full = (cases.full ?? cases.cases) as Record<string, unknown>;
      expect(full).toBeTruthy();
      const built = endedMedicationContentState({
        resolvedAt: new Date("2026-11-21T09:10:00.000Z"),
        timeFormat: "H24",
      }) as unknown as Record<string, unknown>;
      const required = Object.keys(full).filter(
        (k) => k !== "pendingConfirmStartedAt",
      );
      for (const key of required) expect(key in built, key).toBe(true);
    },
  );
});
