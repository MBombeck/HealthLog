/**
 * Safety-contract matrix loader for HealthLog v1.4.25 W14c.
 *
 * Six YAML files (one per locale) sit alongside this module and carry
 * the safety-critical clauses that every Coach + Insights system prompt
 * must surface verbatim. The loader parses + validates each file at
 * startup via Zod and exposes typed accessors so the rest of the AI
 * layer never reads the raw YAML.
 *
 * Why YAML and not TypeScript constants:
 *   - The matrix is a translator-facing artefact. A YAML file is easier
 *     to diff-review across six locales than a long TS string template.
 *   - The locale bodies are LARGE (each ~3-5 KB) — keeping them out of
 *     the TS source keeps the prompt assembly module under 150 lines.
 *   - The Zod schema catches drift the same way at startup as a
 *     TypeScript type check would at build time.
 *
 * Why a single source-of-truth per locale instead of per-prompt:
 *   - The same GROUND RULE 9 (GLP-1 dose refusal) appears in both the
 *     Coach prompt and the Insights prompt. Sourcing both from the
 *     matrix lets us ratchet the safety language once and propagate to
 *     every surface.
 *
 * The refusal-probe-test (refusal-probe.test.ts) drives 14 contracts
 * times 6 locales times 20+ adversarial paraphrasings = >1680
 * assertions against this matrix. The maintainership-banner update
 * tells users that the FR/ES/IT/PL bodies are AI-drafted and links to
 * the GitHub issue template for reporting refusal regressions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { Locale } from "@/lib/i18n/config";

// Turbopack rewrites `__dirname` to a synthetic `/ROOT/...` token at
// build time, which then fails at runtime when the YAML siblings are
// looked up. Resolving from `process.cwd()` keeps the path stable
// across `next build` + `next start` (and the test runner — vitest sets
// cwd to the repo root). `outputFileTracingIncludes` in `next.config.ts`
// pulls the YAML files into the standalone runtime image.
const SAFETY_CONTRACTS_DIR = join(process.cwd(), "src/lib/ai/prompts");

const ContractEnumsSchema = z.object({
  severity: z.array(z.string()).min(1),
  source_window: z.array(z.string()).min(1),
  time_range: z.array(z.string()).min(1),
  source_metric: z.array(z.string()).min(1),
  tone: z.array(z.string()).min(1),
  topic: z.array(z.string()).min(1),
  category: z.array(z.string()).min(1),
});

const SentinelLiteralsSchema = z.object({
  evidence_block_open: z.string().min(1),
  evidence_block_close: z.string().min(1),
  example_tag_open: z.string().min(1),
  example_tag_close: z.string().min(1),
  snapshot_token: z.string().min(1),
});

const TerminologyEntrySchema = z.object({
  en: z.string().optional(),
  locale: z.string().optional(),
});

const MedicalTerminologySchema = z.object({
  hypertension: TerminologyEntrySchema,
  systolic: TerminologyEntrySchema,
  diastolic: TerminologyEntrySchema,
  resting_pulse: TerminologyEntrySchema,
  adherence: TerminologyEntrySchema,
  titration: TerminologyEntrySchema,
});

const SurfaceSchema = z.enum(["coach", "insights", "both"]);

const GroundRuleBodySchema = z.object({
  parser_critical: z.boolean(),
  surface: SurfaceSchema,
  en: z.string().min(1).optional(),
  locale: z.string().min(1).optional(),
  trigger_examples: z.array(z.string()).optional(),
  must_contain: z.array(z.string()).optional(),
});

const GroundRulesSchema = z.object({
  ground_rule_1_zero_hallucination: GroundRuleBodySchema,
  ground_rule_2_evidence_block_sentinel: GroundRuleBodySchema,
  ground_rule_3_missing_data_pivot: GroundRuleBodySchema,
  ground_rule_4_conservative_phrasing: GroundRuleBodySchema,
  ground_rule_5_motivational_interviewing: GroundRuleBodySchema,
  ground_rule_6_off_topic_redirect: GroundRuleBodySchema,
  ground_rule_7_ground_in_snapshot: GroundRuleBodySchema,
  ground_rule_8_no_internal_identifiers: GroundRuleBodySchema,
  ground_rule_9_glp1_dose_refusal: GroundRuleBodySchema,
  ground_rule_10_out_of_scope_refusal: GroundRuleBodySchema,
  ground_rule_11_severity_enums_lowercase_en: GroundRuleBodySchema,
  ground_rule_12_no_causal_claims: GroundRuleBodySchema,
  ground_rule_13_dailybriefing_schema: GroundRuleBodySchema,
  ground_rule_14_apple_health_silent_absence: GroundRuleBodySchema,
  ground_rule_15_drug_level_refusal: GroundRuleBodySchema,
});

const OutOfScopeRefusalSchema = z.object({
  summary: z.string().min(1),
});

/**
 * v1.4.25 W19c — drug-level refusal contract. Sits alongside the
 * ground-rule matrix and drives the adversarial drug-level probe suite.
 * Trigger phrases are NOT prompt copy — they are the test surface the
 * probe runner sweeps against the ground-rule-15 body. Expected /
 * forbidden keywords are what the probe asserts (or rejects) when a
 * real LLM is wired in; today the structural probe asserts that for
 * every trigger phrase the assembled prompt carries the rule body and
 * at least one expected refusal keyword from the locale's allow-list.
 */
