import { describe, expect, it } from "vitest";

import {
  isManagedRecordSettingsFamily,
  MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST,
  MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
  managedModulePreferencesFrom,
  parseManagedRecordSettingsPatch,
} from "@/lib/record-settings/configuration";
import { WRITABLE_MODULE_KEYS } from "@/lib/validations/modules";

describe("managed record settings configuration contract", () => {
  it("enumerates the only target-record fields each settings DTO may write", () => {
    expect(MANAGED_RECORD_SETTINGS_FIELD_ALLOWLIST).toEqual({
      profile: [
        "displayName",
        "heightCm",
        "dateOfBirth",
        "gender",
        "locale",
        "timezone",
        "unitPreference",
        "timeFormat",
        "dateFormat",
      ],
      modules: ["modulePreferences", "cycleTrackingEnabled"],
      notifications: ["moodReminderEnabled", "notificationPreferences"],
      thresholds: ["overrides"],
      coach: ["disableCoach", "preferences"],
      insights: ["layout"],
    });
  });

  it.each([
    ["profile", { email: "not-allowed@example.test" }],
    ["modules", { role: "ADMIN" }],
    // The delegated key by its module name, which is the mistake a stale
    // client makes. It has to stay a refusal: accepting it would persist an
    // inert `false` behind a green "saved" and change nothing.
    ["modules", { modulePreferences: { cycle: false } }],
    // An empty patch. It parses as a strict object and would audit a change
    // nobody made.
    ["modules", {}],
    [
      "notifications",
      {
        notificationPreferences: { medication: { deliveryDefault: "client" } },
      },
    ],
    ["thresholds", { glucoseUnit: "imperial" }],
    ["coach", { memories: [] }],
    ["insights", { provider: "external" }],
  ] as const)("rejects a disallowed %s field", (family, patch) => {
    expect(() => parseManagedRecordSettingsPatch(family, patch)).toThrow();
  });

  it.each([
    [
      "profile",
      {
        displayName: "Managed profile",
        heightCm: 120,
        dateOfBirth: "2016-04-03",
        gender: "OTHER",
        locale: "en",
        timezone: "Europe/Berlin",
        unitPreference: "metric",
        timeFormat: "H24",
        dateFormat: "DMY",
      },
    ],
    ["modules", { modulePreferences: { mood: false } }],
    // v1.38.14 (#939) — the delegated key, sent on its own. `cycle` is not a
    // writable module preference and never will be: its user-layer state is
    // the record's own cycle profile, so the family names the real column
    // rather than a blob entry the gate ignores.
    ["modules", { cycleTrackingEnabled: false }],
    [
      "notifications",
      {
        moodReminderEnabled: true,
        notificationPreferences: {
          medication: { lowStockRunwayDays: 7, reorderLeadDays: 10 },
          mood: { reminderHour: 22 },
        },
      },
    ],
    ["thresholds", { overrides: { WEIGHT: { min: 55, max: 80 } } }],
    [
      "coach",
      {
        disableCoach: false,
        preferences: {
          tone: "warm",
          verbosity: "default",
          excludeMetrics: [],
          defaultWindow: "allTime",
        },
      },
    ],
    [
      "insights",
      {
        layout: {
          version: 2,
          tiles: [{ id: "weight", visible: true, order: 0 }],
        },
      },
    ],
  ] as const)("accepts a typed %s patch", (family, patch) => {
    expect(() => parseManagedRecordSettingsPatch(family, patch)).not.toThrow();
  });

  // Watched red: re-adding `showEvidenceByDefault: true` to the managed
  // coach pick makes the strict schema accept the key again and this
  // fails. The evidence disclosure stopped honouring the flag in v1.4.27
  // (F14); a guardian toggle over a pref nothing reads is a dead control.
  it("refuses the retired showEvidenceByDefault pref", () => {
    expect(() =>
      parseManagedRecordSettingsPatch("coach", {
        preferences: {
          tone: "warm",
          verbosity: "default",
          excludeMetrics: [],
          defaultWindow: "allTime",
          showEvidenceByDefault: true,
        },
      }),
    ).toThrow();
  });

  it("uses the complete canonical module inventory for a fresh record", () => {
    expect(Object.keys(MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS)).toEqual(
      WRITABLE_MODULE_KEYS,
    );
    expect(managedModulePreferencesFrom(null)).toEqual(
      MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
    );
  });

  it("accepts only the canonical profile gender enum", () => {
    expect(() =>
      parseManagedRecordSettingsPatch("profile", { gender: "MALE" }),
    ).not.toThrow();
    expect(() =>
      parseManagedRecordSettingsPatch("profile", { gender: "UNKNOWN" }),
    ).toThrow();
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "rejects inherited family name %s",
    (family) => {
      expect(isManagedRecordSettingsFamily(family)).toBe(false);
    },
  );
});
