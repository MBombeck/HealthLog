/**
 * v1.42.2 — `sendsMedicationReminders` is the one reminder decision: the
 * worker and the admin check gate on it, the read paths publish it as
 * `remindersActive`. Pins the truth table and that every site calls it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sendsMedicationReminders } from "../auto-mark-taken";

describe("sendsMedicationReminders", () => {
  const at = {
    now: new Date("2026-06-10T10:00:00.000Z"),
    timeZone: "Europe/Berlin",
  };

  it("reminds only for an active, tracked, scheduled medication with reminders on, no auto-recording and a course not ended", () => {
    for (let bits = 0; bits < 64; bits++) {
      const ended = (bits & 32) !== 0;
      const med = {
        notificationsEnabled: (bits & 1) !== 0,
        autoMarkTaken: (bits & 2) !== 0,
        active: (bits & 4) !== 0,
        trackIntake: (bits & 8) !== 0,
        asNeeded: (bits & 16) !== 0,
        endsOn: ended ? new Date("2026-06-09T00:00:00.000Z") : null,
        endedAt: null,
      };
      expect(sendsMedicationReminders(med, at), JSON.stringify(med)).toBe(
        med.notificationsEnabled &&
          !med.autoMarkTaken &&
          med.active &&
          med.trackIntake &&
          !med.asNeeded &&
          !ended,
      );
    }
  });

  it("a course ending today still reminds; one that ended yesterday does not", () => {
    const base = {
      notificationsEnabled: true,
      autoMarkTaken: false,
      active: true,
      trackIntake: true,
      asNeeded: false,
      endedAt: null,
    };
    expect(
      sendsMedicationReminders(
        { ...base, endsOn: new Date("2026-06-10T00:00:00.000Z") },
        at,
      ),
    ).toBe(true);
    expect(
      sendsMedicationReminders(
        { ...base, endsOn: new Date("2026-06-09T00:00:00.000Z") },
        at,
      ),
    ).toBe(false);
    // Late on the 10th in Berlin is already the 11th there.
    expect(
      sendsMedicationReminders(
        { ...base, endsOn: new Date("2026-06-10T00:00:00.000Z") },
        { ...at, now: new Date("2026-06-10T22:30:00.000Z") },
      ),
    ).toBe(false);
  });

  it("stops at the instant End course ended the course (#1280)", () => {
    const med = {
      notificationsEnabled: true,
      autoMarkTaken: false,
      active: true,
      trackIntake: true,
      asNeeded: false,
      endsOn: new Date("2026-06-10T00:00:00.000Z"),
      endedAt: new Date("2026-06-10T09:00:00.000Z"),
    };
    // 10:00Z is after the instant: no reminder for the rest of the day,
    // follow-ups of an earlier dose included.
    expect(sendsMedicationReminders(med, at)).toBe(false);
    expect(
      sendsMedicationReminders(med, {
        ...at,
        now: new Date("2026-06-10T08:59:00.000Z"),
      }),
    ).toBe(true);
    // The same last day without the instant reminds all day.
    expect(sendsMedicationReminders({ ...med, endedAt: null }, at)).toBe(true);
  });

  it("is the decision at every gate and on every published DTO", () => {
    const src = (rel: string) =>
      readFileSync(join(process.cwd(), "src", rel), "utf8");
    for (const gate of [
      "lib/jobs/reminder/medication-reminder-check.ts",
      "app/api/admin/notifications/reminder-check/route.ts",
    ]) {
      expect(src(gate), gate).toMatch(
        /sendsMedicationReminders\(med, \{ now, timeZone: userTz \}\)/,
      );
      // No send site falls back to the raw preference.
      expect(src(gate), gate).not.toMatch(
        /if \([^)]*med\.notificationsEnabled\)/,
      );
    }
    for (const dto of [
      "lib/medications/list-read.ts",
      "lib/medications/read-medication.ts",
    ]) {
      expect(src(dto), dto).toMatch(
        /remindersActive:\s*sendsMedicationReminders\(/,
      );
    }
  });
});
