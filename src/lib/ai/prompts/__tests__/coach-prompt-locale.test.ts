import { describe, it, expect } from "vitest";

import { getCoachSystemPrompt } from "@/lib/ai/coach/system-prompt";
import {
  getStrictInsightsSystemPrompt,
  PROMPT_VERSION,
  OUT_OF_SCOPE_REFUSAL_FR,
  OUT_OF_SCOPE_REFUSAL_ES,
  OUT_OF_SCOPE_REFUSAL_IT,
  OUT_OF_SCOPE_REFUSAL_PL,
} from "@/lib/ai/prompts/insight-generator";
import {
  buildNativeCoachPrompt,
  buildNativeInsightsPrompt,
} from "@/lib/ai/prompts/native-prompts";
import { loadSafetyContracts } from "@/lib/ai/prompts/safety-contracts";

const NATIVE_LOCALES = ["fr", "es", "it", "pl"] as const;

/**
 * v1.4.25 W14c — each AI-initial locale (FR / ES / IT / PL) now gets a
 * native system prompt assembled from the safety-contract matrix
 * instead of riding the EN body with a one-line footer.
 *
 * These tests pin the assembly contract:
 *   1. Every locale produces a non-empty prompt.
 *   2. The prompt embeds PROMPT_VERSION.
 *   3. The locale-specific persona statement opens the body.
 *   4. Every GROUND RULE body from the matrix appears verbatim.
 *   5. Parser sentinels (---KEYVALUES---, ---END---) survive intact.
 *   6. GLP-1 brand names appear verbatim (never translated).
 *   7. EN contract enums (severity, sourceWindow, etc) stay literal.
 *   8. The few-shot <example> tags survive untranslated.
 *   9. The reply-language directive lives at the foot of the prompt.
 */

describe("getCoachSystemPrompt — native AI-initial locales", () => {
  it.each(NATIVE_LOCALES)(
    "%s produces a non-empty native prompt embedding PROMPT_VERSION",
    (locale) => {
      const prompt = getCoachSystemPrompt(locale);
      expect(prompt.length).toBeGreaterThan(2000);
      expect(prompt).toContain(PROMPT_VERSION);
    },
  );

  it("FR prompt opens with the vouvoiement persona", () => {
    const prompt = getCoachSystemPrompt("fr");
    expect(prompt).toMatch(/Vous êtes le Coach HealthLog/);
    expect(prompt).toMatch(/RÈGLES FONDAMENTALES/);
    expect(prompt).toMatch(/BLOC DE PREUVES/);
  });

  it("ES prompt opens with the usted-peninsular persona", () => {
    const prompt = getCoachSystemPrompt("es");
    expect(prompt).toMatch(/Usted es el Coach HealthLog/);
    expect(prompt).toMatch(/REGLAS BÁSICAS/);
    expect(prompt).toMatch(/BLOQUE DE EVIDENCIA/);
  });

  it("IT prompt opens with the Lei persona", () => {
    const prompt = getCoachSystemPrompt("it");
    expect(prompt).toMatch(/Lei è il Coach HealthLog/);
    expect(prompt).toMatch(/REGOLE FONDAMENTALI/);
    expect(prompt).toMatch(/BLOCCO DI EVIDENZA/);
  });

  it("PL prompt opens with the Pan/Pani persona", () => {
    const prompt = getCoachSystemPrompt("pl");
    expect(prompt).toMatch(/Coachem HealthLog/);
    expect(prompt).toMatch(/ZASADY PODSTAWOWE/);
    expect(prompt).toMatch(/BLOK DOWODÓW/);
  });

  it.each(NATIVE_LOCALES)("%s carries every GROUND RULE body verbatim", (locale) => {
    const matrix = loadSafetyContracts(locale);
    const prompt = getCoachSystemPrompt(locale);
    for (const key of Object.keys(matrix.ground_rules) as Array<
      keyof typeof matrix.ground_rules
    >) {
      const rule = matrix.ground_rules[key];
      // Coach uses surface = "coach" or "both" rules.
      if (rule.surface === "insights") continue;
      const body = rule.locale ?? rule.en;
      expect(body).toBeDefined();
      // Match on a representative substring (first 80 chars of body).
      const sample = body!.trim().slice(0, 80);
      expect(
        prompt,
        `coach prompt for ${locale} dropped ${key} (looking for "${sample}")`,
      ).toContain(sample);
    }
  });

  it.each(NATIVE_LOCALES)(
    "%s preserves the ---KEYVALUES--- / ---END--- sentinels",
    (locale) => {
      const prompt = getCoachSystemPrompt(locale);
      expect(prompt).toContain("---KEYVALUES---");
      expect(prompt).toContain("---END---");
    },
  );

  it.each(NATIVE_LOCALES)("%s preserves every GLP-1 brand name", (locale) => {
    const prompt = getCoachSystemPrompt(locale);
    for (const brand of [
      "Mounjaro",
      "Ozempic",
      "Wegovy",
      "Zepbound",
      "Trulicity",
      "Saxenda",
      "Rybelsus",
    ]) {
      expect(prompt).toContain(brand);
    }
  });

  it.each(NATIVE_LOCALES)("%s includes <example> few-shot pairs", (locale) => {
    const prompt = getCoachSystemPrompt(locale);
    const opens = (prompt.match(/<example>/g) ?? []).length;
    const closes = (prompt.match(/<\/example>/g) ?? []).length;
    expect(opens).toBeGreaterThanOrEqual(3);
    expect(opens).toBe(closes);
  });

  it("EN locale still uses the original EN body (untouched)", () => {
    const prompt = getCoachSystemPrompt("en");
    expect(prompt).toMatch(/You are the HealthLog Coach\./);
    expect(prompt).toMatch(/GROUND RULES/);
  });

  it("DE locale still uses the original DE body (untouched)", () => {
    const prompt = getCoachSystemPrompt("de");
    expect(prompt).toMatch(/Du bist der HealthLog-Coach\./);
    expect(prompt).toMatch(/GRUNDREGELN/);
  });
});