const DrugLevelRefusalSchema = z.object({
  trigger_phrases: z.array(z.string().min(1)).min(10),
  expected_refusal_keywords: z.array(z.string().min(1)).min(3),
  forbidden_phrases: z.array(z.string().min(1)).min(3),
});

export const SafetyContractMatrixSchema = z.object({
  ground_rules: GroundRulesSchema,
  sentinel_literals: SentinelLiteralsSchema,
  glp1_brand_list: z.array(z.string().min(1)).min(7),
  contract_enums: ContractEnumsSchema,
  medical_terminology: MedicalTerminologySchema,
  defer_to_clinician_phrases: z.array(z.string()).min(1),
  out_of_scope_refusal: OutOfScopeRefusalSchema,
  drug_level_refusal: DrugLevelRefusalSchema,
  reply_language_directive: z.string().min(1),
});

export type SafetyContractMatrix = z.infer<typeof SafetyContractMatrixSchema>;
export type GroundRuleKey = keyof SafetyContractMatrix["ground_rules"];

/** Ordered list of every ground-rule key for iteration tests. */
export const GROUND_RULE_KEYS: readonly GroundRuleKey[] = [
  "ground_rule_1_zero_hallucination",
  "ground_rule_2_evidence_block_sentinel",
  "ground_rule_3_missing_data_pivot",
  "ground_rule_4_conservative_phrasing",
  "ground_rule_5_motivational_interviewing",
  "ground_rule_6_off_topic_redirect",
  "ground_rule_7_ground_in_snapshot",
  "ground_rule_8_no_internal_identifiers",
  "ground_rule_9_glp1_dose_refusal",
  "ground_rule_10_out_of_scope_refusal",
  "ground_rule_11_severity_enums_lowercase_en",
  "ground_rule_12_no_causal_claims",
  "ground_rule_13_dailybriefing_schema",
  "ground_rule_14_apple_health_silent_absence",
  "ground_rule_15_drug_level_refusal",
] as const;

const ALL_LOCALES = ["en", "de", "fr", "es", "it", "pl"] as const;

let cache: Partial<Record<Locale, SafetyContractMatrix>> = {};

function loadFromDisk(locale: Locale): SafetyContractMatrix {
  const path = join(SAFETY_CONTRACTS_DIR, `safety-contracts.${locale}.yaml`);
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  const result = SafetyContractMatrixSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `safety-contracts.${locale}.yaml failed schema validation:\n${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Load the safety-contract matrix for a locale. Result is cached
 * in-process — the YAML files are read-only at runtime.
 */
export function loadSafetyContracts(locale: Locale): SafetyContractMatrix {
  const cached = cache[locale];
  if (cached) return cached;
  const data = loadFromDisk(locale);
  cache = { ...cache, [locale]: data };
  return data;
}

/** Clear the in-process cache. Used in tests that swap matrices. */
export function _resetSafetyContractsCacheForTests(): void {
  cache = {};
}

/**
 * Return the locale-specific body of a ground rule. For EN the matrix
 * stores it under `.en`; for every other locale it lives under
 * `.locale`. Throws if the rule has no body for the requested locale
 * (this indicates a translation gap and is caught by the parity test).
 */
export function getGroundRuleBody(
  locale: Locale,
  key: GroundRuleKey,
): string {
  const matrix = loadSafetyContracts(locale);
  const rule = matrix.ground_rules[key];
  const body = locale === "en" ? rule.en : rule.locale;
  if (!body) {
    throw new Error(
      `safety-contracts.${locale}.yaml: ground rule "${key}" has no body for locale ${locale}`,
    );
  }
  return body;
}

/**
 * Iterate every (locale, ground-rule-key) pair. Used by the parity +
 * refusal-probe tests so they cover the full 14×6 = 84 grid without
 * hard-coding the locale list.
 */
export function forEachLocaleAndRule(
  fn: (locale: Locale, key: GroundRuleKey) => void,
): void {
  for (const locale of ALL_LOCALES) {
    for (const key of GROUND_RULE_KEYS) {
      fn(locale, key);
    }
  }
}

/** Ordered locale list — exported so tests can iterate identically. */
export const SAFETY_CONTRACT_LOCALES = ALL_LOCALES;
