/**
 * v1.4.27 — i18n drift-guard.
 *
 * Locks down the bundled key sets that ship across all six locales so
 * a future copy-paste regression can't silently drop a translation
 * row or introduce a per-locale-only key.
 *
 * The locale-integrity test (src/lib/__tests__/i18n-locale-integrity.test.ts)
 * already asserts EN/locale parity for every key. This file pins
 * specific call-site key groups so a contributor who only edits one
 * bundle gets a precise failure instead of a 200-line parity diff.
 *
 * Scope (mirrors v1.4.27 buckets B3, B4, B5):
 *   - admin.carrier* + admin.providerWithings + admin.providerPasskey   (B3 — login carrier chip)
 *   - insights.emptyState.*     (B4 — per-metric empty states)
 *   - notifications.admin.*     (B5 — admin notification messages)
 *   - notifications.user.*      (B5 — user-facing Telegram test body)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MESSAGES = join(__dirname, "../../messages");
const LOCALES = readdirSync(MESSAGES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

function loadBundle(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), "utf8"));
}

function flatten(obj: unknown, prefix: string, out: Map<string, string>): void {
  if (obj == null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (typeof v === "object" && v !== null) flatten(v, key, out);
  }
}

const FLAT_BY_LOCALE = new Map<string, Map<string, string>>();
for (const locale of LOCALES) {
  const flat = new Map<string, string>();
  flatten(loadBundle(locale), "", flat);
  FLAT_BY_LOCALE.set(locale, flat);
}

const REQUIRED_KEY_SETS: Array<{
  label: string;
  required: string[];
}> = [
  {
    label: "admin.carrier (B3 — login carrier chip)",
    required: ["admin.carrier"],
  },
  {
    label: "insights.emptyState.* (B4 — per-metric empty states)",
    required: [
      "insights.emptyState.bloodPressure.title",
      "insights.emptyState.bloodPressure.description",
      "insights.emptyState.bloodPressure.cta",
      "insights.emptyState.weight.title",
      "insights.emptyState.weight.description",
      "insights.emptyState.weight.cta",
      "insights.emptyState.pulse.title",
      "insights.emptyState.pulse.description",
      "insights.emptyState.pulse.cta",
      "insights.emptyState.bmi.title",
      "insights.emptyState.bmi.description",
      "insights.emptyState.bmi.cta",
      "insights.emptyState.mood.title",
      "insights.emptyState.mood.description",
      "insights.emptyState.mood.cta",
      "insights.emptyState.medication.title",
      "insights.emptyState.medication.description",
      "insights.emptyState.medication.cta",
      "insights.emptyState.sleep.title",
      "insights.emptyState.sleep.description",
      "insights.emptyState.sleep.cta",
    ],
  },
  {
    label: "notifications.admin.* (B5 — admin notification dispatcher keys)",
    required: [
      "notifications.admin.deployFailedTitle",
      "notifications.admin.deployFailedBody",
      "notifications.admin.testNotificationTitle",
      "notifications.admin.testNotificationBody",
      "notifications.admin.reminderCheckMissedTitle",
      "notifications.admin.reminderCheckMissedBody",
      "notifications.admin.reminderCheckOverdueTitle",
      "notifications.admin.reminderCheckOverdueBody",
      // v1.4.27 — offline-geo fallback notifications.
      "notifications.admin.offlineGeoUnavailableTitle",
      "notifications.admin.offlineGeoUnavailableBody",
    ],
  },
  {
    label: "notifications.user.* (B5 — user-facing Telegram test body)",
    required: ["notifications.user.telegramTestBody"],
  },
];

describe("v1.4.27 B6 i18n drift-guard — required keys present in every locale", () => {
  // Six shipped locales. An empty read of `messages/` would register zero
  // per-locale cases and the suite would report green over nothing.
  it("reads every shipped locale bundle", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(6);
  });

  for (const { label, required } of REQUIRED_KEY_SETS) {
    describe(label, () => {
      it.each(LOCALES)(
        "messages/%s.json has every required key with a non-empty value",
        (locale) => {
          const flat = FLAT_BY_LOCALE.get(locale)!;
          const missing: string[] = [];
          const empty: string[] = [];
          for (const key of required) {
            const v = flat.get(key);
            if (v === undefined) missing.push(key);
            else if (v.trim() === "") empty.push(key);
          }
          expect(
            { missing, empty },
            `Locale ${locale} drifted from the ${label} key set.`,
          ).toEqual({ missing: [], empty: [] });
        },
      );
    });
  }
});
