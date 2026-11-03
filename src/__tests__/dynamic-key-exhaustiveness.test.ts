import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveKey } from "@/lib/i18n/resolve-key";
import {
  ILLNESS_SCAN_TYPES,
  FUNCTIONAL_IMPACT_RETURN_KEY,
} from "@/lib/illness/correlation";
import {
  illnessTypeEnum,
  illnessLifecycleEnum,
} from "@/lib/validations/illness";
import {
  allergyCategoryEnum,
  allergyTypeEnum,
  allergySeverityEnum,
  allergyStatusEnum,
} from "@/lib/validations/allergy";
import { familyRelationshipEnum } from "@/lib/validations/family-history";
import { encounterKindEnum } from "@/lib/validations/encounters";
import { encounterKindLabelKey } from "@/lib/encounters/kind-label";
import { INSTRUMENTS } from "@/lib/mental-health/instruments";

/**
 * Enum-driven exhaustiveness guard for DYNAMICALLY-built i18n keys.
 *
 * The three existing i18n guards each see one face of the problem and miss the
 * fourth:
 *   - `i18n-call-site-coverage.test.ts` sees only literal `t("ns.key")` calls,
 *     so a runtime-assembled `t(\`ns.${x}\`)` key is invisible to it.
 *   - `i18n-reverse-coverage.test.ts` sees bundle orphans, but treats any
 *     `ns.${x}` template as covering its whole subtree — so a MEMBER missing
 *     from the subtree is invisible.
 *   - `i18n-locale-integrity.test.ts` sees cross-locale parity, so it only
 *     fires when a key is present in SOME locale but not all.
 *
 * None of them assert the class that actually ships broken: "for enum E, every
 * member's dynamically-built key resolves, non-empty, in every locale." Because
 * parity is perfect, a key missing from ONE locale is missing from ALL SIX at
 * once — exactly the seam that let `measurementReminders.types.{WHO5_SCORE,
 * SCI_SCORE,WAIST_CIRCUMFERENCE}` (v1.28.38) and `illness.vital.FUNCTIONAL_IMPACT`
 * (v1.28.41) ship absent from every bundle.
 *
 * This test derives the EXPECTED key set from the SOURCE enum/const and asserts
 * every `prefix + member` resolves. Adding an enum member without a bundle key
 * fails CI by construction — no hand-maintained floor to drift.
 *
 * ── Covered key spaces (source is a clean, finite, import-safe enum/const) ──
 *   - illness.vital.*            ILLNESS_SCAN_TYPES ∪ FUNCTIONAL_IMPACT_RETURN_KEY
 *   - illness.type.*             illnessTypeEnum
 *   - illness.lifecycle.*        illnessLifecycleEnum
 *   - records.allergies.category.*  allergyCategoryEnum
 *   - records.allergies.type.*      allergyTypeEnum
 *   - records.allergies.severity.*  allergySeverityEnum ∪ "NONE" sentinel
 *   - records.allergies.status.*    allergyStatusEnum
 *   - records.family.relationship.* familyRelationshipEnum
 *   - mentalHealth.instrument.*         } INSTRUMENTS i18nKey slugs
 *   - mentalHealth.instrumentSub.*      } (PHQ-9 / GAD-7 / WHO-5 / SCI —
 *   - mentalHealth.instrumentDescription.* } the WHO-5/SCI class that bit before)
 *
 * ── Deliberately EXCLUDED (would produce false positives) ──
 *   - `insights.workouts.sport.*` — the Strava render path stores a raw
 *     `sport_type` and the render site legitimately falls back to that raw
 *     string, so a "missing" key is a graceful degradation, not a broken token
 *     (audit LOW #2). Asserting it would fail on a path that is by-design lax.
 *   - `settings.sections.*.description`, `settings.ai.providerChain.types.admin-codex`,
 *     `insights.<metric>.emptyState.cta` — structurally unreachable behind a
 *     tsc-exhaustive map / a `!= null` guard / a server-only filter (audit LOW).
 *     Registering them would demand bundle keys for code paths users never hit.
 *   - `measurementReminders.types.*` — already exhaustively covered by
 *     `measurement-reminders/__tests__/type-labels-i18n.test.ts`; its source
 *     const lives in a client component, not a lib-level export.
 *   - Prisma cycle enums, medication/document/lab/nutrient catalogs — clean
 *     enums the audit flags as candidates; left for a follow-up extension. Add
 *     them here once their exact prefix→member mapping is confirmed 1:1 (the
 *     cycle cervix* prefixes and catalog slug maps need per-space verification
 *     to stay false-positive-free).
 */

const MESSAGES_DIR = join(__dirname, "../../messages");

const LOCALES = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({
    locale: f.replace(/\.json$/, ""),
    messages: JSON.parse(readFileSync(join(MESSAGES_DIR, f), "utf8")) as Record<
      string,
      unknown
    >,
  }));

/** PHQ-9 / GAD-7 / WHO-5 / SCI lowercase i18n slugs, straight from the source. */
const INSTRUMENT_SLUGS = Object.values(INSTRUMENTS).map((i) => i.i18nKey);

