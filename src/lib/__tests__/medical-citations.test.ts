import { describe, it, expect } from "vitest";

import { CITATIONS, citationLabel, citationUrl } from "../medical-citations";

describe("medical-citations master list", () => {
  it("every citation has a non-empty url + caveat", () => {
    for (const [key, c] of Object.entries(CITATIONS)) {
      expect(c.id, `${key} id`).toMatch(/^[a-z0-9-]+$/);
      expect(c.name, `${key} name`).toBeTruthy();
      expect(c.year, `${key} year`).toBeGreaterThanOrEqual(1900);
      expect(c.year, `${key} year`).toBeLessThanOrEqual(2100);
      expect(c.url, `${key} url`).toMatch(/^https?:\/\//);
      expect(c.caveat, `${key} caveat`).toBeTruthy();
    }
  });

  it("no two citations share an id", () => {
    const ids = Object.values(CITATIONS).map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("citationUrl resolves to the same string", () => {
    expect(citationUrl("ESH_2023_HYPERTENSION")).toBe(
      CITATIONS.ESH_2023_HYPERTENSION.url,
    );
  });

  it("citationLabel formats name + year", () => {
    expect(citationLabel("ESH_2023_HYPERTENSION")).toBe("ESH 2023 (2023)");
    expect(citationLabel("STEPS_SAINT_MAURICE_2020")).toBe(
      "Saint-Maurice JAMA 2020 (2020)",
    );
  });

  it("rejects WHO-as-step-source by NOT exposing such a constant", () => {
    // v3 audit: 'WHO ≥ 8 000 steps/day' is a recurring hallucination.
    // The codebase must not have a WHO_STEPS-style constant; only the
    // PA minutes/week guideline (WHO_2020_PA) and the actual cohort
    // study (STEPS_SAINT_MAURICE_2020) are sanctioned.
    const keys = Object.keys(CITATIONS);
    for (const k of keys) {
      const lower = k.toLowerCase();
      if (lower.includes("who")) {
        expect(
          lower.includes("steps") && !lower.includes("pa"),
          `${k} cannot link WHO to steps`,
        ).toBe(false);
      }
    }
    expect(keys).toContain("WHO_2020_PA");
    expect(keys).toContain("STEPS_SAINT_MAURICE_2020");
  });
});
