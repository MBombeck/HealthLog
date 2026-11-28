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
 * 7. a timeline lane is labelled with its concept's name;
 * 8. a short form (`short`, for a one-line heading, tile, chip or tab) is
 *    shorter than its name (a score's may repeat a name that is short already), names one thing in its locale, reuses no retired
 *    synonym, is what its `shortKey` carries in the bundle, and reaches a
 *    surface only through `metricName`;
 * 9. every metric name the web shows (`measurements.type*`) is a concept's
 *    name, anchored exactly.
 *
 * Rule 6 exists because an item form nothing checked drifted unseen: the
 * Korean illness item was 아픈 기간 while every illness message said
 * 에피소드, and the guard stayed green because the item had no anchor and
 * the loanword was not on the Korean retired list. A term the bundle never
 * uses is the same gap from the other side. Rule 7 exists because the Korean
 * medications lane carried the item 약 where every other lane carries its
 * area's name.
 *
 * Rule 8 exists because the short forms are shared with the iOS client: the
 * app shortens its one-line headings to the same words, so a short form the
 * web invents on its own, or one that drifts from the glossary, splits the
 * two clients' vocabulary as surely as a second name would.
 *
 * Rule 9 exists for the same reason one level up: the iOS client pins every
 * glossary name, and a metric outside the glossary had no shared name to pin,
 * so the app and the web named it apart (VO₂ max on one, Cardio fitness on
 * the other; one HRV for two different statistics).
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
} from "@/components/layout/nav-model";
import { locales } from "@/lib/i18n/config";
import glossary from "@/lib/i18n/glossary.json";
import {
  MEASUREMENT_TYPE_LABEL_KEYS,
  COMPOSITE_METRIC_LABEL_KEYS,
  MEASUREMENT_TYPE_SHORT_LABEL_KEYS,
} from "@/lib/measurements/type-label-keys";
import { HEALTHLOG_SCORE_IDS, HEALTHLOG_SCORES } from "@/lib/scores/registry";

import {
  readSource,
  readSourceText,
  scanSourceMatches,
} from "./helpers/source-files";

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
  terms: Record<
    string,
    { name: string | null; item?: string | null; short?: string }
  >;
  /** The message key that carries the short form (the name where none). */
  shortKey?: string;
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

/**
 * House style keeps the en and em dash, the middle dot and the arrow out of
 * visible copy; a range is written with a hyphen ("Pain (0-10)"). A term
 * reaches every surface that names the concept, so it is held here, with
 * the message values its anchors point at.
 */
const BANNED_MARKS = /[\u2013\u2014\u00b7\u2192]/u;

