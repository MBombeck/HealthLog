import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS } from "@/lib/record-settings";
import { ALL_METRICS } from "@/lib/validations/thresholds";

import {
  managedModulesPatch,
  ManagedRecordSettingsForm,
} from "../managed-record-settings-section";

const LOCALES = ["de", "en", "es", "fr", "it", "pl", "ko"] as const;

const render = (
  family: Parameters<typeof ManagedRecordSettingsForm>[0]["family"],
  settings: Record<string, unknown>,
  locale: (typeof LOCALES)[number] = "en",
  error?: string,
) =>
  renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ManagedRecordSettingsForm
        disabled={false}
        family={family}
        onSave={vi.fn()}
        saveLabel="Save"
        settings={settings}
        error={error}
      />
    </I18nProvider>,
  );

describe("managed record settings forms", () => {
  it.each([
    ["profile", { timezone: "Europe/Berlin" }, "managed-display-name"],
    ["modules", { modulePreferences: { mood: true } }, "mood"],
    [
      "notifications",
      {
        moodReminderEnabled: true,
        notificationPreferences: {
          medication: { lowStockRunwayDays: 7, reorderLeadDays: 10 },
          mood: { reminderHour: 22 },
        },
      },
      "managed-reminder-hour",
    ],
    [
      "thresholds",
      { overrides: { WEIGHT: { min: 55, max: 80 } } },
      "managed-threshold-metric",
    ],
    [
      "coach",
      { disableCoach: false, preferences: { tone: "warm" } },
      "managed-coach-tone",
    ],
    [
      "insights",
      {
        layout: {
          version: 2,
          tiles: [{ id: "weight", visible: true, order: 0 }],
        },
      },
      "tile-order-weight",
    ],
  ] as const)(
    "renders labeled %s controls without an internal JSON editor",
    (family, settings, control) => {
      const html = render(family, settings);

      expect(html).toContain(control);
      expect(html).toContain("Save");
      expect(html).not.toContain("<textarea");
    },
  );

  it("gives the profile date of birth a DateField, never a native date input", () => {
    const html = render("profile", { timezone: "Europe/Berlin" });
    // The DateField primitive marks itself; the browser-locale native
    // `type="date"` trap (v1.25.4) must be gone.
    expect(html).toContain('data-slot="date-field"');
    expect(html).not.toContain('type="date"');
    // Its hidden mirror still carries the submit name.
    expect(html).toContain('name="dateOfBirth"');
  });

  it.each([
    "profile",
    "modules",
    "notifications",
    "thresholds",
    "coach",
  ] as const)(
    "orders the %s action row last, with the error above it (§12)",
    (family) => {
      const settingsByFamily: Record<string, Record<string, unknown>> = {
        profile: { timezone: "Europe/Berlin" },
        modules: { modulePreferences: {} },
        notifications: {},
        thresholds: { overrides: {}, effective: {} },
        coach: {},
      };
      const html = render(family, settingsByFamily[family], "en", "Boom");
      const actionAt = html.indexOf('data-slot="settings-card-actions"');
      const alertAt = html.indexOf('role="alert"');
      // The action row exists and is a real SettingsCardActions.
      expect(actionAt).toBeGreaterThan(-1);
      // The error line renders, and it sits ABOVE the action row.
      expect(alertAt).toBeGreaterThan(-1);
      expect(alertAt).toBeLessThan(actionAt);
      // Nothing renders after the action row inside the form.
      expect(html.indexOf("</form>")).toBeGreaterThan(actionAt);
    },
  );

  it("toggles the managed modules with a Switch, matching the owner section", () => {
    const html = render("modules", { modulePreferences: { mood: true } });
    // The Switch primitive (role="switch") replaces the bare checkbox the
    // owner module section never used; the hidden mirror keeps the submit name.
    expect(html).toContain('role="switch"');
    expect(html).toContain('name="mood"');
  });

  it("renders every direct module and threshold metric for a fresh record", () => {
    const modules = render("modules", { modulePreferences: {} });
    const thresholds = render("thresholds", {
      overrides: {},
      effective: Object.fromEntries(
        ALL_METRICS.map((metric) => [
          metric,
          { range: { greenMin: 10, greenMax: 20 } },
        ]),
      ),
    });

    for (const moduleKey of Object.keys(
      MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS,
    )) {
      expect(modules).toContain(`name="${moduleKey}"`);
    }
    for (const metric of ALL_METRICS) {
      expect(thresholds).toContain(`value="${metric}"`);
    }
    expect(thresholds).toContain('value="10"');
    expect(thresholds).toContain('value="20"');
  });

  it("uses localized display inventories instead of raw Coach and Insight IDs", () => {
    for (const locale of LOCALES) {
      const coach = render(
        "coach",
        {
          preferences: {
            excludeMetrics: ["bp"],
            dataClusters: ["cardio"],
          },
        },
        locale,
      );
      const insights = render(
        "insights",
        {
          layout: {
            version: 2,
            sections: [{ id: "unknown-section", visible: true, order: 0 }],
            tiles: [{ id: "unknown-tile", visible: true, order: 0 }],
          },
        },
        locale,
      );

      expect(coach).not.toContain(">bp<");
      expect(coach).not.toContain(">cardio<");
      expect(insights).not.toContain(">unknown-section<");
      expect(insights).not.toContain(">unknown-tile<");
      expect(insights).not.toContain("settings.sharedRecord");
    }
  });

  it.each(["toString", "constructor", "__proto__"])(
    "renders the unavailable label for prototype property %s",
    (id) => {
      const coach = render("coach", {
        preferences: {
          excludeMetrics: [id],
          dataClusters: [id],
        },
      });
      const insights = render("insights", {
        layout: {
          version: 2,
          sections: [{ id, visible: true, order: 0 }],
          tiles: [{ id, visible: true, order: 0 }],
        },
      });

      expect(coach).not.toContain(`>${id}<`);
      expect(insights).toContain("Unavailable insight");
      expect(insights).not.toContain(`>${id}<`);
      expect(insights).not.toContain("settings.sharedRecord");
    },
  );
});

