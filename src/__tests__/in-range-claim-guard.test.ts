/**
 * No sentence calls the day in range while the Health score flags something.
 *
 * "All four of today's values sit inside their usual range" stood on the
 * morning beside a Health score that said "Blood pressure: needs attention".
 * Both were true of what each counted, and together they told the reader two
 * different things. The rule now lives in one place, `in-range-claim.ts`:
 * every all-in-range message key is registered there and worded only there,
 * through a function that takes the Health score's flag.
 *
 * This guard holds the tree to that:
 *
 * 1. every message whose text claims all-in-range (or "nothing needs your
 *    attention") is registered, or allowed here with a reason, so a new such
 *    sentence cannot be added beside the rule;
 * 2. a registered key is named in no source file but the rule's own;
 * 3. the rule's sentences say nothing in range while the score is flagged,
 *    and the morning lead and the Today overview read it.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import {
  ALL_IN_RANGE_KEYS,
  allClearLine,
  healthScoreFlag,
  vitalsAllInFact,
  vitalsInRangeSentence,
} from "@/lib/daily/in-range-claim";
import type { TodayVital } from "@/lib/daily/today-overview";

import { scanSourceMatches } from "./helpers/source-files";

const ROOT = join(__dirname, "../..");

/** A text that says everything, or all values, sit in range or need nothing. */
const ALL_IN_RANGE_TEXT =
  /\b(all|every|everything)\b[^.;]*\b(in|inside|within)\s+(their|your|its|the)?\s*(usual|personal|normal)?\s*range\b|\bnothing needs your attention\b/i;

/** Texts the pattern catches that make no claim about the day. */
const NOT_A_DAY_CLAIM: Record<string, string> = {
  "cycle.phaseEducation.context.MENSTRUAL":
    "general education about the cycle phase, not about the reader's day",
  "labs.groups.allInRange":
    "a lab group's own results, shown beside those results",
};

function leaves(node: unknown, prefix = ""): [string, string][] {
  if (typeof node === "string") return [[prefix, node]];
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([k, v]) =>
    leaves(v, prefix ? `${prefix}.${k}` : k),
  );
}

const registered = (key: string) =>
  ALL_IN_RANGE_KEYS.some((k) => key === k || key.startsWith(k));

describe("in-range claim guard", () => {
  const bundle = leaves(en);

  it("registers every all-in-range sentence in the bundle", () => {
    const claims = bundle.filter(([, text]) => ALL_IN_RANGE_TEXT.test(text));
    // The pattern must still see the sentences it was written for.
    expect(claims.length).toBeGreaterThanOrEqual(5);
    const unregistered = claims
      .map(([key]) => key)
      .filter((key) => !registered(key) && !(key in NOT_A_DAY_CLAIM));
    expect(unregistered).toEqual([]);
  });

  it("keeps the allow list honest", () => {
    const stale = Object.keys(NOT_A_DAY_CLAIM).filter((key) => {
      const hit = bundle.find(([k]) => k === key);
      return !hit || !ALL_IN_RANGE_TEXT.test(hit[1]);
    });
    expect(stale).toEqual([]);
  });

  it("registers only keys that exist", () => {
    const missing = ALL_IN_RANGE_KEYS.filter(
      (k) => !bundle.some(([key]) => key === k || key.startsWith(k)),
    );
    expect(missing).toEqual([]);
  });

  it("words a registered key only in the rule's own module", () => {
    const pattern = new RegExp(
      `["'\`](${ALL_IN_RANGE_KEYS.map((k) => k.replace(/\./g, "\\.")).join("|")})`,
      "g",
    );
    const matches = scanSourceMatches(join(ROOT, "src"), pattern, {
      fileFloor: 500,
      // The rule's module names each worded key at least once.
      matchFloor: 4,
      include: (rel) =>
        !rel.includes("__tests__/") && !rel.startsWith("generated/"),
    });
    const outside = matches
      .filter((m) => m.file !== "lib/daily/in-range-claim.ts")
      .map((m) => `${m.file}:${m.line} ${m.text}`);
    expect(outside).toEqual([]);
  });
});

describe("in-range claim rule", () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key} ${JSON.stringify(params)}` : key;
  const vital: TodayVital = {
    type: "BLOOD_PRESSURE_SYSTOLIC",
    value: 120,
    low: 110,
    high: 130,
    direction: "in",
    valueLabel: "120",
    rangeLabel: "110 to 130",
  } as TodayVital;

  it("flags a band setter, any pillar below green, and nothing else", () => {
    expect(healthScoreFlag(null)).toBeNull();
    expect(healthScoreFlag({ band: "green" })).toBeNull();
    expect(
      healthScoreFlag({
        band: "yellow",
        bandSetter: "BLOOD_PRESSURE",
        bandSetterBand: "yellow",
      }),
    ).toEqual({ band: "yellow", pillar: "BLOOD_PRESSURE" });
    // No setter (the number is as low as its worst pillar): the worst row.
    expect(
      healthScoreFlag({
        band: "yellow",
        bandSetter: null,
        pillars: [
          { id: "SLEEP", value: 80 },
          { id: "LIPIDS", value: 60 },
        ],
      }),
    ).toEqual({ band: "yellow", pillar: "LIPIDS" });
    // An older payload without the rows still counts as flagged.
    expect(healthScoreFlag({ band: "red" })).toEqual({
      band: "red",
      pillar: null,
    });
  });

  it("says nothing is in range while the score is flagged", () => {
    const flag = healthScoreFlag({
      band: "red",
      bandSetter: "BLOOD_PRESSURE",
      bandSetterBand: "red",
    });
    expect(vitalsInRangeSentence([vital, vital], null, "en", t)).toContain(
      "daily.lead.vitalsInRange",
    );
    expect(vitalsInRangeSentence([vital, vital], flag, "en", t)).toBeNull();
    expect(vitalsInRangeSentence([vital], flag, "en", t)).toBeNull();
    expect(vitalsAllInFact(3, flag, "en", t)).toContain(
      "daily.todayFact.vitals.checked",
    );
    expect(vitalsAllInFact(3, null, "en", t)).toContain(
      "daily.todayFact.vitals.allIn",
    );
    expect(allClearLine(flag, t)).toBeNull();
    expect(allClearLine(null, t)).toBe("daily.line.allClear");
  });
});
