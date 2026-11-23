/**
 * Output-language contract for the PERIOD NARRATIVE surface.
 *
 * The bug this pins: the read route narrowed every non-English locale to `de`,
 * so a French, Spanish, Italian or Polish reader received a German
 * retrospective composed from the German instruction body. The fix keeps the
 * two reviewed bodies (de, en) and lets the other four ride the English body
 * with their language named and their OWN reply-language directive appended.
 *
 * Three things are asserted here, in ascending strength:
 *  1. the four locales name their language and carry the verbatim directive
 *     from the translator-facing `safety-contracts.<locale>.yaml`;
 *  2. no non-German prompt contains a German-body sentinel — the "nothing
 *     silently falls back to German" assertion this whole change exists for;
 *  3. the German and English prompts are byte-identical to their pre-change
 *     form, modulo the prompt-version string, pinned by content hash.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => null,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { createHash } from "node:crypto";
import {
  buildNarrativeSystemPrompt,
  generatePeriodNarrative,
  NARRATIVE_PROMPT_VERSION,
} from "@/lib/insights/narrative/period-narrative-generate";
import { loadSafetyContracts } from "@/lib/ai/prompts/safety-contracts";
import { locales, type Locale } from "@/lib/i18n/config";
import type { PeriodNarrativeContext } from "@/lib/insights/narrative/period-narrative";

/** The four locales that ride the English body. */
const RIDING_LOCALES: Locale[] = ["fr", "es", "it", "pl"];

const LANGUAGE_NAMES: Record<string, string> = {
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pl: "Polish",
};

/**
 * Sentinels that only ever appear in the GERMAN instruction body. A hit on a
 * non-German prompt means that locale fell back to German — the exact bug.
 */
const GERMAN_SENTINELS = [
  "AUSGABEFORMAT",
  "Antworte",
  "auf Deutsch",
  "Feste Regeln",
  "Prompt-Version",
];

/**
 * sha256 of the composed prompt with the version string normalised away.
 *
 * The version is deliberately excluded: bumping `NARRATIVE_PROMPT_VERSION` is
 * a required part of any prompt change and is the ONE byte the de/en prompts
 * are allowed to move by. Everything else is frozen.
 */
function promptHash(locale: "de" | "en"): string {
  const normalised = buildNarrativeSystemPrompt(locale)
    .split(NARRATIVE_PROMPT_VERSION)
    .join("VERSION");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/**
 * Hashes captured from the prompts as they stood at NARRATIVE_PROMPT_VERSION
 * 1.13.0, before the output-language change. If either moves, the de or en
 * prompt drifted — which this change promised would not happen.
 *
 * Re-captured once since: the shared acute red-flag clause now states its
 * glucose and fever floors in both units.
 */
const FROZEN_PROMPT_HASHES: Record<"de" | "en", string> = {
  de: "1bb2246e991fcc28f9a009996284529beebf0d469b29b157cbad273b822626c6",
  en: "d34fa0fcb4a855f805f1a30338d309c19b07d5a54533f75de412cbe107b4f772",
};

describe("period-narrative output language", () => {
  it("keeps the German and English prompts byte-identical modulo the version", () => {
    expect(promptHash("de")).toBe(FROZEN_PROMPT_HASHES.de);
    expect(promptHash("en")).toBe(FROZEN_PROMPT_HASHES.en);
  });

  it("appends no directive to the two reviewed bodies", () => {
    expect(buildNarrativeSystemPrompt("de")).not.toContain("OUTPUT LANGUAGE:");
    expect(buildNarrativeSystemPrompt("en")).not.toContain("OUTPUT LANGUAGE:");
    // The English body must not grow a language rule for its own locale.
    expect(buildNarrativeSystemPrompt("en")).not.toContain(
      "Write the summary in English.",
    );
  });

  it.each(RIDING_LOCALES)(
    "names the language and carries the verbatim directive for %s",
    (locale) => {
      const prompt = buildNarrativeSystemPrompt(locale);
      const directive = loadSafetyContracts(locale).reply_language_directive;

      expect(prompt).toContain(
        `Write the summary in ${LANGUAGE_NAMES[locale]}.`,
      );
      expect(prompt).toContain(`OUTPUT LANGUAGE: ${directive}`);
      // The directive is the LAST instruction the model reads.
      expect(prompt.trimEnd().endsWith(directive.trimEnd())).toBe(true);
      // The scaffolding is the English body, not a translation of it.
      expect(prompt).toContain("Hard rules:");
    },
  );

  it("specifically composes the French prompt in English with the French directive", () => {
    const prompt = buildNarrativeSystemPrompt("fr");
    expect(prompt).toContain("Write the summary in French.");
    expect(prompt).toContain(
      loadSafetyContracts("fr").reply_language_directive,
    );
    expect(prompt).toContain(
      "You summarise one person's health-tracking PERIOD",
    );
  });

  it.each(locales.filter((l) => l !== "de"))(
    "leaks no German instruction body into the %s prompt",
    (locale) => {
      const prompt = buildNarrativeSystemPrompt(locale);
      for (const sentinel of GERMAN_SENTINELS) {
        expect(prompt).not.toContain(sentinel);
      }
    },
  );

  it("keeps the German prompt German", () => {
    const prompt = buildNarrativeSystemPrompt("de");
    expect(prompt).toContain("Feste Regeln:");
    expect(prompt).toContain("Prompt-Version:");
  });
});

describe("period-narrative locale storage", () => {
  function readyContext(): PeriodNarrativeContext {
    return {
      status: "ready",
      period: "week",
      metricDeltas: [
        {
          type: "WEIGHT",
          unit: "kg",
          current: 80,
          prior: 81,
          delta: -1,
          deltaPercent: -1.2,
          currentDays: 6,
          priorDays: 7,
        },
      ],
      bandTransitions: [],
      drivers: [],
      coincidentFlags: [],
      pairsTested: 12,
      fdrQ: 0.1,
      provenance: {
        metrics: ["WEIGHT"],
        window: {
          from: "2026-05-01T00:00:00.000Z",
          to: "2026-05-15T00:00:00.000Z",
        },
        computedAt: "2026-05-15T05:00:00.000Z",
      },
    };
  }

  it("keys the row by the reader's own locale and prompts in their language", async () => {
    const upsert = vi.fn(async (args: { create: { locale: string } }) => args);
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ timezone: "Europe/Berlin" })) },
      insightNarrative: { findUnique: vi.fn(async () => null), upsert },
    };
    let capturedSystemPrompt = "";
    const runCompletion = vi.fn(async (args: { systemPrompt: string }) => {
      capturedSystemPrompt = args.systemPrompt;
      return {
        kind: "ok" as const,
        content: "Votre semaine.",
        providerType: "mock",
      };
    });

    const outcome = await generatePeriodNarrative("user-1", {
      period: "week",
      locale: "fr",
      force: true,
      buildContext: vi.fn(async () => readyContext()) as never,
      runCompletion: runCompletion as never,
      prisma: prisma as never,
    });

    expect(outcome).toEqual({ status: "generated", providerType: "mock" });
    // The row is stored under `fr` — NOT collapsed into the de or en row, so a
    // French retrospective is never served to a German or English reader.
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { locale: "fr" },
      where: { userId_period_locale: { locale: "fr" } },
    });
    expect(capturedSystemPrompt).toContain("Write the summary in French.");
    expect(capturedSystemPrompt).not.toContain("AUSGABEFORMAT");
    // The provider cache action is locale-scoped too.
    expect(runCompletion.mock.calls[0]?.[0]).toMatchObject({
      cacheAction: "insights.narrative.week.fr",
    });
  });
});
