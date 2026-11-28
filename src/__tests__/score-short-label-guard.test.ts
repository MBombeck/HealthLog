/**
 * One short name per score, from one source, on every score payload.
 *
 * A score's short name ("Bereitschaft", "Schlafscore", "Gesundheit",
 * "Erholung", "Stress", "Belastung") is what a tile, a chip or a one-line
 * header shows. The web and the iOS app both draw those tiles, so the words
 * come from the server: the glossary's `short` form, read through the score
 * registry (`scoreShortLabel`), served as `shortLabel` beside the score. A
 * client that shortens a name on its own splits the two clients' vocabulary
 * as surely as a second name would.
 *
 * Two halves, each held here:
 *
 * 1. Every HealthLog score names a glossary concept through its registry
 *    metric, and that concept has a `short` form in every locale.
 * 2. Every score payload schema in the built OpenAPI document declares
 *    `shortLabel`. The carriers are named below, and a sweep finds every
 *    object that carries a `score` beside a `band`: such an object is either
 *    a named carrier or listed as exempt with the reason, so a new score
 *    payload cannot appear without a decision about its short name.
 *
 * ## Mutation check
 *
 * Drop `shortLabel` from one carrier's registry declaration and the presence
 * assertion names it. Drop a locale's `short` from a score concept and the
 * glossary half names it. Add a new `{ score, band }` object to the registry
 * and the sweep fails until it is a carrier or exempt. A walk that matches
 * nothing fails on its own count.
 */
import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import glossary from "@/lib/i18n/glossary.json";
import {
  COMPOSITE_METRIC_LABEL_KEYS,
  MEASUREMENT_TYPE_SHORT_LABEL_KEYS,
} from "@/lib/measurements/type-label-keys";
import { buildOpenApiDocument } from "@/lib/openapi/registry";
import { HEALTHLOG_SCORE_IDS, HEALTHLOG_SCORES } from "@/lib/scores/registry";

interface Concept {
  id: string;
  shortKey?: string;
  terms: Record<string, { name: string | null; short?: string }>;
}

type Schema = {
  properties?: Record<string, Schema>;
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  $ref?: string;
};

const CONCEPTS = glossary.concepts as unknown as Concept[];

/** The glossary short key a score's registry metric resolves to. */
function shortKeyOf(metric: string): string | undefined {
  if (Object.hasOwn(COMPOSITE_METRIC_LABEL_KEYS, metric)) {
    return COMPOSITE_METRIC_LABEL_KEYS[
      metric as keyof typeof COMPOSITE_METRIC_LABEL_KEYS
    ].short;
  }
  return MEASUREMENT_TYPE_SHORT_LABEL_KEYS[
    metric as keyof typeof MEASUREMENT_TYPE_SHORT_LABEL_KEYS
  ];
}

describe("every score concept has a short form", () => {
  const resolved = HEALTHLOG_SCORE_IDS.map((id) => {
    const key = shortKeyOf(HEALTHLOG_SCORES[id].metric);
    return {
      id,
      key,
      concept: CONCEPTS.find((c) => key && c.shortKey === key),
    };
  });

  it("resolves every score to a glossary concept", () => {
    expect(resolved.length).toBe(6);
    const missing = resolved
      .filter((r) => !r.concept)
      .map((r) => `${r.id}: short key ${r.key ?? "none"}`);
    expect(missing).toEqual([]);
    // Six scores, six concepts: no two scores share a name.
    expect(new Set(resolved.map((r) => r.concept?.id)).size).toBe(6);
  });

  it.each(locales)("%s: every score concept carries a short", (locale) => {
    const missing = resolved
      .filter((r) => !r.concept?.terms[locale]?.short)
      .map((r) => `${r.concept?.id ?? r.id}.${locale}`);
    expect(missing).toEqual([]);
  });
});

const doc = buildOpenApiDocument() as unknown as {
  components: { schemas: Record<string, Schema> };
};
const SCHEMAS = doc.components.schemas;

