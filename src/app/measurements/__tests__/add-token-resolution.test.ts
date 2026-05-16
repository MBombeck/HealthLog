import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  MEASUREMENT_FORM_TYPE_VALUES,
  ADD_TOKEN_ALIASES,
  resolveAddToken,
} from "@/components/measurements/measurement-form";

/**
 * F-1 contract — every `?add=<token>` the Insights surfaces ship must
 * either land on a real `<MeasurementForm>` row or be an explicit
 * legacy alias mapped to one. Without this guard the empty-state CTA
 * silently drops the deep link and the dialog never opens — the
 * symptom that surfaced as "the Körpertemperatur CTA does nothing".
 */
describe("measurements ?add= deep link", () => {
  const repoRoot = join(__dirname, "..", "..", "..", "..");
  const insightsRoot = join(repoRoot, "src", "app", "insights");
  const insightsComponentsRoot = join(repoRoot, "src", "components", "insights");

  // Captures both `href="/measurements?add=FOO"` literals and the
  // dynamic `?add=${prop}` template the shared HealthKit metric page
  // uses. The latter is covered by walking `emptyStateCtaType="…"` in
  // every `/insights/<slug>/page.tsx`.
  const literalAddPattern = /\/measurements\?add=([A-Z_]+)/g;
  const ctaTypePattern = /emptyStateCtaType=\{?["']([A-Z_]+)["']/g;

  function collectFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        out.push(...collectFiles(full));
      } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
        out.push(full);
      }
    }
    return out;
  }

  const files = [
    ...collectFiles(insightsRoot),
    ...collectFiles(insightsComponentsRoot),
  ];

  const emittedTokens = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(literalAddPattern)) {
      emittedTokens.add(match[1]);
    }
    for (const match of source.matchAll(ctaTypePattern)) {
      emittedTokens.add(match[1]);
    }
  }

  it("walks at least one `?add=` token under src/app/insights", () => {
    // Sanity guard so the regex collector doesn't silently zero out.
    expect(emittedTokens.size).toBeGreaterThan(0);
  });

  it("every emitted `?add=` token resolves to a real form type", () => {
    const unresolved: string[] = [];
    for (const token of emittedTokens) {
      if (resolveAddToken(token) === null) unresolved.push(token);
    }
    expect(unresolved).toEqual([]);
  });

  it("legacy aliases each map to a real form type", () => {
    for (const [legacy, canonical] of Object.entries(ADD_TOKEN_ALIASES)) {
      expect(MEASUREMENT_FORM_TYPE_VALUES).toContain(canonical);
      expect(resolveAddToken(legacy)).toBe(canonical);
    }
  });

  it("resolves unknown tokens to null without throwing", () => {
    expect(resolveAddToken("NOT_A_TYPE")).toBeNull();
    expect(resolveAddToken(null)).toBeNull();
    expect(resolveAddToken(undefined)).toBeNull();
    expect(resolveAddToken("")).toBeNull();
  });
});
