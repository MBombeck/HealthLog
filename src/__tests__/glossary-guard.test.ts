/**
 * One thing, one name: the glossary guard.
 *
 * The same concept used to go by several names, sometimes on one screen: the
 * preventive-care area was "Care" in the rail, "Checkup reminder" in a push
 * and "Measurement reminder" in the notification settings; the illness area
 * was "Illness", "Illness journal", "Illness diary" and "Conditions"; the PDF
 * a person hands their doctor said "Health Report" while every button that
 * made it said "Doctor report". Each name was reasonable on its own and the
 * set was not, because nothing held them together.
 *
 * `src/lib/i18n/glossary.json` is that set: one term per concept per locale,
 * the message keys that must carry it, and the retired synonyms. This guard
 * reads it against every bundle:
 *
 * 1. the glossary is complete (every concept has a term in every locale);
 * 2. every anchor key carries its concept's term;
 * 3. no message value uses a retired synonym, except the few the glossary's
 *    `allow` list names with a reason (and an allow entry that no longer
 *    matches anything fails, so the list cannot outlive its cause);
 * 4. a page's title is its rail entry's label, in every locale;
 * 5. no message uses a spelling the glossary's `spelling` block retires;
 * 6. every `item` form is anchored at least once (or the concept says why it
 *    cannot be), and every term occurs in its locale's bundle;
 * 7. a timeline lane is labelled with its concept's name.
 *
 * Rule 6 exists because an item form nothing checked drifted unseen: the
 * Korean illness item was 아픈 기간 while every illness message said
 * 에피소드, and the guard stayed green because the item had no anchor and
 * the loanword was not on the Korean retired list. A term the bundle never
 * uses is the same gap from the other side. Rule 7 exists because the Korean
 * medications lane carried the item 약 where every other lane carries its
 * area's name.
 *
 * A forbidden entry with `keys` holds only under that key prefix: "Eintrag"
 * is the right word for a mood entry and the wrong one for an illness
 * episode.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NAV_ACCOUNT_MENU_DESTINATIONS,
  NAV_DESTINATIONS,
  NAV_UTILITY_DESTINATIONS,
} from "@/components/layout/nav-model";
import { locales } from "@/lib/i18n/config";
import glossary from "@/lib/i18n/glossary.json";

import { readSource, readSourceText } from "./helpers/source-files";

type Forbidden =
  | string
  | {
      text: string;
      caseSensitive?: boolean;
      wholeWord?: boolean;
      keys?: string;
    };

interface Concept {
  id: string;
  terms: Record<string, { name: string | null; item?: string | null }>;
  anchors: Array<{
    key: string;
    form: "name" | "item";
    match: "exact" | "contains";
  }>;
  forbidden: Record<string, Forbidden[]>;
  itemUnanchored?: string;
}

interface Allow {
  locale: string;
  key: string;
  text: string;
  reason: string;
}

const CONCEPTS = glossary.concepts as unknown as Concept[];
const ALLOW = glossary.allow as unknown as Allow[];
const SPELLING = glossary.spelling as unknown as Record<
  string,
  { decision: string; forbidden: Forbidden[] }
>;

const ROOT = join(__dirname, "../..");

function flatten(
  obj: unknown,
  prefix: string,
  out: Map<string, string>,
): Map<string, string> {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (typeof v === "object") flatten(v, key, out);
  }
  return out;
}

const bundles = new Map(
  locales.map((locale) => [
    locale as string,
    flatten(
      JSON.parse(readSourceText(join(ROOT, "messages", `${locale}.json`))),
      "",
      new Map(),
    ),
  ]),
);

function value(locale: string, key: string): string {
  const found = bundles.get(locale)?.get(key);
  if (found === undefined) throw new Error(`${locale}: ${key} is missing`);
  return found;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A retired term matches at the start of a word, so its inflections
 * ("appointments", "Krankheitstagebuchs") match too, and a longer word that
 * merely ends in it does not. `wholeWord` also pins the end; `caseSensitive`
 * keeps a German noun from matching the verb spelled the same in lower case.
 */
