import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One sentence, one key. In `messages/en.json` a value of six words or more
 * may not stand under two keys of the same top-level namespace, because keys
 * of one namespace render on the same surface and the reader then meets the
 * same sentence twice: "No off-host bucket is set up." under two recovery
 * signals, the recovery page's subtitle repeated as its explainer, the same
 * empty line under three trend cards.
 *
 * Words are counted after each `{…}` argument (an ICU plural included)
 * collapses to one word, so "{count, plural, one {# day} other {# days}}"
 * is one word, not eight.
 *
 * Not a duplicate:
 *   - the CLDR plural arms of one message (`…One` / `…Few` / `…Many` /
 *     `…Other`), which English fills alike;
 *   - a group whose keys all match one `EXCEPTIONS` entry, each with its
 *     reason (one error at a time, one provider at a time, …).
 *
 * `KNOWN` is the ratchet of real duplicates found when the guard was
 * written. It may only shrink: a new duplicate fails, and an entry that no
 * longer duplicates fails too, so the list is deleted from as the copy is
 * fixed.
 */

const EN = join(__dirname, "../../messages/en.json");
const MIN_WORDS = 6;

/** Groups whose keys all match one pattern are not counted. */
const EXCEPTIONS: { match: RegExp; reason: string }[] = [
  {
    match: /^apiErrors\./,
    reason: "one error envelope per response; never two on a surface",
  },
  {
    match: /^settings\.\w+OauthError\./,
    reason: "the callback error of the one provider being connected",
  },
  {
    match:
      /^settings\.sections\.export\.import\.(?:json|csv|fit|healthConnect|recordFile)\./,
    reason: "each importer reports its own run, and one import runs at a time",
  },
  {
    match: /^settings\.(?:measurements|workouts|documents)Token\.createFailed$/,
    reason: "one token sheet is open at a time",
  },
  {
    match: /^settings\.(?:polar|oura)DisconnectDescription$/,
    reason: "the confirm dialog of the one provider being disconnected",
  },
  {
    match: /^settings\.(?:dawarich|garmin)Errors\.generic$/,
    reason: "each integration's own failure, on its own sheet",
  },
  {
    match:
      /^medications\.(?:category\.custom\.saveFailed|course\.error\.generic)$/,
    reason: "failure line of two different sheets",
  },
  {
    match: /^notifications\.(?:coachNudge|content)\.saveError$/,
    reason: "a toast for the one save that failed",
  },
  {
    match:
      /^records\.(?:allergies\.freeText\.saveError|conditions\.saveError|(?:allergies|family)\.deleteConfirmDescription)$/,
    reason: "a toast or confirm dialog for one action at a time",
  },
  {
    match:
      /^recordSharing\.(?:(?:invite|managed)\.errorStepUp|managed\.errorOffline|actionError\.offline|(?:given|received)\.loadError)$/,
    reason: "the failure line of the one action or card that failed",
  },
  {
    match: /^doctorReport\.(?:anamnesisUnreadable|emergency\.unreadable)$/,
    reason: "stands in for an unreadable value, like a data cell",
  },
  {
    match: /^insights\.derived\.vitals\.sixMinuteBand\./,
    reason: "one band shows at a time",
  },
  {
    match: /^insights\.mood\.(?:influence\.detail|crosstab\.detailSameDay)$/,
    reason: "a data template filled with different values",
  },
  {
    match: /^mentalHealth\.followUpHint\./,
    reason: "a result page shows one questionnaire",
  },
  {
    match: /^nutrients\.(?:page|micronutrients)\.loadError$/,
    reason: "the page error replaces the page, the card error only the card",
  },
  {
    match: /^seizures\.(?:report\.daysSinceLast|summary\.sinceLast)$/,
    reason: "report and PDF label vs the seizure page's summary",
  },
  {
    match: /^seizures\.quick\.threshold\./,
    reason: "one threshold alert shows at a time",
  },
];