describe("punctuation", () => {
  it("can fail: the matcher sees each mark", () => {
    for (const mark of ["\u2013", "\u2014", "\u00b7", "\u2192"]) {
      expect(BANNED_MARKS.test(`Pain (0${mark}10)`)).toBe(true);
    }
    expect(BANNED_MARKS.test("Pain (0-10)")).toBe(false);
  });

  it.each(locales)(
    "%s: no term or anchored value carries a dash, dot or arrow",
    (locale) => {
      const offenders: string[] = [];
      let checked = 0;
      for (const concept of CONCEPTS) {
        const term = concept.terms[locale];
        if (!term) continue;
        for (const form of [term.name, term.item, term.short]) {
          if (!form) continue;
          checked += 1;
          if (BANNED_MARKS.test(form))
            offenders.push(`${concept.id}: "${form}"`);
        }
        for (const anchor of concept.anchors) {
          const text = bundles.get(locale)?.get(anchor.key);
          if (text === undefined) continue;
          checked += 1;
          if (BANNED_MARKS.test(text))
            offenders.push(`${anchor.key}: "${text}"`);
        }
      }
      expect(checked).toBeGreaterThan(100);
      expect(offenders).toEqual([]);
    },
  );
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
};

const RAIL = [...NAV_DESTINATIONS, ...NAV_ACCOUNT_MENU_DESTINATIONS];

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

/**
 * Every metric name, the full forms under `measurements.type<Type>` (and the
 * per-source score labels beside them), is a glossary concept's name.
 */
const METRIC_NAME_KEY = /^measurements\.type[A-Z]/;

describe("every metric is a concept", () => {
  it("anchors every measurements.type* key by name", () => {
    const metricKeys = [...bundles.get("en")!.keys()].filter((k) =>
      METRIC_NAME_KEY.test(k),
    );
    expect(metricKeys.length).toBeGreaterThan(100);
    const anchored = new Set(
      CONCEPTS.flatMap((c) =>
        c.anchors
          .filter((a) => a.form === "name" && a.match === "exact")
          .map((a) => a.key),
      ),
    );
    expect(metricKeys.filter((k) => !anchored.has(k))).toEqual([]);
  });
});

/**
 * Short forms. A concept with a `shortKey` has a short form in at least one
 * locale; every locale's bundle carries the short form under that key, or the
 * full name where the locale has none, so a surface that reads the key never
 * needs a fallback of its own.
 */
const SHORT_PREFIX = "measurements.shortType";

/** The word each locale's device-notification names carry. */
const NOTIFICATION_WORD: Record<string, RegExp> = {
  de: /hinweis|ereignis|meldung|warnung/iu,
  en: /notification|alert|event/iu,
  es: /aviso|alerta|notificación/iu,
  fr: /notification|alerte/iu,
  it: /notifica|avviso/iu,
  pl: /powiadomienie|alert/iu,
  ko: /알림/u,
  nl: /melding|waarschuwing/iu,
  "pt-BR": /notificação|alerta/iu,
  ru: /уведомление/iu,
};

/**
 * Phrases that read as a finding about the person, never a short form: a
 * tile or list row would state a diagnosis where the device only notified.
 */
const DIAGNOSIS_LIKE: Record<string, string[]> = {
  de: [
    "Unregelmäßiger Rhythmus",
    "Herzrhythmusstörung",
    "Vorhofflimmern",
    "Hoher Puls",
    "Niedriger Puls",
    "Tachykardie",
    "Bradykardie",
    "Bluthochdruck",
    "Niedrige Cardiofitness",
  ],
  en: [
    "Irregular rhythm",
    "Arrhythmia",
    "Atrial fibrillation",
    "High heart rate",
    "Low heart rate",
    "Tachycardia",
    "Bradycardia",
    "Hypertension",
    "Low cardio fitness",
  ],
  es: [
    "Ritmo irregular",
    "Arritmia",
    "Pulso alto",
    "Pulso bajo",
    "Hipertensión",
    "Baja forma cardiovascular",
  ],
  fr: ["Rythme irrégulier", "Arythmie", "Hypertension"],
  it: ["Ritmo irregolare", "Aritmia", "Ipertensione"],
  pl: ["Nieregularny rytm", "Arytmia", "Nadciśnienie"],
  ko: ["불규칙한 리듬", "부정맥", "고혈압"],
  nl: [
    "Onregelmatig ritme",
    "Hoge hartslag",
    "Lage hartslag",
    "Hoge bloeddruk",
    "Lage cardiofitheid",
  ],
  "pt-BR": ["Ritmo irregular", "Arritmia", "Hipertensão"],
  ru: ["Нерегулярный ритм", "Аритмия", "Гипертония"],
};
const SHORTENED = CONCEPTS.filter((c) => c.shortKey !== undefined);

/** The short keys of HealthLog's own scores, whose short form may be the name. */
const SCORE_SHORT_KEYS = new Set<string>(
  HEALTHLOG_SCORE_IDS.map((id) => {
    const metric = HEALTHLOG_SCORES[id].metric;
    return Object.hasOwn(COMPOSITE_METRIC_LABEL_KEYS, metric)
      ? COMPOSITE_METRIC_LABEL_KEYS[
          metric as keyof typeof COMPOSITE_METRIC_LABEL_KEYS
        ].short
      : (MEASUREMENT_TYPE_SHORT_LABEL_KEYS[
          metric as keyof typeof MEASUREMENT_TYPE_SHORT_LABEL_KEYS
        ] ?? "");
  }),
);

describe("short forms", () => {
  it("is shorter than the name, and only on a concept with a short key", () => {
    expect(SHORTENED.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const concept of CONCEPTS) {
      const shorts = locales.filter((l) => concept.terms[l]?.short);
      if (concept.shortKey && shorts.length === 0) {
        offenders.push(`${concept.id}: a short key but no short form`);
      }
      for (const locale of shorts) {
        const { name, short } = concept.terms[locale];
        if (!concept.shortKey) {
          offenders.push(`${concept.id}.${locale}: a short form, no short key`);
        }
        // A score's short form exists in every locale (the wire serves it
        // as `shortLabel`), so where the name is already short it repeats
        // the name; it is never longer.
        const tooLong = SCORE_SHORT_KEYS.has(concept.shortKey ?? "")
          ? short!.length > (name?.length ?? 0)
          : short!.length >= (name?.length ?? 0);
        if (!name || tooLong) {
          offenders.push(
            `${concept.id}.${locale}: "${short}" is not shorter than "${name}"`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(locales)("%s: a short form names one thing", (locale) => {
    const offenders: string[] = [];
    const fold = (s: string) => s.toLocaleLowerCase(locale);
    const retired = [
      ...CONCEPTS.flatMap((c) => c.forbidden[locale] ?? []),
      ...(SPELLING[locale]?.forbidden ?? []),
    ];
    for (const concept of CONCEPTS) {
      const short = concept.terms[locale]?.short;
      if (!short) continue;
      for (const other of CONCEPTS) {
        if (other === concept) continue;
        const { name, item, short: otherShort } = other.terms[locale] ?? {};
        for (const form of [name, item, otherShort]) {
          if (form && fold(form) === fold(short)) {
            offenders.push(
              `${concept.id}: "${short}" is also ${other.id}'s "${form}"`,
            );
          }
        }
      }
      for (const entry of retired) {
        // A short form lives at its short key, so a scoped entry holds there.
        if (
          inScope(entry, concept.shortKey ?? "") &&
          forbiddenPattern(entry).test(short)
        ) {
          offenders.push(
            `${concept.id}: "${short}" reuses the retired "${forbiddenText(entry)}"`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A device notification is a message from the device, not a finding. Its
   * name says so ("Irregular rhythm notification"); a short form that drops
   * that word turns the tile into a diagnosis ("Irregular rhythm"). So a
   * short form keeps the notification word its name carries, and none is a
   * bare finding from the denylist below, whatever its metric.
   */
  it.each(locales)(
    "%s: a short form keeps the notification word its name carries",
    (locale) => {
      const word = NOTIFICATION_WORD[locale];
      expect(word, `${locale}: no notification word`).toBeDefined();
      const offenders: string[] = [];
      let covered = 0;
      for (const concept of SHORTENED) {
        const { name, short } = concept.terms[locale] ?? {};
        if (!name || !word.test(name)) continue;
        covered += 1;
        if (short && !word.test(short)) {
          offenders.push(`${concept.id}: "${short}" drops it from "${name}"`);
        }
      }
      // Six device notifications carry a short key; a matcher that finds
      // none of their names proves nothing.
      expect(covered).toBeGreaterThanOrEqual(5);
      expect(offenders).toEqual([]);
    },
  );

  it.each(locales)("%s: no short form reads like a finding", (locale) => {
    const fold = (s: string) => s.toLocaleLowerCase(locale).trim();
    const denied = new Set((DIAGNOSIS_LIKE[locale] ?? []).map(fold));
    const offenders: string[] = [];
    for (const [key, text] of bundles.get(locale)!) {
      if (key.startsWith(SHORT_PREFIX) && denied.has(fold(text))) {
        offenders.push(`${key} = "${text}"`);
      }
    }
    for (const concept of SHORTENED) {
      const short = concept.terms[locale]?.short;
      if (short && denied.has(fold(short))) {
        offenders.push(`${concept.id}: "${short}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("can fail: the denylist catches the forms it was written for", () => {
    const fold = (s: string) => s.toLocaleLowerCase("de");
    expect(DIAGNOSIS_LIKE.de.map(fold)).toContain(
      fold("Unregelmäßiger Rhythmus"),
    );
    expect(NOTIFICATION_WORD.en.test("Irregular rhythm")).toBe(false);
    expect(NOTIFICATION_WORD.de.test("Rhythmus-Hinweis")).toBe(true);
  });

  it.each(locales)("%s: the short key carries the short form", (locale) => {
    const offenders: string[] = [];
    for (const concept of SHORTENED) {
      const term = concept.terms[locale];
      const want = term.short ?? term.name;
      const text = value(locale, concept.shortKey!);
      if (text !== want) {
        offenders.push(`${concept.shortKey} = "${text}", glossary "${want}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("knows every short key the bundle and the helper carry", () => {
    const glossaryKeys = SHORTENED.map((c) => c.shortKey!).sort();
    const bundleKeys = [...bundles.get("en")!.keys()]
      .filter((k) => k.startsWith(SHORT_PREFIX))
      .sort();
    expect(bundleKeys).toEqual(glossaryKeys);
    const helperKeys = [
      ...Object.values(MEASUREMENT_TYPE_SHORT_LABEL_KEYS),
      ...Object.values(COMPOSITE_METRIC_LABEL_KEYS).map((k) => k.short),
    ].sort();
    expect(helperKeys).toEqual(glossaryKeys);
    // A composite metric's short key belongs to the concept anchored on its
    // full name, the same pairing as the types below.
    for (const keys of Object.values(COMPOSITE_METRIC_LABEL_KEYS)) {
      const concept = SHORTENED.find((c) => c.shortKey === keys.short);
      expect(concept?.anchors.some((a) => a.key === keys.full)).toBe(true);
    }
    // The helper pairs each type's short key with the concept anchored on
    // that type's full name, so a short form cannot land on another metric.
    const misplaced: string[] = [];
    for (const [type, shortKey] of Object.entries(
      MEASUREMENT_TYPE_SHORT_LABEL_KEYS,
    )) {
      const fullKey =
        MEASUREMENT_TYPE_LABEL_KEYS[
          type as keyof typeof MEASUREMENT_TYPE_LABEL_KEYS
        ];
      const concept = SHORTENED.find((c) => c.shortKey === shortKey);
      if (!concept?.anchors.some((a) => a.key === fullKey)) {
        misplaced.push(`${type}: ${shortKey} is not the short of ${fullKey}`);
      }
    }
    expect(misplaced).toEqual([]);
  });

  it("reaches a surface only through metricName", () => {
    const matches = scanSourceMatches(
      join(ROOT, "src"),
      /["'`]measurements\.shortType/g,
      {
        fileFloor: 500,
        matchFloor: SHORTENED.length,
        include: (rel) =>
          !rel.includes("__tests__/") && !rel.startsWith("generated/"),
      },
    );
    const outside = matches
      .map((m) => `${m.file}:${m.line}`)
      .filter((at) => !at.startsWith("lib/measurements/type-label-keys.ts:"));
    expect(outside).toEqual([]);
  });
});
