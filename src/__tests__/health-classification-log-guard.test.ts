/**
 * No wide event names a health classification of a person.
 *
 * Two sweeps. The first covers every `annotate(...)` meta object in `src`:
 * a key that names a health classification (`HEALTH_CLASSIFICATION_KEY_PATTERNS`,
 * the same list the wide-event builder redacts by) fails unless its value is a
 * count or a flag, and in the record domains whose types and categories are
 * themselves the classification (allergies, illness, seizures, screenings,
 * vaccinations, visits, life events, side effects) a value read from one of
 * those properties fails whatever the key is called. The matchers are
 * whitespace-tolerant and floored on the number of calls and entries they
 * parse, so a parser that stops finding the meta objects fails instead of
 * passing empty.
 *
 * The second sweep, below, is the narrower and older one: reproductive state.
 *
 * Wide events land in the container log, in Loki and, for errors, in
 * GlitchTip. Every request event carries the user id, and on a one-person
 * instance even a cron tick without one is attributable. Reproductive health
 * is the most sensitive class the app holds, so the cycle surfaces annotate
 * sizes and flags only, never the state itself: whether a period is late, the
 * forecast's state, the cycle's regularity, a phase, or the pregnancy that
 * explains a vital-sign shift. Each of those once rode a `meta` field.
 *
 * The sweep covers every file under the cycle routes and the cycle library,
 * and every file that reads the vital-shift context or the pregnancy store.
 * It reads each `annotate(...)` argument with its string literals blanked (so
 * an action name may say "explained") and fails on an expression that
 * carries one of the states. It has floors on files and calls, so a matcher
 * that finds nothing fails instead of passing empty.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  HEALTH_CLASSIFICATION_KEY_PATTERNS,
  isHealthClassificationKey,
} from "@/lib/observability/redact-payload";

import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Expressions whose value is a reproductive state. */
const STATE_EXPRESSIONS: readonly RegExp[] = [
  /\bverdict\.state\b/,
  /\bprojectionState\b/,
  /\bregularity\b/,
  /\.phase\b/,
  /\bphase\s*[,}]/,
  /\bvitalShiftContext\b/,
  /\bexplained\b/,
  /\bpregnancy\.(?:state|status)\b/,
  /\bpredictionsPaused\b/,
  /\boverdue(?:Days)?\b/,
];

const READS_STATE =
  /\b(?:vitalShiftContext|pregnancy-store|toCyclePregnancyDTO)\b/;

function blankStrings(source: string): string {
  return source.replace(
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    '""',
  );
}

/** The text between the parentheses of every `annotate(` call. */
function annotateArguments(source: string): string[] {
  const out: string[] = [];
  const opener = /\bannotate\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

describe("reproductive state in wide events", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/") && !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .filter((p) => {
      if (p.startsWith("app/api/cycle/") || p.startsWith("lib/cycle/")) {
        return true;
      }
      return READS_STATE.test(stripComments(readSourceText(join(SRC, p))));
    });

  const calls = files.flatMap((p) =>
    annotateArguments(
      blankStrings(stripComments(readSourceText(join(SRC, p)))),
    ).map((args) => ({ file: p, args })),
  );

  it("are swept", () => {
    requireFloor("cycle and pregnancy files", files, 20);
    requireFloor("annotate calls in them", calls, 20);
    expect(files).toContain("lib/jobs/measurement-anomaly-check.ts");
  });

  it("carry no state", () => {
    const offenders = calls
      .filter(({ args }) => STATE_EXPRESSIONS.some((re) => re.test(args)))
      .map(({ file, args }) => `${file}: annotate(${args.trim()})`);
    expect(offenders).toEqual([]);
  });
});

/** The text between the braces of a literal `meta: { ... }` in `args`. */
function metaObjects(args: string): string[] {
  const out: string[] = [];
  const opener = /\bmeta\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(args)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < args.length && depth > 0; i++) {
      const ch = args[i];
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    out.push(args.slice(start, i - 1));
  }
  return out;
}

/** The top-level `key: value` entries of an object body (shorthand included). */
function entries(body: string): { key: string; value: string }[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  const out: { key: string; value: string }[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (part === "" || part.startsWith("...")) continue;
    const keyed =
      /^(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(part);
    if (keyed) {
      out.push({
        key: keyed[1] ?? keyed[2] ?? keyed[3],
        value: keyed[4].trim(),
      });
    } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
      out.push({ key: part, value: part });
    }
  }
  return out;
}