function forbiddenPattern(entry: Forbidden): RegExp {
  const { text, caseSensitive, wholeWord } =
    typeof entry === "string" ? { text: entry } : entry;
  const body = escape(text).replace(/ /g, "\\s+");
  const tail = wholeWord ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${body}${tail}`,
    caseSensitive ? "u" : "iu",
  );
}

const forbiddenText = (entry: Forbidden) =>
  typeof entry === "string" ? entry : entry.text;

/** Whether a forbidden entry applies to this message key at all. */
const inScope = (entry: Forbidden, key: string) =>
  typeof entry === "string" || !entry.keys || key.startsWith(entry.keys);

/** First letter folded: a label may open a sentence or sit inside one. */
const sameTerm = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0 ||
  a.slice(1) === b.slice(1);

describe("glossary", () => {
  it("names every concept once, in every locale", () => {
    const ids = CONCEPTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(glossary.locales).toEqual([...locales]);
    const gaps: string[] = [];
    for (const concept of CONCEPTS) {
      for (const locale of locales) {
        const term = concept.terms[locale];
        if (!term?.name) gaps.push(`${concept.id}.${locale}.name`);
        if (concept.terms.en.item && !term?.item) {
          gaps.push(`${concept.id}.${locale}.item`);
        }
        if (!Array.isArray(concept.forbidden[locale])) {
          gaps.push(`${concept.id}.${locale}.forbidden`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it("never retires a concept's own term", () => {
    const clashes: string[] = [];
    for (const concept of CONCEPTS) {
      for (const locale of locales) {
        const term = concept.terms[locale];
        for (const entry of concept.forbidden[locale] ?? []) {
          const re = forbiddenPattern(entry);
          for (const form of [term.name, term.item]) {
            if (form && re.test(form)) {
              clashes.push(
                `${concept.id}.${locale}: "${forbiddenText(entry)}" matches "${form}"`,
              );
            }
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("anchors every item form, or says why it cannot", () => {
    const loose = CONCEPTS.filter(
      (c) =>
        c.terms.en.item &&
        !c.anchors.some((a) => a.form === "item") &&
        (c.itemUnanchored ?? "").length < 20,
    ).map((c) => c.id);
    expect(loose).toEqual([]);
    const needless = CONCEPTS.filter(
      (c) => c.itemUnanchored && c.anchors.some((a) => a.form === "item"),
    ).map((c) => c.id);
    expect(needless).toEqual([]);
  });

  it.each(locales)("%s: every term occurs in the bundle", (locale) => {
    const messages = [...bundles.get(locale)!.values()].map((m) =>
      m.toLocaleLowerCase(locale),
    );
    const unused: string[] = [];
    for (const concept of CONCEPTS) {
      for (const form of ["name", "item"] as const) {
        const term = concept.terms[locale]?.[form];
        if (!term) continue;
        const needle = term.toLocaleLowerCase(locale);
        if (!messages.some((m) => m.includes(needle))) {
          unused.push(`${concept.id}.${form} "${term}"`);
        }
      }
    }
    expect(unused).toEqual([]);
  });

  it.each(locales)("%s: every anchor carries its term", (locale) => {
    const offenders: string[] = [];
    for (const concept of CONCEPTS) {
      for (const anchor of concept.anchors) {
        const term = concept.terms[locale]?.[anchor.form];
        const text = value(locale, anchor.key);
        if (!term) continue;
        const ok =
          anchor.match === "exact"
            ? sameTerm(text, term)
            : text
                .toLocaleLowerCase(locale)
                .includes(term.toLocaleLowerCase(locale));
        if (!ok) {
          offenders.push(
            `${anchor.key} = "${text}" should ${anchor.match === "exact" ? "be" : "contain"} "${term}" (${concept.id})`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(locales)("%s: no retired synonym in any message", (locale) => {
    const offenders: string[] = [];
    const entries = [...bundles.get(locale)!.entries()];
    expect(entries.length).toBeGreaterThan(5000);
    for (const concept of CONCEPTS) {
      for (const entry of concept.forbidden[locale] ?? []) {
        const re = forbiddenPattern(entry);
        const text = forbiddenText(entry);
        for (const [key, message] of entries) {
          if (!inScope(entry, key) || !re.test(message)) continue;
          const allowed = ALLOW.some(
            (a) => a.locale === locale && a.key === key && a.text === text,
          );
          if (!allowed) {
            offenders.push(`${key}: "${text}" (${concept.id}) in "${message}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("allows nothing it does not need", () => {
    const stale: string[] = [];
    for (const a of ALLOW) {
      expect(a.reason.length, `${a.locale} ${a.key}`).toBeGreaterThan(10);
      const entry = CONCEPTS.flatMap((c) => c.forbidden[a.locale] ?? []).find(
        (f) => forbiddenText(f) === a.text,
      );
      const message = bundles.get(a.locale)?.get(a.key);
      if (
        !entry ||
        message === undefined ||
        !inScope(entry, a.key) ||
        !forbiddenPattern(entry).test(message)
      ) {
        stale.push(`${a.locale} ${a.key} "${a.text}"`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe("spelling", () => {
  it("states why for every locale it settles", () => {
    for (const [locale, rule] of Object.entries(SPELLING)) {
      expect(locales as readonly string[]).toContain(locale);
      expect(rule.decision.length, locale).toBeGreaterThan(20);
      expect(rule.forbidden.length, locale).toBeGreaterThan(0);
    }
  });

  it.each(Object.keys(SPELLING))("%s: no retired spelling", (locale) => {
    const offenders: string[] = [];
    for (const [key, message] of bundles.get(locale)!) {
      // A placeholder name is code, not copy.
      const copy = message.replace(/\{[^{}\s,]+/g, "{");
      for (const entry of SPELLING[locale].forbidden) {
        if (inScope(entry, key) && forbiddenPattern(entry).test(copy)) {
          offenders.push(`${key}: "${forbiddenText(entry)}" in "${message}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Where each rail entry's page renders its title: the file and the key. The
 * dashboard, Insights and the Coach open on a greeting or a conversation
 * rather than a title, so they have none to match.
 */
const PAGE_TITLES: Record<string, { file: string; key: string } | null> = {
  "/": null,
  "/insights": null,
  "/coach": null,
  "/measurements": {
    file: "src/app/measurements/page.tsx",
    key: "measurements.title",
  },
  "/medications": {
    file: "src/app/medications/page-client.tsx",
    key: "medications.title",
  },
  "/mood": { file: "src/app/mood/page-client.tsx", key: "mood.title" },
  "/mental-wellbeing": {
    file: "src/components/mental-health/mental-wellbeing.tsx",
    key: "mentalHealth.pageTitle",
  },
  "/cycle": { file: "src/components/cycle/cycle-view.tsx", key: "cycle.title" },
  "/care": {
    file: "src/components/measurement-reminders/vorsorge-section.tsx",
    key: "measurementReminders.sectionTitle",
  },
  "/labs": { file: "src/app/labs/page.tsx", key: "labs.title" },
  "/profile": {
    file: "src/components/records/profile-summary.tsx",
    key: "settings.sections.anamnesis.title",
  },
  "/illness": {
    file: "src/components/illness/illness-view.tsx",
    key: "illness.title",
  },
  "/seizures": {
    file: "src/components/seizures/seizures-view.tsx",
    key: "seizures.title",
  },
  "/vaccinations": {
    file: "src/components/vaccinations/vaccinations-view.tsx",
    key: "vaccinations.title",
  },
  "/documents": {
    file: "src/components/documents/documents-view.tsx",
    key: "documents.title",
  },
  "/timeline": {
    file: "src/components/timeline/timeline-view.tsx",
    key: "timeline.title",
  },
  "/achievements": {
    file: "src/app/achievements/page.tsx",
    key: "achievements.title",
  },
  "/emergency-card": {
    file: "src/components/emergency-card/emergency-card-page.tsx",
    key: "emergencyCard.page.title",
  },
  "/notifications": {
    file: "src/app/notifications/page.tsx",
    key: "notifications.title",
  },
};

const RAIL = [
  ...NAV_DESTINATIONS,
  ...NAV_ACCOUNT_MENU_DESTINATIONS,
  ...NAV_UTILITY_DESTINATIONS.filter((d) => d.href === "/notifications"),
];

describe("a page is titled what its rail entry says", () => {
  it("knows every rail destination", () => {
    expect(RAIL.map((d) => d.href).sort()).toEqual(
      Object.keys(PAGE_TITLES).sort(),
    );
  });

  it("finds each title key where the page renders it", () => {
    for (const page of Object.values(PAGE_TITLES)) {
      // Throws, naming the file, when the page no longer renders the key.
      if (page) readSource(page.file, `t("${page.key}")`);
    }
  });

  it.each(locales)("%s: nav label equals page title", (locale) => {
    const mismatches: string[] = [];
    for (const d of RAIL) {
      const page = PAGE_TITLES[d.href];
      if (!page) continue;
      const nav = value(locale, d.tKey);
      const title = value(locale, page.key);
      if (nav !== title) {
        mismatches.push(`${d.href}: nav "${nav}" vs page "${title}"`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

/**
 * Timeline lanes that name no glossary concept, and why. Every other lane is
 * labelled with its concept's `name`, like a rail entry.
 */
const LANES_WITHOUT_CONCEPT: Record<string, string> = {
  life: "Life events have no area of their own to name.",
  allergies: "Allergies live in the medical history, not an area.",
  visits: "The lane holds visits and procedures, wider than the visit term.",
  seizures: "The lane plots single seizures, not the seizure diary area.",
};

describe("a timeline lane is named like its area", () => {
  it("anchors every lane by name, or says why not", () => {
    const lanes = [...bundles.get("en")!.keys()]
      .filter((k) => k.startsWith("timeline.lanes."))
      .map((k) => k.slice("timeline.lanes.".length));
    expect(lanes.length).toBeGreaterThan(5);
    const anchored = new Set(
      CONCEPTS.flatMap((c) =>
        c.anchors
          .filter((a) => a.form === "name" && a.match === "exact")
          .map((a) => a.key),
      ),
    );
    const loose = lanes.filter(
      (lane) =>
        !anchored.has(`timeline.lanes.${lane}`) &&
        !(lane in LANES_WITHOUT_CONCEPT),
    );
    expect(loose).toEqual([]);
    const stale = Object.keys(LANES_WITHOUT_CONCEPT).filter(
      (lane) => !lanes.includes(lane) || anchored.has(`timeline.lanes.${lane}`),
    );
    expect(stale).toEqual([]);
  });
});
