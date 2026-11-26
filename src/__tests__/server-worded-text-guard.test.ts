import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { scanSourceMatches } from "./helpers/source-files";
import { locales, type Locale } from "@/lib/i18n/config";
import { allMessages } from "@/lib/i18n/shared-resolve";
import { resolveKey } from "@/lib/i18n/resolve-key";
import {
  generateAlertSpecs,
  localiseAlerts,
  type AlertKey,
} from "@/lib/analytics/health-alerts";

/**
 * Text the server words for a client goes through the message catalog.
 *
 * The insight cards, the overview's rule alerts and the target labels were
 * English sentences built in code, so an app running in German showed them in
 * English whatever language it asked for: they had no path to a language at
 * all. They are catalog entries now, worded per request in the reader's
 * language (`health-alerts.ts`, `targets/localise-labels.ts`,
 * `localiseEfficacyLabels`).
 *
 * This guard reads the response-building code of those surfaces and fails on
 * a display field (`label`, `title`, `message`, …) set to a literal that reads
 * as English words. A catalog key (`serverText.targetLabels.weight`) passes;
 * so does a token such as "BMI". The matcher is best effort: it sees object
 * fields written as literals, not a sentence assembled elsewhere and passed
 * in. The allowlist names each literal that is meant to stay, with why.
 */

const SRC = join(process.cwd(), "src");

/** The response-building code the sweep covers, relative to `src/`. */
const SWEPT: readonly RegExp[] = [
  /^app\/api\/insights\//,
  /^app\/api\/medications\/\[id\]\/efficacy\//,
  /^lib\/analytics\/health-alerts\.ts$/,
  /^lib\/targets\//,
  /^lib\/medications\/efficacy\//,
  /^lib\/insights\/comprehensive-overview\//,
];

const DISPLAY_FIELD =
  /\b(?:label|title|message|summary|headline|description|text|body|hint|caption|subtitle|detail)\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/g;

/**
 * Literals that stay English on purpose. Error envelopes are not display
 * text: a client keys its own wording off the error code beside them.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "app/api/insights/chat/fenced/route.ts": ["Invalid fenced chat request"],
  "app/api/insights/chat/[id]/attachments/route.ts": [
    "Invalid attachment request",
  ],
  "app/api/insights/layout/route.ts": [
    "Insights layout changed since it was loaded",
  ],
  "app/api/insights/provider-chains/route.ts": [
    "Invalid provider chains payload",
  ],
  "app/api/insights/provider-chain/route.ts": [
    "Invalid provider chain payload",
  ],
  "app/api/insights/feedback/route.ts": ["Invalid feedback payload"],
  "app/api/insights/generate/route.ts": [
    "Your data exceeds the AI payload size limit. Reduce the data window or exclude optional blocks in Settings > AI.",
    "Daily AI token budget reached. Insights will be available again tomorrow.",
    "AI response was cut off before the JSON completed. Raise the token limit (INSIGHTS_MAX_TOKENS)",
    "AI response did not contain a briefing that can be shown. Try regenerating.",
    "The generated insight did not pass the safety check and was discarded. Try regenerating.",
    "AI provider rate-limited the request",
    "AI provider connection failed. Check your AI settings",
    "AI response was not valid JSON",
    "Profile scope changed during insight generation",
    "Insight scope changed during generation",
  ],
};

const CATALOG_KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+$/;

/** A literal that reads as English words rather than a key or a token. */
function readsAsEnglish(literal: string): boolean {
  const text = literal.replace(/\$\{[^}]*\}/g, " ").trim();
  if (text === "" || CATALOG_KEY.test(text)) return false;
  return /^[A-Z][a-z]{2,}/.test(text) || /\b[a-z]{2,}\s+[a-z]{2,}\b/.test(text);
}

function isSwept(rel: string): boolean {
  if (rel.includes("__tests__") || /\.test\.tsx?$/.test(rel)) return false;
  return SWEPT.some((re) => re.test(rel));
}