/**
 * A value that is a count, a flag, or a choice between fixed literals rather
 * than the class itself (`x ? "catalog" : y ? "custom" : "free-text"`; string
 * literals are blanked to `""` by then).
 */
const COUNT_OR_FLAG =
  /\.(?:length|size)\b|^\d+$|^(?:true|false)$|\bBoolean\(|[!=]==?|\?\?\s*0$|\bNumber\(|^[^?:]+\?\s*""\s*:\s*(?:[^?:]+\?\s*""\s*:\s*)*""$/;

/** Record domains whose type and category fields are the classification. */
const CLASSIFIED_DOMAINS =
  /^(?:app\/api|lib)\/(?:allerg|illness|seizure|mental-health|vaccination|encounter|life-event|symptom|medications\/\[id\]\/side-effects)/;

/** Properties that hold the classification in those domains, and anywhere. */
const CLASSIFIED_PROPERTY =
  /\.(?:category|type|lifecycle|severity|ilaeType|antigenSlug|instrument|classification)\b/;
const CLASSIFIED_KEY = /^(?:category|type|kind|lifecycle|severity|entry)$/i;
const CLASSIFIED_PROPERTY_ANYWHERE =
  /\.(?:ilaeType|illnessType|antigenSlug|recommendationSeverity|hasDiabetes|classification)\b/;

describe("health classifications in wide events", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/") && !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p));

  const calls = files.flatMap((p) =>
    annotateArguments(
      blankStrings(stripComments(readSourceText(join(SRC, p)))),
    ).map((args) => ({ file: p, args })),
  );

  // Keys keep their spelling: strings are blanked only inside values.
  const metaEntries = files.flatMap((p) =>
    annotateArguments(stripComments(readSourceText(join(SRC, p)))).flatMap(
      (args) =>
        metaObjects(args).flatMap((body) =>
          entries(blankStrings(body)).map((e) => ({ file: p, ...e })),
        ),
    ),
  );
  const rawKeys = new Set(
    files.flatMap((p) =>
      annotateArguments(stripComments(readSourceText(join(SRC, p)))).flatMap(
        (args) =>
          metaObjects(args).flatMap((body) => entries(body).map((e) => e.key)),
      ),
    ),
  );

  it("are swept", () => {
    requireFloor("annotate calls in src", calls, 1000);
    requireFloor("meta entries in them", metaEntries, 1500);
    requireFloor(
      "entries in the classified domains",
      metaEntries.filter((e) => CLASSIFIED_DOMAINS.test(e.file)),
      20,
    );
    // The parser reads quoted, multi-line and shorthand keys.
    expect(rawKeys).toContain("allergy_count");
    expect(rawKeys).toContain("web_vitals.name");
    expect(rawKeys).toContain("moodEntryId");
    expect(HEALTH_CLASSIFICATION_KEY_PATTERNS.length).toBeGreaterThan(10);
  });

  it("the key list recognises the classes it is meant to", () => {
    for (const key of [
      "illness_type",
      "illnessType",
      "allergy_category",
      "ilae_type",
      "symptoms",
      "mood",
      "condition",
      "medication_class",
      "analyte",
      "antigen_slug",
      "instrument",
      "item9_flagged",
      "classification",
      "cycle_phase",
      "verdict_state",
      "hasDiabetes",
    ]) {
      expect(isHealthClassificationKey(key), key).toBe(true);
    }
    for (const key of [
      "allergy_count",
      "symptom_patterns",
      "moodEntryId",
      "mood_context",
      "antigen_source",
      "conditions_readable",
      "status",
      "kind",
    ]) {
      expect(isHealthClassificationKey(key), key).toBe(false);
    }
  });

  it("carry no classification under a classifying key", () => {
    const offenders = metaEntries
      .filter((e) => isHealthClassificationKey(e.key))
      .filter((e) => !COUNT_OR_FLAG.test(e.value))
      .map((e) => `${e.file}: ${e.key}: ${e.value}`);
    expect(offenders).toEqual([]);
  });

  it("read no classifying property into meta", () => {
    const offenders = metaEntries
      .filter((e) => !COUNT_OR_FLAG.test(e.value))
      .filter(
        (e) =>
          CLASSIFIED_PROPERTY_ANYWHERE.test(e.value) ||
          (CLASSIFIED_DOMAINS.test(e.file) &&
            (CLASSIFIED_PROPERTY.test(e.value) || CLASSIFIED_KEY.test(e.key))),
      )
      .map((e) => `${e.file}: ${e.key}: ${e.value}`);
    expect(offenders).toEqual([]);
  });
});
