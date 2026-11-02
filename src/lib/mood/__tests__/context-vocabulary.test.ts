/**
 * Pair guard binding `context-vocabulary.ts` to the six locale bundles.
 *
 * The generic i18n guards cannot carry this one. `contextValueLabelKey` builds
 * its keys from a template with a literal `mood.context.` prefix, so the
 * reverse-coverage matcher records the whole subtree as reachable and stops
 * being able to tell a live label from a stale one — the exact degradation
 * that file's own doc comment warns about, arriving here by construction
 * rather than by accident. So the check that matters is written here, against
 * the arrays themselves, in both directions:
 *
 *   * every key the vocabulary names has a non-empty label in all six locales;
 *   * every label under those groups belongs to a key the vocabulary names.
 *
 * The second direction is the one that catches a value removed from the
 * vocabulary whose translations were left behind, and the first is the one
 * that catches a value added without them.
 *
 * Mutation check: drop `"garden"` from `LEISURE_CATEGORY_KEYS` and the orphan
 * assertion goes red naming it in all six bundles; delete
 * `mood.context.eventType.conflict` from `messages/pl.json` and the coverage
 * assertion goes red naming pl.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTACT_CIRCLE_KEYS,
  CONTACT_EXTENT_KEYS,
  CONTACT_FORM_KEYS,
  CONTEXT_SECTION_KEYS,
  EVENT_TYPE_KEYS,
  LEISURE_CATEGORY_KEYS,
  WORK_STATUS_KEYS,
  CONTEXT_RATING_FIELDS,
  contextSectionLabelKey,
  contextValueLabelKey,
} from "@/lib/mood/context-vocabulary";

const MESSAGES = join(__dirname, "../../../../messages");
const LOCALES = readdirSync(MESSAGES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(MESSAGES, `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

function resolve(root: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      root,
    );
}

/** The value groups whose members come straight from a vocabulary array. */
const VALUE_GROUPS: Array<{ group: string; keys: readonly string[] }> = [
  { group: "workStatus", keys: WORK_STATUS_KEYS },
  { group: "contactCircles", keys: CONTACT_CIRCLE_KEYS },
  { group: "contactForm", keys: CONTACT_FORM_KEYS },
  { group: "contactExtent", keys: CONTACT_EXTENT_KEYS },
  { group: "leisureCategories", keys: LEISURE_CATEGORY_KEYS },
  { group: "eventType", keys: EVENT_TYPE_KEYS },
];

describe("mood context vocabulary labels", () => {
  it("reads ten locales and a non-empty vocabulary", () => {
    // Both ends have to be there before anything below proves anything. A
    // guard that walks an empty list is a green light nobody earned.
    expect(LOCALES.length).toBe(10);
    expect(VALUE_GROUPS.length).toBeGreaterThan(0);
    const total = VALUE_GROUPS.reduce((n, g) => n + g.keys.length, 0);
    expect(total).toBeGreaterThan(30);
    expect(CONTEXT_RATING_FIELDS.length).toBeGreaterThan(0);
  });

  for (const locale of LOCALES) {
    it(`${locale} carries a label for every vocabulary value`, () => {
      const root = bundle(locale);
      const missing: string[] = [];

      for (const { group, keys } of VALUE_GROUPS) {
        for (const key of keys) {
          const label = resolve(root, contextValueLabelKey(group, key));
          if (typeof label !== "string" || label.trim() === "") {
            missing.push(contextValueLabelKey(group, key));
          }
        }
      }
      for (const section of CONTEXT_SECTION_KEYS) {
        const label = resolve(root, contextSectionLabelKey(section));
        if (typeof label !== "string" || label.trim() === "") {
          missing.push(contextSectionLabelKey(section));
        }
      }
      for (const field of CONTEXT_RATING_FIELDS) {
        for (const anchor of ["low", "high"] as const) {
          const key = `mood.context.rating.${field}.${anchor}`;
          const label = resolve(root, key);
          if (typeof label !== "string" || label.trim() === "") {
            missing.push(key);
          }
        }
      }

      expect(
        missing,
        `messages/${locale}.json is missing ${missing.length} context label(s)`,
      ).toEqual([]);
    });

    it(`${locale} carries no label the vocabulary no longer names`, () => {
      const root = bundle(locale);
      const orphans: string[] = [];

      for (const { group, keys } of VALUE_GROUPS) {
        const node = resolve(root, `mood.context.${group}`);
        expect(
          node && typeof node === "object",
          `mood.context.${group} is absent from ${locale} — this matcher would prove nothing`,
        ).toBe(true);
        for (const present of Object.keys(node as Record<string, unknown>)) {
          if (!keys.includes(present)) {
            orphans.push(`mood.context.${group}.${present}`);
          }
        }
      }

      expect(
        orphans,
        `messages/${locale}.json carries ${orphans.length} label(s) for values the vocabulary does not name`,
      ).toEqual([]);
    });
  }
});