describe("getStrictInsightsSystemPrompt — native AI-initial locales", () => {
  it.each(NATIVE_LOCALES)(
    "%s produces a non-empty native Insights prompt",
    (locale) => {
      const prompt = getStrictInsightsSystemPrompt(locale);
      expect(prompt.length).toBeGreaterThan(3000);
      expect(prompt).toContain(PROMPT_VERSION);
    },
  );

  it.each(NATIVE_LOCALES)(
    "%s preserves the EN severity enums (info / suggestion / important / urgent)",
    (locale) => {
      const prompt = getStrictInsightsSystemPrompt(locale);
      for (const enumValue of ["info", "suggestion", "important", "urgent"]) {
        expect(prompt).toContain(`"${enumValue}"`);
      }
    },
  );

  it.each(NATIVE_LOCALES)(
    "%s preserves the EN sourceWindow enums (7d/30d/90d/1y)",
    (locale) => {
      const prompt = getStrictInsightsSystemPrompt(locale);
      for (const win of ["7d", "30d", "90d", "1y"]) {
        expect(prompt).toContain(win);
      }
    },
  );

  it.each(NATIVE_LOCALES)(
    "%s preserves the EN timeRange enums (last7days/last30days/last90days/allTime)",
    (locale) => {
      const prompt = getStrictInsightsSystemPrompt(locale);
      for (const tr of ["last7days", "last30days", "last90days", "allTime"]) {
        expect(prompt).toContain(tr);
      }
    },
  );

  it.each(NATIVE_LOCALES)(
    "%s emits an OUTPUT FORMAT block with the full schema template",
    (locale) => {
      const prompt = getStrictInsightsSystemPrompt(locale);
      expect(prompt).toMatch(/FORMAT/i);
      expect(prompt).toContain("summary");
      expect(prompt).toContain("recommendations");
      expect(prompt).toContain("citations");
      expect(prompt).toContain("warnings");
      expect(prompt).toContain("dailyBriefing");
      expect(prompt).toContain("trendAnnotations");
      expect(prompt).toContain("storyboardAnnotations");
    },
  );

  it("EN locale still uses the original EN body", () => {
    const prompt = getStrictInsightsSystemPrompt("en");
    expect(prompt).toMatch(/You are a clinical-context summariser/);
  });

  it("DE locale still uses the original DE body", () => {
    const prompt = getStrictInsightsSystemPrompt("de");
    expect(prompt).toMatch(/klinischer-Kontext-Zusammenfasser/);
  });
});

describe("OUT_OF_SCOPE_REFUSAL — locale parity", () => {
  it("FR / ES / IT / PL refusal payloads share the EN / DE shape", () => {
    for (const refusal of [
      OUT_OF_SCOPE_REFUSAL_FR,
      OUT_OF_SCOPE_REFUSAL_ES,
      OUT_OF_SCOPE_REFUSAL_IT,
      OUT_OF_SCOPE_REFUSAL_PL,
    ]) {
      expect(typeof refusal.summary).toBe("string");
      expect(refusal.summary.length).toBeGreaterThan(0);
      expect(refusal.recommendations).toEqual([]);
      expect(refusal.citations).toEqual([]);
      expect(refusal.warnings).toEqual([]);
    }
  });

  it("each native refusal carries the locale's reply language", () => {
    // FR contains "résumer" or "résumé"; ES has "resumir"; IT "riassumere";
    // PL has "podsumować". Smoke-test that the localisation actually took.
    expect(OUT_OF_SCOPE_REFUSAL_FR.summary).toMatch(/résumer|résumé/i);
    expect(OUT_OF_SCOPE_REFUSAL_ES.summary).toMatch(/resumir|resumen/i);
    expect(OUT_OF_SCOPE_REFUSAL_IT.summary).toMatch(/riassum/i);
    expect(OUT_OF_SCOPE_REFUSAL_PL.summary).toMatch(/podsumować/i);
  });
});

describe("native-prompts — direct builder smoke tests", () => {
  it("buildNativeCoachPrompt produces a non-empty string for each locale", () => {
    for (const locale of NATIVE_LOCALES) {
      const prompt = buildNativeCoachPrompt(locale, PROMPT_VERSION);
      expect(prompt.length).toBeGreaterThan(2000);
    }
  });

  it("buildNativeInsightsPrompt produces a non-empty string for each locale", () => {
    for (const locale of NATIVE_LOCALES) {
      const prompt = buildNativeInsightsPrompt(locale, PROMPT_VERSION);
      expect(prompt.length).toBeGreaterThan(3000);
    }
  });
});