describe("what a managed Modules save sends", () => {
  const moduleKeys = Object.keys(MANAGED_RECORD_SETTINGS_MODULE_DEFAULTS);

  /** The form as it stands after somebody flips one switch. */
  const formWith = (checked: Record<string, boolean>) => {
    const form = new FormData();
    for (const [name, on] of Object.entries(checked)) {
      if (on) form.set(name, "on");
    }
    return form;
  };

  it("omits the cycle flag when only a direct module moved", () => {
    // The record tracks cycles and the guardian is turning Labs off. Sending
    // the cycle switch's position here would write the sex-derived default as
    // an explicit answer and freeze it against a later change of sex.
    const settings = {
      modulePreferences: {},
      cycleTrackingEnabled: true,
    };
    const checked = Object.fromEntries(
      moduleKeys.map((key) => [key, key !== "labs"]),
    );

    const patch = managedModulesPatch(
      settings,
      formWith({ ...checked, cycleTrackingEnabled: true }),
    );

    expect(patch.modulePreferences.labs).toBe(false);
    expect("cycleTrackingEnabled" in patch).toBe(false);
  });

  it("sends the cycle flag when the cycle switch itself moved", () => {
    const patch = managedModulesPatch(
      { modulePreferences: {}, cycleTrackingEnabled: true },
      formWith(Object.fromEntries(moduleKeys.map((key) => [key, true]))),
    );

    expect(patch.cycleTrackingEnabled).toBe(false);
  });

  it("sends the cycle flag when a record with none turns it on", () => {
    // `cycleTrackingEnabled` absent is the record that never answered; the
    // switch opens off, so turning it on is a change and has to ride.
    const patch = managedModulesPatch(
      { modulePreferences: {} },
      formWith({
        ...Object.fromEntries(moduleKeys.map((key) => [key, true])),
        cycleTrackingEnabled: true,
      }),
    );

    expect(patch.cycleTrackingEnabled).toBe(true);
  });
});
