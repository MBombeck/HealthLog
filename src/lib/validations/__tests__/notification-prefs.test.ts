import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFS,
  isMedicationReminderClientManaged,
  notificationPrefsSchema,
  parseNotificationPrefs,
  resolveNotificationPrefs,
} from "../notification-prefs";

/**
 * v1.4.49 M-DOUBLE-REMINDER — per-user notification preferences blob.
 *
 * The cron at `src/lib/jobs/reminder-worker.ts` reads
 * `user.notificationPrefs` and calls
 * `isMedicationReminderClientManaged` to decide whether to skip the
 * MEDICATION_REMINDER APNs dispatch. These tests pin the helper's
 * contract so the cron skip is deterministic across schema drift.
 */
describe("notificationPrefsSchema", () => {
  it("accepts an empty object (every key is optional)", () => {
    const out = notificationPrefsSchema.parse({});
    expect(out).toEqual({});
  });

  it("accepts the medication.clientManaged shape", () => {
    const input = { medication: { clientManaged: true } };
    const out = notificationPrefsSchema.parse(input);
    expect(out).toEqual(input);
  });

  it("rejects a non-boolean clientManaged", () => {
    const res = notificationPrefsSchema.safeParse({
      medication: { clientManaged: "yes" },
    });
    expect(res.success).toBe(false);
  });
});

describe("parseNotificationPrefs", () => {
  it("returns documented defaults for null", () => {
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("returns documented defaults for undefined", () => {
    expect(parseNotificationPrefs(undefined)).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });

  it("returns defaults when the persisted shape has drifted", () => {
    expect(parseNotificationPrefs({ unknown: "shape" })).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });

  it("returns the persisted shape when valid", () => {
    expect(
      parseNotificationPrefs({ medication: { clientManaged: true } }),
    ).toEqual({ medication: { clientManaged: true } });
  });

  it("fills missing keys from the defaults", () => {
    expect(parseNotificationPrefs({ medication: {} })).toEqual({
      medication: { clientManaged: false },
    });
  });
});

describe("resolveNotificationPrefs (deep-merge)", () => {
  it("layers the input over the persisted row", () => {
    const out = resolveNotificationPrefs(
      { medication: { clientManaged: false } },
      { medication: { clientManaged: true } },
    );
    expect(out).toEqual({ medication: { clientManaged: true } });
  });

  it("preserves the persisted medication keys when the input only touches new sub-keys", () => {
    // Future-proof: the route hands the merged shape to Prisma, so
    // sibling keys inside `medication` must survive a partial PATCH.
    const out = resolveNotificationPrefs(
      { medication: { clientManaged: true } },
      { medication: {} },
    );
    expect(out).toEqual({ medication: { clientManaged: true } });
  });

  it("falls back to defaults when the persisted row is null", () => {
    const out = resolveNotificationPrefs(null, {
      medication: { clientManaged: true },
    });
    expect(out).toEqual({ medication: { clientManaged: true } });
  });

  it("returns the defaults when neither side carries a value", () => {
    const out = resolveNotificationPrefs(null, {});
    expect(out).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });
});

describe("isMedicationReminderClientManaged — cron-skip gate", () => {
  it("returns false for a null row (legacy server-managed default)", () => {
    expect(isMedicationReminderClientManaged(null)).toBe(false);
  });

  it("returns false for undefined (Prisma findUnique miss)", () => {
    expect(isMedicationReminderClientManaged(undefined)).toBe(false);
  });

  it("returns false when the user has not opted in", () => {
    expect(
      isMedicationReminderClientManaged({
        medication: { clientManaged: false },
      }),
    ).toBe(false);
  });

  it("returns true when the user has opted in via the iOS app", () => {
    expect(
      isMedicationReminderClientManaged({
        medication: { clientManaged: true },
      }),
    ).toBe(true);
  });

  it("returns false for a drifted persisted shape (forward-compat)", () => {
    expect(
      isMedicationReminderClientManaged({ notACategory: { foo: "bar" } }),
    ).toBe(false);
  });

  it("returns false when only sibling categories are present", () => {
    // Future-proof: another (future) category set to true must NOT
    // gate MEDICATION_REMINDER — only `medication.clientManaged`
    // affects the medication cron.
    expect(
      isMedicationReminderClientManaged({
        // Cast through unknown — the production runtime sees this as
        // a JSONB value that bypasses the zod schema, but the helper
        // must still resolve to the safe default.
        otherCategory: { enabled: true },
      } as unknown),
    ).toBe(false);
  });
});
