import { describe, expect, it } from "vitest";

import { allMessages } from "@/lib/i18n/shared-resolve";

/**
 * Two wording rules that translations of new strings kept breaking.
 *
 * 1. Form of address. The French and Russian bundles address the reader
 *    formally (vous, вы). About forty newer French strings and eleven Russian
 *    ones said tu / ты next to them, on the emergency card and the care feed
 *    among others, so one page switched register mid-sentence.
 * 2. Missed is not skipped. In Russian and Polish the medication term list
 *    keeps "skipped" (a person chose to skip: пропущено / pominięte) apart
 *    from "missed" (the dose passed untaken: не принято / nieprzyjęte). Bars,
 *    badges and the seizure trigger rendered a missed dose with the skip
 *    word. Every dose sentence whose English says "missed" now has to carry
 *    the missed word.
 */

function flatten(
  node: unknown,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === "string") out.set(prefix, node);
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

const en = flatten(allMessages.en);
const fr = flatten(allMessages.fr);
const ru = flatten(allMessages.ru);
const pl = flatten(allMessages.pl);

/** French informal pronouns and possessives as whole words. */
const FR_INFORMAL =
  /(?<![\p{L}'’])([Tt]u|[Tt]oi|[Tt]es|[Tt]a|[Tt]on|[Tt]e)(?=[\s ,.!?])|(?<![\p{L}'’])[Tt]['’](?=[aeiouéèêh])/u;
/** Keys where a French match is a noun, not the pronoun. */
const FR_NOT_ADDRESS: Record<string, string> = {
  "insights.coach.settingsVerbosityConciseHint": "'le ton': the tone",
};

const RU_INFORMAL =
  /(?<![\p{L}])(ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|твоих|твоим|твоего|твоей|твоему|твою)(?![\p{L}])/iu;

/** Namespaces whose "missed" is the dose state. */
const DOSE_NAMESPACES =
  /^(medications|insights|seizures|charts|achievements|doctorReport|notifications\.admin|admin\.reminder)/;
const MISSED_WORD: Record<"ru" | "pl", RegExp> = {
  ru: /не\s*принят|непринят/i,
  pl: /nieprzyj/i,
};

function informal(
  bundle: Map<string, string>,
  pattern: RegExp,
  except: Record<string, string> = {},
): string[] {
  return [...bundle]
    .filter(([key, value]) => !(key in except) && pattern.test(value))
    .map(([key]) => key)
    .sort();
}

describe("form of address", () => {
  it("the patterns catch the strings that shipped informal", () => {
    const sample = new Map([
      ["a", "Ta carte"],
      ["b", "Télécharge-la, puis colle ton lien."],
      ["c", "Votre carte"],
      ["d", "Trop de tentatives."],
    ]);
    expect(informal(sample, FR_INFORMAL)).toEqual(["a", "b"]);
    const ruSample = new Map([
      ["a", "Твоя карта"],
      ["b", "Ваша карта"],
    ]);
    expect(informal(ruSample, RU_INFORMAL)).toEqual(["a"]);
  });

  it("French addresses the reader formally", () => {
    expect(fr.size).toBeGreaterThan(10_000);
    expect(informal(fr, FR_INFORMAL, FR_NOT_ADDRESS)).toEqual([]);
  });

  it("every French exception still matches, so it is not stale", () => {
    for (const key of Object.keys(FR_NOT_ADDRESS)) {
      expect(FR_INFORMAL.test(fr.get(key) ?? ""), key).toBe(true);
    }
  });

  it("Russian addresses the reader formally", () => {
    expect(ru.size).toBeGreaterThan(10_000);
    expect(informal(ru, RU_INFORMAL)).toEqual([]);
  });
});

describe("missed is not skipped", () => {
  const missedKeys = [...en]
    .filter(
      ([key, value]) => DOSE_NAMESPACES.test(key) && /\bmissed\b/i.test(value),
    )
    .map(([key]) => key);

  it("finds the dose sentences that name a missed dose", () => {
    expect(missedKeys).toContain("medications.dose.state.missed");
    expect(missedKeys).toContain("medications.detail.overview.legend.missed");
    expect(missedKeys.length).toBeGreaterThanOrEqual(10);
  });

  it.each(["ru", "pl"] as const)("%s uses the missed word", (locale) => {
    const bundle = locale === "ru" ? ru : pl;
    const wrong = missedKeys.filter(
      (key) => !MISSED_WORD[locale].test(bundle.get(key) ?? ""),
    );
    expect(wrong).toEqual([]);
  });
});