/** Real duplicates today. Delete an entry when its copy is fixed; never add. */
const KNOWN: string[][] = [
  [
    "admin.recoveryReadiness.reason.dump_retention.missing",
    "admin.section.backups.database.retentionOffhostMissing",
  ],
  [
    "admin.recoveryReadiness.reason.dump_retention.not_configured",
    "admin.recoveryReadiness.reason.offhost_copies.not_configured",
  ],
  [
    "admin.recoveryReadiness.reason.offhost_setup.no_admin",
    "admin.recoveryReadiness.reason.recovery_kit.no_admin",
  ],
  [
    "insights.deviceScores.description",
    "insights.subPage.explainer.recoveryPageBody",
  ],
  [
    "insights.trendAnnotation.emptyBp",
    "insights.trendAnnotation.emptyMood",
    "insights.trendAnnotation.emptyWeight",
  ],
];

/** Collapses every top-level `{…}` argument to one word. */
function collapseArguments(value: string): string {
  let out = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "{") {
      if (depth === 0) out += " _ ";
      depth++;
    } else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

function wordCount(value: string): number {
  return collapseArguments(value).trim().split(/\s+/).filter(Boolean).length;
}

const pluralStem = (key: string) =>
  key.replace(/(?:Zero|One|Two|Few|Many|Other)$/, "");

/**
 * Every group of two or more keys in one top-level namespace sharing a value
 * of `MIN_WORDS` words or more, plural arms of one message folded together.
 * Keys within a group and the groups themselves come back sorted.
 */
function findDuplicateValues(bundle: unknown): string[][] {
  const byValue = new Map<string, string[]>();
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      if (wordCount(node) < MIN_WORDS) return;
      const id = `${path.split(".")[0]}\u0000${node.trim()}`;
      byValue.set(id, [...(byValue.get(id) ?? []), path]);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node))
        walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(bundle, "");
  return [...byValue.values()]
    .filter((keys) => new Set(keys.map(pluralStem)).size > 1)
    .map((keys) => [...keys].sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

const excepted = (group: string[]) =>
  EXCEPTIONS.find(({ match }) => group.every((k) => match.test(k)));

describe("no sentence stands under two keys of one namespace", () => {
  const groups = findDuplicateValues(JSON.parse(readFileSync(EN, "utf8")));
  const open = groups.filter((g) => !excepted(g));

  it("reads the bundle", () => {
    // Guard against a walk that finds nothing and agrees with an empty list.
    expect(groups.length).toBeGreaterThan(KNOWN.length);
  });

  it("finds no duplicate outside the exceptions and the ratchet", () => {
    const known = new Set(KNOWN.map((g) => g.join(" | ")));
    expect(open.map((g) => g.join(" | ")).filter((g) => !known.has(g))).toEqual(
      [],
    );
  });

  it("keeps every KNOWN entry a live duplicate (the list only shrinks)", () => {
    const live = new Set(open.map((g) => g.join(" | ")));
    expect(
      KNOWN.map((g) => [...g].sort().join(" | ")).filter((g) => !live.has(g)),
    ).toEqual([]);
  });

  it("keeps every exception in use", () => {
    const used = new Set(groups.map(excepted).filter(Boolean));
    expect(
      EXCEPTIONS.filter((e) => !used.has(e)).map((e) => e.match.source),
    ).toEqual([]);
  });
});

describe("findDuplicateValues", () => {
  const SENTENCE = "No off-host bucket is set up.";

  it("finds the same sentence under two keys of one namespace", () => {
    expect(
      findDuplicateValues({
        admin: { a: { reason: SENTENCE }, b: { reason: SENTENCE } },
      }),
    ).toEqual([["admin.a.reason", "admin.b.reason"]]);
  });

  it("leaves near duplicates, other namespaces, short values and plural arms alone", () => {
    expect(
      findDuplicateValues({
        admin: {
          a: SENTENCE,
          b: "No off-host bucket is set up yet.",
          short: "Could not save it.",
          short2: "Could not save it.",
          countFew: "{count} readings move to {name} today.",
          countOther: "{count} readings move to {name} today.",
          plural: "{count, plural, one {# entry} other {# entries}}",
          plural2: "{count, plural, one {# entry} other {# entries}}",
        },
        settings: { a: SENTENCE },
      }),
    ).toEqual([]);
  });

  it("counts an ICU argument as one word", () => {
    expect(wordCount("{days, plural, one {# day} other {# days}}")).toBe(1);
    expect(wordCount("{count} readings, already in the same unit")).toBe(7);
  });
});
