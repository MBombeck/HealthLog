/**
 * The dialog's key catalog and the seven bundles agree, both ways.
 *
 * Forward: every key the catalog can produce — every label map entry, every
 * domain, window, period and granularity, every plural tier — resolves in
 * every locale. Reverse: every leaf under the namespaces the catalog owns
 * (`coach.step`, `coach.result`, `coach.method`, `coach.followUp`,
 * `coach.clarify`, `coach.reuse`) is one the catalog can produce, so a
 * string cannot sit in the bundles with nothing able to reach it.
 *
 * Checked by breaking it: deleting `coach.result.copied` from `ko.json`
 * fails the forward test by locale and key; adding an unused leaf under
 * `coach.step` fails the reverse test by name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import {
  coachScopeWindowSchema,
  type CoachResultGranularity,
  type CoachResultPeriod,
} from "@/lib/ai/coach/types";
import { coachStepDomainSchema } from "@/lib/ai/coach/stream-events";
import {
  COACH_CLARIFY_UI_KEYS,
  COACH_FOLLOW_UP_KEYS,
  COACH_FOLLOW_UP_UI_KEYS,
  COACH_METHOD_ABSENT_KEYS,
  COACH_METHOD_AGGREGATION_KEYS,
  COACH_METHOD_KEYS,
  COACH_RESULT_COLUMN_KEYS,
  COACH_RESULT_TITLE_KEYS,
  COACH_RESULT_UI_KEYS,
  COACH_RESULT_WITHHELD_KEYS,
  COACH_REUSE_CAPTION_KEY,
  COACH_STEP_LABEL_KEYS,
  COACH_STEP_REASON_KEYS,
  COACH_STEP_UI_KEYS,
  clarifyWindowLabelKey,
  coachDomainLabelKey,
  coachGranularityLabelKey,
  coachPeriodLabelKey,
  coachWindowLabelKey,
  methodAveragesKey,
  methodReadingsKey,
  methodTotalsKey,
  stepMetricsKey,
  stepReadingsKey,
  stepRowsKey,
} from "@/lib/ai/coach/dialog-keys";

const ROOT = join(__dirname, "../../../../..");

function bundle(locale: Locale): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function leaves(node: unknown, prefix: string, out: Map<string, unknown>) {
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      leaves(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out.set(prefix, node);
  }
  return out;
}

const PERIODS: CoachResultPeriod[] = ["current", "previous", "yearAgo"];
const GRANULARITIES: CoachResultGranularity[] = ["day", "week", "month"];

/** Counts that land on every plural tier some locale uses. */
const COUNTS = [0, 1, 2, 3, 5, 12, 22];

function catalogKeys(): Set<string> {
  const keys = new Set<string>([
    ...Object.values(COACH_STEP_LABEL_KEYS),
    ...Object.values(COACH_STEP_UI_KEYS),
    ...Object.values(COACH_STEP_REASON_KEYS),
    ...Object.values(COACH_RESULT_TITLE_KEYS),
    ...Object.values(COACH_RESULT_COLUMN_KEYS),
    ...Object.values(COACH_RESULT_UI_KEYS),
    ...Object.values(COACH_RESULT_WITHHELD_KEYS),
    ...Object.values(COACH_METHOD_KEYS),
    ...Object.values(COACH_METHOD_AGGREGATION_KEYS),
    ...Object.values(COACH_METHOD_ABSENT_KEYS),
    ...Object.values(COACH_FOLLOW_UP_KEYS),
    ...Object.values(COACH_FOLLOW_UP_UI_KEYS),
    ...Object.values(COACH_CLARIFY_UI_KEYS),
    COACH_REUSE_CAPTION_KEY,
  ]);
  for (const domain of coachStepDomainSchema.options) {
    keys.add(coachDomainLabelKey(domain));
  }
  for (const window of coachScopeWindowSchema.options) {
    keys.add(coachWindowLabelKey(window));
    keys.add(clarifyWindowLabelKey(window));
  }
  for (const period of PERIODS) {
    keys.add(coachPeriodLabelKey(period));
  }
  for (const granularity of GRANULARITIES) {
    keys.add(coachGranularityLabelKey(granularity));
    keys.add(methodAveragesKey(granularity));
    keys.add(methodTotalsKey(granularity));
  }
  for (const locale of locales) {
    for (const count of COUNTS) {
      keys.add(stepReadingsKey(count, locale));
      keys.add(stepRowsKey(count, locale));
      keys.add(stepMetricsKey(count, locale));
      keys.add(methodReadingsKey(count, locale));
    }
  }
  return keys;
}

const OWNED = [
  "coach.step",
  "coach.result",
  "coach.method",
  "coach.followUp",
  "coach.clarify",
  "coach.reuse",
];

describe("Coach dialog keys", () => {
  const keys = catalogKeys();

  it("produces a non-trivial catalog", () => {
    expect(keys.size).toBeGreaterThan(130);
  });

  it.each(locales)("every catalog key resolves in %s", (locale) => {
    const strings = leaves(bundle(locale), "", new Map());
    const missing = [...keys].filter(
      (key) => typeof strings.get(key) !== "string" || strings.get(key) === "",
    );
    expect(missing).toEqual([]);
  });

  it("every leaf under the owned namespaces is reachable from the catalog", () => {
    const strings = leaves(bundle("en"), "", new Map());
    const owned = [...strings.keys()].filter((key) =>
      OWNED.some((ns) => key.startsWith(`${ns}.`)),
    );
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.filter((key) => !keys.has(key))).toEqual([]);
  });
});
