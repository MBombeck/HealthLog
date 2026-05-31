import { describe, expect, it } from "vitest";

import {
  DEFAULT_MOOD_REMINDER_HOUR,
  DEFAULT_NOTIFICATION_PREFS,
  isMedicationReminderClientManaged,
  notificationPrefsSchema,
  parseNotificationPrefs,
  resolveDeviceDelivery,
  resolveMoodReminderHour,
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

  it("accepts a valid mood.reminderHour (0..23)", () => {
    expect(notificationPrefsSchema.safeParse({ mood: { reminderHour: 0 } }).success).toBe(
      true,
    );
    expect(
      notificationPrefsSchema.safeParse({ mood: { reminderHour: 23 } }).success,
    ).toBe(true);
  });

  it("rejects a mood.reminderHour outside 0..23", () => {
    expect(
      notificationPrefsSchema.safeParse({ mood: { reminderHour: 24 } }).success,
    ).toBe(false);
    expect(
      notificationPrefsSchema.safeParse({ mood: { reminderHour: -1 } }).success,
    ).toBe(false);
  });

  it("rejects a non-integer mood.reminderHour", () => {
    expect(
      notificationPrefsSchema.safeParse({ mood: { reminderHour: 9.5 } }).success,
    ).toBe(false);
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
    // v1.7.0 — the resolved shape now carries the roaming
    // `deliveryDefault` (defaulted to "server" when the row omits it).
    expect(
      parseNotificationPrefs({ medication: { clientManaged: true } }),
    ).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: DEFAULT_MOOD_REMINDER_HOUR },
    });
  });

  it("fills missing keys from the defaults", () => {
    expect(parseNotificationPrefs({ medication: {} })).toEqual({
      medication: { clientManaged: false, deliveryDefault: "server" },
      mood: { reminderHour: DEFAULT_MOOD_REMINDER_HOUR },
    });
  });

  it("v1.7.0 — deliveryDefault 'client' maps onto clientManaged true", () => {
    expect(
      parseNotificationPrefs({ medication: { deliveryDefault: "client" } }),
    ).toEqual({
      medication: { clientManaged: true, deliveryDefault: "client" },
      mood: { reminderHour: DEFAULT_MOOD_REMINDER_HOUR },
    });
  });

  it("v1.7.0 — persists a custom mood.reminderHour", () => {
    expect(parseNotificationPrefs({ mood: { reminderHour: 9 } }).mood).toEqual({
      reminderHour: 9,
    });
  });

  it("v1.7.0 — falls back to the default hour when mood is absent", () => {
    expect(parseNotificationPrefs(null).mood.reminderHour).toBe(
      DEFAULT_MOOD_REMINDER_HOUR,
    );
  });
});

describe("resolveNotificationPrefs (deep-merge)", () => {
  it("layers the input over the persisted row", () => {
    const out = resolveNotificationPrefs(
      { medication: { clientManaged: false } },
      { medication: { clientManaged: true } },
    );
    expect(out).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: DEFAULT_MOOD_REMINDER_HOUR },
    });
  });

  it("preserves the persisted medication keys when the input only touches new sub-keys", () => {
    // Future-proof: the route hands the merged shape to Prisma, so
    // sibling keys inside `medication` must survive a partial PATCH.
    const out = resolveNotificationPrefs(
      { medication: { clientManaged: true } },
      { medication: {} },
    );
    expect(out).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: DEFAULT_MOOD_REMINDER_HOUR },
    });
  });

  it("falls back to defaults when the persisted row is null", () => {
    const out = resolveNotificationPrefs(null, {
      medication: { clientManaged: true },
    });
    expect(out).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: DEFAULT_MOOD_REMINDER_HOUR },
    });
  });

  it("v1.7.0 — PATCHing deliveryDefault 'client' roams + maps to clientManaged", () => {
    const out = resolveNotificationPrefs(null, {
      medication: { deliveryDefault: "client" },
    });
    expect(out).toEqual({
      medication: { clientManaged: true, deliveryDefault: "client" },
      mood: { reminderHour: DEFAULT_MOOD_REMINDER_HOUR },
    });
  });

  it("v1.7.0 — PATCHing mood.reminderHour preserves medication siblings", () => {
    const out = resolveNotificationPrefs(
      { medication: { clientManaged: true } },
      { mood: { reminderHour: 8 } },
    );
    expect(out).toEqual({
      medication: { clientManaged: true, deliveryDefault: "server" },
      mood: { reminderHour: 8 },
    });
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

  it("v1.7.0 — returns true when deliveryDefault is 'client'", () => {
    expect(
      isMedicationReminderClientManaged({
        medication: { deliveryDefault: "client" },
      }),
    ).toBe(true);
  });
});

describe("resolveMoodReminderHour — cron hour gate", () => {
  it("returns the default hour for a null row", () => {
    expect(resolveMoodReminderHour(null)).toBe(DEFAULT_MOOD_REMINDER_HOUR);
  });

  it("returns the default hour for undefined", () => {
    expect(resolveMoodReminderHour(undefined)).toBe(DEFAULT_MOOD_REMINDER_HOUR);
  });

  it("returns the default hour for a drifted shape", () => {
    expect(resolveMoodReminderHour({ unknown: "shape" })).toBe(
      DEFAULT_MOOD_REMINDER_HOUR,
    );
  });

  it("returns the persisted custom hour", () => {
    expect(resolveMoodReminderHour({ mood: { reminderHour: 7 } })).toBe(7);
  });

  it("returns the default hour when mood is present but empty", () => {
    expect(resolveMoodReminderHour({ mood: {} })).toBe(
      DEFAULT_MOOD_REMINDER_HOUR,
    );
  });
});

describe("resolveDeviceDelivery — per-device override", () => {
  it("defaults to server when nothing is set", () => {
    expect(resolveDeviceDelivery(null, null)).toBe("server");
    expect(resolveDeviceDelivery(null, undefined)).toBe("server");
  });

  it("the device override wins over the user-level default", () => {
    expect(
      resolveDeviceDelivery(
        { medication: { deliveryDefault: "server" } },
        "client",
      ),
    ).toBe("client");
    expect(
      resolveDeviceDelivery(
        { medication: { deliveryDefault: "client" } },
        "server",
      ),
    ).toBe("server");
  });

  it("a null override inherits the user-level roaming default", () => {
    expect(
      resolveDeviceDelivery({ medication: { deliveryDefault: "client" } }, null),
    ).toBe("client");
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
