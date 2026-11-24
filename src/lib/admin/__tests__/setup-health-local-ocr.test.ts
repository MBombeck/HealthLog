import { describe, expect, it } from "vitest";

import { evaluateLocalOcr } from "../setup-health-model";

/** The setup check's word on reading scans on this server. */
describe("evaluateLocalOcr", () => {
  it("names the languages in two-letter codes when all is well", () => {
    expect(
      evaluateLocalOcr({
        status: { available: true, languages: ["deu", "eng"] },
        recentFailures: 0,
      }),
    ).toMatchObject({
      id: "local_ocr",
      state: "ok",
      reason: "ready",
      params: { languages: "de, en" },
    });
  });

  it("asks for a look when scans failed lately, with the count only", () => {
    const signal = evaluateLocalOcr({
      status: { available: true, languages: ["deu", "eng"] },
      recentFailures: 3,
    });
    expect(signal).toMatchObject({
      state: "attention",
      reason: "recent_failures",
      params: { count: 3 },
    });
  });

  it("asks for a look on a build without the engine or its languages", () => {
    expect(
      evaluateLocalOcr({
        status: { available: false, reason: "engine-missing" },
        recentFailures: 0,
      }),
    ).toMatchObject({ state: "attention", reason: "engine_missing" });
    expect(
      evaluateLocalOcr({
        status: { available: false, reason: "languages-missing" },
        recentFailures: 5,
      }),
    ).toMatchObject({ state: "attention", reason: "languages_missing" });
  });
});
