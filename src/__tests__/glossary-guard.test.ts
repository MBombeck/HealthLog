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
 * 4. a page's title is its rail entry's label, in every locale.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NAV_ACCOUNT_MENU_DESTINATIONS,
  NAV_DESTINATIONS,
  NAV_UTILITY_DESTINATIONS,
} from "@/components/layout/nav-model";
import { locales } from "@/lib/i18n/config";
import glossary from "@/lib/i18n/glossary.json";

type Forbidden =
  string | { text: string; caseSensitive?: boolean; wholeWord?: boolean };

interface Concept {
  id: string;
  terms: Record<string, { name: string | null; item?: string | null }>;
  anchors: Array<{
    key: string;
    form: "name" | "item";
    match: "exact" | "contains";
  }>;
  forbidden: Record<string, Forbidden[]>;
}

interface Allow {
  locale: string;
  key: string;
  text: string;
  reason: string;
}

const CONCEPTS = glossary.concepts as unknown as Concept[];
const ALLOW = glossary.allow as unknown as Allow[];

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
      JSON.parse(
        readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"),
      ),
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
          if (!re.test(message)) continue;
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
        !forbiddenPattern(entry).test(message)
      ) {
        stale.push(`${a.locale} ${a.key} "${a.text}"`);
      }
    }
    expect(stale).toEqual([]);
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
    const missing: string[] = [];
    for (const [href, page] of Object.entries(PAGE_TITLES)) {
      if (!page) continue;
      const source = readFileSync(join(ROOT, page.file), "utf8");
      if (!source.includes(`t("${page.key}")`)) {
        missing.push(`${href}: ${page.file} does not render t("${page.key}")`);
      }
    }
    expect(missing).toEqual([]);
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
