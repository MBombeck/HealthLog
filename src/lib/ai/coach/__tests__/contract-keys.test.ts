/**
 * The v1.41 message keys and the seven bundles agree, both ways.
 *
 * The trail, memory, plan, reasoning and reply keys were laid down before
 * the code that renders them, so the catalogs in the contract modules are
 * their only reference until then. Forward: every key a catalog can produce
 * resolves in every locale, with the same placeholders as English. Reverse:
 * every leaf under the namespaces these catalogs own is one they can
 * produce, so a string cannot sit in the bundles with nothing able to reach
 * it.
 *
 * Checked by breaking it: deleting `insights.coach.activity.answer` from
 * `pl.json` fails the forward test by locale and key; renaming `{fact}` in
 * the German `insights.coach.memory.saved` fails the placeholder test; adding
 * an unused leaf under `insights.coach.reasoning` fails the reverse test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COACH_ACTIVITY_KEYS,
  COACH_ACTIVITY_STOP_KEYS,
  activityAreasKey,
  activityDigestDoneKey,
  activityDigestKey,
  activityMemoryKey,
  activitySummaryKey,
} from "@/lib/ai/coach/activity/contract";
import {
  COACH_ASSUMPTION_KEYS,
  COACH_CHART_COMPARE_KEYS,
  COACH_SUGGESTED_REPLIES_KEYS,
  interimLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import {
  COACH_MEMORY_KEYS,
  COACH_MEMORY_LIST_KEYS,
  COACH_PLAN_KEYS,
} from "@/lib/ai/coach/memory/contract";
import {
  REASONING_ADMIN_KEYS,
  REASONING_LEVEL_LABEL_KEYS,
  REASONING_SETTING_KEYS,
} from "@/lib/ai/reasoning/levels";
import { locales, type Locale } from "@/lib/i18n/config";

const ROOT = join(__dirname, "../../../../..");

function strings(locale: Locale): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (node: unknown, prefix: string) => {
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, prefix ? `${prefix}.${key}` : key);
      }
    } else {
      out.set(prefix, node);
    }
  };
  walk(
    JSON.parse(
      readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"),
    ) as unknown,
    "",
  );
  return out;
}

/** Counts that land on every plural tier some locale uses. */
const COUNTS = [0, 1, 2, 3, 5, 12, 22];

function catalogKeys(): Set<string> {
  const keys = new Set<string>([
    ...Object.values(COACH_ACTIVITY_KEYS),
    ...Object.values(COACH_ACTIVITY_STOP_KEYS),
    ...Object.values(COACH_MEMORY_KEYS),
    ...Object.values(COACH_PLAN_KEYS),
    ...Object.values(COACH_MEMORY_LIST_KEYS),
    ...Object.values(COACH_ASSUMPTION_KEYS),
    ...Object.values(COACH_SUGGESTED_REPLIES_KEYS),
    ...Object.values(COACH_CHART_COMPARE_KEYS),
    ...Object.values(REASONING_LEVEL_LABEL_KEYS),
    ...Object.values(REASONING_SETTING_KEYS),
    ...Object.values(REASONING_ADMIN_KEYS),
  ]);
  for (const locale of locales) {
    for (const count of COUNTS) {
      keys.add(activityDigestKey(count, locale));
      keys.add(activityDigestDoneKey(count, locale));
      keys.add(activityAreasKey(count, locale));
      keys.add(activityMemoryKey(count, locale));
      keys.add(activitySummaryKey(count, locale));
      keys.add(interimLabelKey(count, locale));
    }
  }
  return keys;
}

const OWNED = [
  "insights.coach.activity",
  "insights.coach.memory",
  "insights.coach.plan",
  "insights.coach.assumption",
  "insights.coach.suggestedReplies",
  "insights.coach.interim",
  "insights.coach.chart",
  "insights.coach.reasoning",
  "settings.coach.memory",
  "admin.assistant.reasoning",
];

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("v1.41 contract keys", () => {
  const keys = catalogKeys();
  const en = strings("en");

  it("produces the whole catalog", () => {
    // Every key laid down for the release but the `change_assumption` chip
    // label, which the dialog catalog's own test covers, plus the two
    // declined-proposal replies and the admin reasoning description.
    expect(keys.size).toBe(60);
  });

  it.each(locales)("every catalog key resolves in %s", (locale) => {
    const bundle = strings(locale);
    const missing = [...keys].filter(
      (key) => typeof bundle.get(key) !== "string" || bundle.get(key) === "",
    );
    expect(missing).toEqual([]);
  });

  it.each(locales)("%s keeps the English placeholders", (locale) => {
    const bundle = strings(locale);
    const drifted = [...keys].filter(
      (key) =>
        placeholders(String(bundle.get(key))).join() !==
        placeholders(String(en.get(key))).join(),
    );
    expect(drifted).toEqual([]);
  });

  it("every leaf under the owned namespaces is reachable from a catalog", () => {
    const owned = [...en.keys()].filter((key) =>
      OWNED.some((ns) => key.startsWith(`${ns}.`)),
    );
    expect(owned.length).toBeGreaterThan(40);
    expect(owned.filter((key) => !keys.has(key))).toEqual([]);
  });
});