/**
 * The score payloads, as paths under `components.schemas`. An `anyOf` (a
 * nullable block) is looked through to its object branch.
 */
const CARRIERS = [
  "DerivedMetricResponse",
  "HealthScoreReport",
  "ScoreHistoryResponse",
  "DailyMorningScore",
  "DailyDigest.score",
  "DashboardSnapshotResponse.healthScore",
  "DashboardSnapshotResponse.scoreRings.items",
] as const;

/**
 * Objects with a `score` and a `band` that are not a score payload of their
 * own, each with the reason.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  DerivedConfidence: "the confidence in a value, not a score",
  "DerivedHealthScoreComposite.value":
    "the composite inside HealthScoreReport, which carries it",
  "DerivedScorePillarValue.value": "one pillar of the Health score",
  "MoodAggregates.stability": "the mood stability statistic",
  "IllnessCorrelationResponse.confidence":
    "the confidence in a correlation, not a score",
  DailyMorningRing: "the ring of a DailyMorningScore, which carries it",
  WellnessScoreValue:
    "the value inside DerivedMetricResponse, which carries it",
  SleepScoreValue: "the value inside DerivedMetricResponse, which carries it",
  ReadinessValue: "the value inside DerivedMetricResponse, which carries it",
};

/** The object branch of a schema, looking through a nullable union. */
function objectOf(schema: Schema | undefined): Schema | undefined {
  if (!schema) return undefined;
  if (schema.properties) return schema;
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const found = objectOf(branch);
    if (found) return found;
  }
  if (schema.$ref) {
    return objectOf(SCHEMAS[schema.$ref.replace("#/components/schemas/", "")]);
  }
  return undefined;
}

/** The array branch of a schema, looking through a nullable union. */
function arrayOf(schema: Schema | undefined): Schema | undefined {
  if (!schema) return undefined;
  if (schema.items) return schema;
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const found = arrayOf(branch);
    if (found) return found;
  }
  return undefined;
}

function resolvePath(path: string): Schema | undefined {
  const [head, ...rest] = path.split(".");
  let node: Schema | undefined = SCHEMAS[head];
  for (const part of rest) {
    node =
      part === "items"
        ? arrayOf(node)?.items
        : objectOf(node)?.properties?.[part];
  }
  return objectOf(node);
}

/** Every object with a `score` beside a `band`, by its dotted path. */
function scoreBandObjects(): string[] {
  const found: string[] = [];
  const visit = (node: Schema | undefined, path: string): void => {
    if (!node || typeof node !== "object") return;
    if (node.properties?.score && node.properties.band) found.push(path);
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      visit(child, `${path}.${key}`);
    }
    if (node.items) visit(node.items, `${path}.items`);
    for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
      visit(branch, path);
    }
  };
  for (const [name, schema] of Object.entries(SCHEMAS)) visit(schema, name);
  return [...new Set(found)];
}

describe("every score payload carries shortLabel", () => {
  it("finds every named carrier", () => {
    const unresolved = CARRIERS.filter((path) => !resolvePath(path));
    expect(unresolved).toEqual([]);
  });

  it("declares shortLabel on each", () => {
    const carriers = CARRIERS.map((path) => ({
      path,
      schema: resolvePath(path),
    })).filter((c) => c.schema);
    // A walk that matches nothing proves nothing.
    expect(carriers.length).toBe(CARRIERS.length);
    const missing = carriers
      .filter((c) => !c.schema?.properties?.shortLabel)
      .map((c) => c.path);
    expect(missing).toEqual([]);
  });

  it("knows every object with a score and a band", () => {
    const found = scoreBandObjects();
    expect(found.length).toBeGreaterThanOrEqual(5);
    const carriers = new Set<string>(CARRIERS);
    const unknown = found.filter((p) => !carriers.has(p) && !(p in EXEMPT));
    expect(unknown).toEqual([]);
    // An exemption that no longer matches anything is stale.
    const stale = Object.keys(EXEMPT).filter((p) => !found.includes(p));
    expect(stale).toEqual([]);
  });
});
