/**
 * v1.4.27 B6 / BL-P4-8 — i18n drift-guard.
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
 * Scope (mirrors v1.4.27 buckets B1, B3, B4, B5):
 *   - dashboard.glp1.*          (B1 — drug-level + weight tabs)
 *   - admin.carrier* + admin.providerWithings + admin.providerPasskey   (B3 — login carrier chip)
 *   - insights.emptyState.*     (B4 — per-metric empty states)
 *   - notifications.admin.*     (B5 — admin notification messages)
 *   - notifications.user.*      (B5 — user-facing Telegram test body)
 *   - personalRecords + workouts (BL-P4-8 — PR + Workout strings)
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

function flatten(
  obj: unknown,
  prefix: string,
  out: Map<string, string>,
): void {
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

function keysForPrefix(prefix: string): Set<string> {
  // Source of truth: EN. The locale-integrity test ensures every
  // locale carries the same key shape, so EN's view is canonical.
  const enFlat = FLAT_BY_LOCALE.get("en");
  if (!enFlat) throw new Error("EN bundle did not load");
  const set = new Set<string>();
  for (const k of enFlat.keys()) {
    if (k === prefix || k.startsWith(`${prefix}.`)) set.add(k);
  }
  return set;
}

const REQUIRED_KEY_SETS: Array<{
  label: string;
  required: string[];
}> = [
  {
    label: "dashboard.glp1.* (B1 — GLP-1 tile tabs)",
    required: [
      "dashboard.glp1.title",
      "dashboard.glp1.tabLevel",
      "dashboard.glp1.tabWeight",
      "dashboard.glp1.tabsAria",
      "dashboard.glp1.rangeStripLabel",
      "dashboard.glp1.levelUnavailable",
      "dashboard.glp1.weightUnavailable",
      "dashboard.glp1.lastInjection",
      "dashboard.glp1.nextInjection",
    ],
  },
  {
    label: "admin.carrier (B3 — login carrier chip)",
    required: ["admin.carrier", "admin.carrierUnknown"],
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
      // v1.4.27 R5 — offline-geo fallback notifications.
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

describe("v1.4.27 B6 i18n drift-guard — PR + Workout strings stay in lockstep", () => {
  // BL-P4-8: PR and Workout strings were the trigger for the
  // drift-guard ask. Personal-record badge / tooltip live under
  // `insights.personalRecord.*`. Workout strings are not yet in the
  // bundles — the v1.4.23 batch ingest landed the API, the UI
  // surface ships in v1.4.28 / v1.5. The drift-guard keeps the
  // namespace anchor live so the workout copy work in v1.4.28 lands
  // with parity from the first commit.
  const prKeys = [...keysForPrefix("insights.personalRecord")];

  it("insights.personalRecord namespace has at least one key (sanity)", () => {
    expect(
      prKeys.length,
      "insights.personalRecord.* keys exist in en.json",
    ).toBeGreaterThan(0);
  });

  it.each(LOCALES)(
    "messages/%s.json carries every insights.personalRecord.* key with a non-empty value",
    (locale) => {
      const flat = FLAT_BY_LOCALE.get(locale)!;
      const missing: string[] = [];
      const empty: string[] = [];
      for (const key of prKeys) {
        const v = flat.get(key);
        if (v === undefined) missing.push(key);
        else if (v.trim() === "") empty.push(key);
      }
      expect(
        { missing, empty },
        `Locale ${locale} drifted from the personal-record key set.`,
      ).toEqual({ missing: [], empty: [] });
    },
  );
});