function displayLiterals() {
  return scanSourceMatches(SRC, DISPLAY_FIELD, {
    fileFloor: 60,
    // The swept code holds the target label keys, the efficacy keys and the
    // allowlisted error envelopes at the least.
    matchFloor: 25,
    include: isSwept,
    stripComments: true,
  }).map((m) => {
    const inner = /:\s*(["'`])([\s\S]*)\1$/.exec(m.text);
    return { ...m, literal: inner?.[2] ?? "" };
  });
}

function messages(locale: Locale): Record<string, unknown> {
  return allMessages[locale] as Record<string, unknown>;
}

describe("server-worded text goes through the catalog", () => {
  it("no display field in the swept code is an English literal", () => {
    const offenders = displayLiterals()
      .filter((m) => readsAsEnglish(m.literal))
      .filter((m) => !(ALLOWED[m.file] ?? []).includes(m.literal))
      .map((m) => `${m.file}:${m.line}  ${m.text}`);
    expect(offenders).toEqual([]);
  });

  it("every allowlisted literal is still there", () => {
    const seen = new Set(
      displayLiterals().map((m) => `${m.file}|${m.literal}`),
    );
    const stale = Object.entries(ALLOWED).flatMap(([file, literals]) =>
      literals
        .filter((l) => !seen.has(`${file}|${l}`))
        .map((l) => `${file}: ${l}`),
    );
    expect(stale).toEqual([]);
  });

  it("every catalog key a swept display field names resolves in English", () => {
    const en = messages("en");
    // A literal under a catalog namespace; an error code (`feedback.body.invalid`)
    // has the same shape but names no namespace.
    const keys = displayLiterals()
      .map((m) => m.literal)
      .filter((l) => CATALOG_KEY.test(l) && l.split(".")[0]! in en);
    expect(keys.length).toBeGreaterThanOrEqual(11);
    const missing = keys.filter((k) => typeof resolveKey(en, k) !== "string");
    expect(missing).toEqual([]);
  });

  it("the matcher catches an English label and passes a key", () => {
    expect(readsAsEnglish("Weight")).toBe(true);
    expect(readsAsEnglish("Blood pressure on target")).toBe(true);
    expect(readsAsEnglish("Your BMI of ${bmi} is in the healthy range.")).toBe(
      true,
    );
    expect(readsAsEnglish("serverText.targetLabels.weight")).toBe(false);
    expect(readsAsEnglish("BMI")).toBe(false);
    expect(readsAsEnglish("")).toBe(false);
  });
});

describe("rule alerts are worded in every language", () => {
  const ALERT_KEYS: readonly AlertKey[] = [
    "bmiBelowNormal",
    "bmiOverweight",
    "bmiObesity",
    "bmiNormal",
    "bpSignificantlyElevated",
    "bpSlightlyElevated",
    "bpTargetGood",
    "bpTargetLow",
    "weightIncreasing",
    "weightDecreasing",
    "pulseOutliers",
    "complianceLow",
    "complianceExcellent",
  ];

  it.each(locales)(
    "%s carries a title and message for every alert",
    (locale) => {
      const bundle = messages(locale);
      const missing = ALERT_KEYS.flatMap((key) =>
        ["title", "message"]
          .map((part) => `serverText.alerts.${key}.${part}`)
          .filter((k) => typeof resolveKey(bundle, k) !== "string"),
      );
      expect(missing).toEqual([]);
    },
  );

  it("an alert reads in the reader's language, the band included", () => {
    const specs = generateAlertSpecs({
      bpAvgSys: 165.4,
      bpAvgDia: 101,
      weightSlope30: 0.1,
    });
    const [bp, weight] = localiseAlerts(specs, "de");
    expect(bp.title).toBe("Blutdruck deutlich erhöht");
    expect(bp.message).toContain("165,4/101");
    expect(bp.message).toContain("„Hypertonie Grad 2“");
    expect(weight.message).toContain("0,7 kg");

    const [bpEn] = localiseAlerts(specs, "en");
    expect(bpEn.message).toBe(
      'Your average blood pressure (165.4/101) is classified as "Hypertension Grade 2".',
    );
  });

  it("no placeholder is left unfilled in any language", () => {
    const specs = generateAlertSpecs({
      bmi: 31.2,
      bpAvgSys: 145,
      bpAvgDia: 92,
      bpPctInTarget: 40,
      weightSlope30: -0.2,
      pulseAnomalyCount: 5,
      medications: [
        { name: "Med A", compliance7: 60, compliance30: 70 },
        { name: "Med B", compliance7: 98, compliance30: 97 },
      ],
    });
    expect(specs.length).toBeGreaterThanOrEqual(7);
    for (const locale of locales) {
      for (const alert of localiseAlerts(specs, locale)) {
        expect(`${alert.title} ${alert.message}`).not.toMatch(
          /[{}]|serverText\./,
        );
      }
    }
  });
});
