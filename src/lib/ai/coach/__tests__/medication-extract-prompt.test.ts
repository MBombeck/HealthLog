/**
 * v1.5.0 — pins the assembled medication-extraction prompt across the
 * five canonical cadence shapes the design synthesis calls out.
 *
 * The tests run pure prompt assembly — no provider client touched, no
 * network, no Prisma. A drift in either the system prompt body or the
 * per-input formatter trips the snapshot.
 *
 * The citation-coverage guard has its own pinned test below: an
 * extraction that names a medication the user did not type loses
 * the `name` field, while a load-bearing inference (cadence inferred
 * from "weekly") is preserved.
 */
import { describe, expect, it } from "vitest";

import {
  applyCitationGuard,
  buildMedicationExtractionPrompt,
  buildMedicationExtractionSystemPrompt,
  buildMedicationExtractionUserPrompt,
  type MedicationExtractionResult,
} from "../medication-extract-prompt";

describe("buildMedicationExtractionSystemPrompt", () => {
  it("pins the system prompt body", () => {
    expect(buildMedicationExtractionSystemPrompt()).toMatchSnapshot();
  });

  it("carries the citation-coverage guard wording", () => {
    const prompt = buildMedicationExtractionSystemPrompt();
    expect(prompt).toMatch(/Do NOT invent a name or dose/i);
  });

  it("lists every cadence kind the wizard exposes", () => {
    const prompt = buildMedicationExtractionSystemPrompt();
    for (const kind of [
      "daily",
      "weekdays",
      "everyNWeeks",
      "monthly",
      "everyNMonths",
      "yearly",
      "rolling",
      "oneShot",
    ]) {
      expect(prompt).toContain(kind);
    }
  });

  it("lists every supported dose unit", () => {
    const prompt = buildMedicationExtractionSystemPrompt();
    for (const unit of [
      "mg",
      "ml",
      "iu",
      "tablets",
      "drops",
      "puffs",
      "sprays",
    ]) {
      expect(prompt).toContain(unit);
    }
  });
});

describe("buildMedicationExtractionPrompt — cadence snapshots", () => {
  // The reference date stays fixed across the snapshot deck so a
  // future contributor running `vitest -u` does not silently rebake
  // a date drift into the file.
  const FIXED_TODAY = "2026-05-28";

  it("snapshot — weekly GLP-1 starting next Monday", () => {
    const assembled = buildMedicationExtractionPrompt({
      text: "Mounjaro 5mg weekly Wednesday morning starting next Monday",
      today: FIXED_TODAY,
      locale: "en",
    });
    expect(assembled).toMatchSnapshot();
  });

  it("snapshot — daily NSAID, three times a day", () => {
    const assembled = buildMedicationExtractionPrompt({
      text: "Ibuprofen 200mg every day, 3 times a day",
      today: FIXED_TODAY,
      locale: "en",
    });
    expect(assembled).toMatchSnapshot();
  });

  it("snapshot — weekly vitamin D, Sunday morning", () => {
    const assembled = buildMedicationExtractionPrompt({
      text: "Vitamin D 1000IU once per week on Sunday morning",
      today: FIXED_TODAY,
      locale: "en",
    });
    expect(assembled).toMatchSnapshot();
  });

  it("snapshot — single flu shot on a specific date", () => {
    const assembled = buildMedicationExtractionPrompt({
      text: "Single flu shot on October 15",
      today: FIXED_TODAY,
      locale: "en",
    });
    expect(assembled).toMatchSnapshot();
  });

  it("snapshot — flexible rolling dose, every 7 days from last intake", () => {
    const assembled = buildMedicationExtractionPrompt({
      text: "Methotrexate 7.5mg every 7 days from last injection",
      today: FIXED_TODAY,
      locale: "en",
    });
    expect(assembled).toMatchSnapshot();
  });
});

describe("buildMedicationExtractionUserPrompt", () => {
  it("includes the reference date and the trimmed description", () => {
    const out = buildMedicationExtractionUserPrompt({
      text: "   Mounjaro 5mg weekly   ",
      today: "2026-05-28",
      locale: "de",
    });
    expect(out).toContain("today=2026-05-28");
    expect(out).toContain("locale=de");
    expect(out).toContain("Mounjaro 5mg weekly");
    // The trim helper must strip the leading + trailing whitespace so
    // the model does not see ragged framing.
    expect(out).not.toMatch(/   Mounjaro/);
  });

  it("defaults the locale label to en when omitted", () => {
    const out = buildMedicationExtractionUserPrompt({
      text: "Daily 5mg",
      today: "2026-05-28",
    });
    expect(out).toContain("locale=en");
  });
});

describe("applyCitationGuard", () => {
  it("keeps name + dose when both appear verbatim in the original text", () => {
    const result: MedicationExtractionResult = {
      name: "Mounjaro",
      dose: "5",
      doseUnit: "mg",
      cadenceKind: "everyNWeeks",
      intervalWeeks: 1,
      weekdays: ["WE"],
      timesOfDay: ["08:00"],
    };
    const guarded = applyCitationGuard(
      result,
      "Mounjaro 5mg weekly Wednesday morning",
    );
    expect(guarded.name).toBe("Mounjaro");
    expect(guarded.dose).toBe("5");
    expect(guarded.doseUnit).toBe("mg");
    // Load-bearing inference (cadence + weekday) is preserved.
    expect(guarded.cadenceKind).toBe("everyNWeeks");
    expect(guarded.weekdays).toEqual(["WE"]);
  });

  it("drops a hallucinated name that does not appear in the user's text", () => {
    const result: MedicationExtractionResult = {
      name: "Wegovy",
      dose: "5",
      doseUnit: "mg",
    };
    const guarded = applyCitationGuard(
      result,
      "5mg every week on Wednesday morning",
    );
    expect(guarded.name).toBeUndefined();
    // The dose IS in the text, so it stays.
    expect(guarded.dose).toBe("5");
    expect(guarded.doseUnit).toBe("mg");
  });

  it("drops a hallucinated dose AND the trailing unit", () => {
    const result: MedicationExtractionResult = {
      name: "Mounjaro",
      dose: "10",
      doseUnit: "mg",
    };
    const guarded = applyCitationGuard(result, "Mounjaro weekly Wednesday");
    expect(guarded.name).toBe("Mounjaro");
    expect(guarded.dose).toBeUndefined();
    // The unit must vanish alongside the dose so the wizard does not
    // land on a free-floating "mg" with no number to attach it to.
    expect(guarded.doseUnit).toBeUndefined();
  });

  it("is case-insensitive on the substring check", () => {
    const result: MedicationExtractionResult = {
      name: "MOUNJARO",
      dose: "5",
    };
    const guarded = applyCitationGuard(result, "mounjaro 5mg weekly");
    expect(guarded.name).toBe("MOUNJARO");
    expect(guarded.dose).toBe("5");
  });

  it("never mutates the input object", () => {
    const result: MedicationExtractionResult = {
      name: "Wegovy",
      dose: "5",
      doseUnit: "mg",
    };
    const guarded = applyCitationGuard(result, "5mg weekly");
    // Input still carries the hallucinated name.
    expect(result.name).toBe("Wegovy");
    // Output dropped it.
    expect(guarded.name).toBeUndefined();
  });
});