interface KeySpace {
  /** The dotted prefix the key is built from (`t(\`prefix.${member}\`)`). */
  prefix: string;
  /** The finite member set, derived from the SOURCE enum/const. */
  members: readonly string[];
}

const REGISTRY: readonly KeySpace[] = [
  // illness.* — the currently-broken seed (FUNCTIONAL_IMPACT wins recovery-gap ties).
  {
    prefix: "illness.vital",
    members: [...ILLNESS_SCAN_TYPES.map(String), FUNCTIONAL_IMPACT_RETURN_KEY],
  },
  { prefix: "illness.type", members: illnessTypeEnum.options },
  { prefix: "illness.lifecycle", members: illnessLifecycleEnum.options },

  // records.allergies.* — Zod enums; severity carries a "NONE" (not-assessed) sentinel.
  {
    prefix: "records.allergies.category",
    members: allergyCategoryEnum.options,
  },
  { prefix: "records.allergies.type", members: allergyTypeEnum.options },
  {
    prefix: "records.allergies.severity",
    members: [...allergySeverityEnum.options, "NONE"],
  },
  { prefix: "records.allergies.status", members: allergyStatusEnum.options },

  // records.family.relationship.*
  {
    prefix: "records.family.relationship",
    members: familyRelationshipEnum.options,
  },

  // mentalHealth.* — the WHO-5/SCI class whose absence originally motivated this guard.
  { prefix: "mentalHealth.instrument", members: INSTRUMENT_SLUGS },
  { prefix: "mentalHealth.instrumentSub", members: INSTRUMENT_SLUGS },
  { prefix: "mentalHealth.instrumentDescription", members: INSTRUMENT_SLUGS },
];

/**
 * The second arm: key spaces whose member → key mapping is NOT `prefix +
 * member`, so the registry above cannot express them. The mapping function
 * itself is the source, and the guard runs the enum through it.
 *
 * `encounters.kind` is why this arm exists. The enum member is `ROUTINE`, the
 * bundle leaf is `routine`, and three surfaces — the doctor-report PDF's visit
 * table, the daily digest's upcoming-visit line and the clinician share view —
 * built the key by interpolation. All three printed `encounters.kind.ROUTINE`
 * verbatim: into a clinical document, onto a lock screen, and onto a page a
 * doctor opens. The prefix-plus-member form of this guard would have caught it
 * on the day the interpolation was written, but only if the mapping had been
 * expressible; it is not, so it was never registered and nothing else looked.
 */
const RESOLVED_REGISTRY: readonly {
  /** What the space is, for the failure message. */
  name: string;
  /** Every key the resolver can return, over the whole source enum. */
  keys: readonly string[];
}[] = [
  {
    name: "encounters.kind via encounterKindLabelKey",
    keys: encounterKindEnum.options.map(encounterKindLabelKey),
  },
];

describe("dynamic-key exhaustiveness (enum-derived)", () => {
  // Six shipped locales. An empty read of `messages/` would register zero
  // per-locale cases and the suite would report green over nothing.
  it("reads every shipped locale bundle", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(6);
  });

  it("discovers all ten shipped locales", () => {
    expect(LOCALES.map((l) => l.locale).sort()).toEqual([
      "de",
      "en",
      "es",
      "fr",
      "it",
      "ko",
      "nl",
      "pl",
      "pt-BR",
      "ru",
    ]);
  });

  it("every registered key space has a non-empty member set", () => {
    for (const space of REGISTRY) {
      expect(
        space.members.length,
        `${space.prefix} resolved to an empty member set — source import broke`,
      ).toBeGreaterThan(0);
    }
  });

  it("every resolver-mapped key space returns a distinct key per member", () => {
    for (const space of RESOLVED_REGISTRY) {
      expect(
        space.keys.length,
        `${space.name} resolved to an empty key set — source import broke`,
      ).toBeGreaterThan(0);
      // A resolver whose default arm swallowed a member would collapse two
      // enum values onto one key and the per-locale checks below would still
      // pass, because the surviving key resolves fine.
      expect(
        new Set(space.keys).size,
        `${space.name} maps two enum members onto one key`,
      ).toBe(space.keys.length);
    }
  });

  for (const { locale, messages } of LOCALES) {
    for (const space of REGISTRY) {
      for (const member of space.members) {
        const key = `${space.prefix}.${member}`;
        it(`resolves ${key} in ${locale}`, () => {
          const value = resolveKey(messages, key);
          expect(value, `${key} missing in ${locale}.json`).toBeTypeOf(
            "string",
          );
          expect((value ?? "").trim().length).toBeGreaterThan(0);
        });
      }
    }
    for (const space of RESOLVED_REGISTRY) {
      for (const key of space.keys) {
        it(`resolves ${key} in ${locale} (${space.name})`, () => {
          const value = resolveKey(messages, key);
          expect(value, `${key} missing in ${locale}.json`).toBeTypeOf(
            "string",
          );
          expect((value ?? "").trim().length).toBeGreaterThan(0);
        });
      }
    }
  }
});
