/**
 * v1.16.0 — structured self-context unit tests.
 *
 * Pins the pure pieces of the questionnaire feature without a DB:
 *   - `deriveAgeYears` — whole-year age math incl. the pre-birthday edge.
 *   - `composeSelfContextText` — merge order (profile facts → structured
 *     answers → free text), the profile-facts-alone-stay-silent rule,
 *     and the de/en label split.
 *   - `clampPendingQuestions` — count + length caps, non-string drops.
 *   - `parseQuestionsReply` — tolerant JSON-array extraction from a
 *     model reply (fences, prose, garbage).
 *   - `buildFallbackQuestions` — deterministic two-hint fallback in
 *     priority order, localised.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  clampPendingQuestions,
  composeSelfContextText,
  composeStructuredRecordsText,
  deriveAgeYears,
  PENDING_QUESTION_MAX_CHARS,
  type SelfContext,
} from "../about-me";
import {
  buildFallbackQuestions,
  buildPrompts,
  parseQuestionsReply,
} from "../self-context-questions";

const emptyCtx: SelfContext = {
  aboutMe: null,
  conditions: null,
  allergies: null,
  coachFocus: null,
};

describe("deriveAgeYears", () => {
  const now = new Date("2026-06-10T12:00:00Z");

  it("counts whole years after the birthday", () => {
    expect(deriveAgeYears(new Date("1980-06-01"), now)).toBe(46);
  });

  it("does not count the year before the birthday", () => {
    expect(deriveAgeYears(new Date("1980-06-20"), now)).toBe(45);
  });

  it("returns null for unknown or implausible dates", () => {
    expect(deriveAgeYears(null, now)).toBeNull();
    expect(deriveAgeYears(new Date("1850-01-01"), now)).toBeNull();
    expect(deriveAgeYears(new Date("2030-01-01"), now)).toBeNull();
  });
});

describe("composeSelfContextText", () => {
  const profile = { ageYears: 46, gender: "MALE" };

  it("stays null when the user wrote nothing — profile facts alone are not a self-description", () => {
    expect(composeSelfContextText(emptyCtx, profile, "de")).toBeNull();
  });

  it("merges profile facts, structured answers, and free text in order (de labels)", () => {
    const text = composeSelfContextText(
      {
        aboutMe: "Schichtarbeit, Halbmarathon-Training.",
        conditions: "Hypertonie",
        allergies: "Laktose",
        coachFocus: "Blutdruck",
      },
      profile,
      "de",
    );
    expect(text).toBe(
      [
        "Profil: Alter: 46 · Geschlecht: männlich",
        "Chronische Erkrankungen: Hypertonie",
        "Allergien / Unverträglichkeiten: Laktose",
        "Darauf soll der Coach achten: Blutdruck",
        "",
        "Schichtarbeit, Halbmarathon-Training.",
      ].join("\n"),
    );
  });

  it("uses English labels for every non-de locale", () => {
    const text = composeSelfContextText(
      { ...emptyCtx, conditions: "asthma" },
      { ageYears: null, gender: "OTHER" },
      "pl",
    );
    expect(text).toBe(
      ["Profile: Gender: non-binary", "Chronic conditions: asthma"].join("\n"),
    );
  });

  it("skips unknown gender codes instead of echoing them", () => {
    const text = composeSelfContextText(
      { ...emptyCtx, aboutMe: "hello" },
      { ageYears: null, gender: "SOMETHING_ELSE" },
      "en",
    );
    expect(text).toBe("hello");
  });
});

describe("composeStructuredRecordsText", () => {
  it("stays null when both structured stores are empty", () => {
    expect(composeStructuredRecordsText([], [], "en")).toBeNull();
  });

  it("renders allergies from stored fields only (severity, reaction, non-active status)", () => {
    const text = composeStructuredRecordsText(
      [
        {
          substance: "Penicillin",
          type: "ALLERGY",
          severity: "SEVERE",
          status: "ACTIVE",
          reaction: "Anaphylaxis",
        },
        {
          substance: "Lactose",
          type: "INTOLERANCE",
          severity: null,
          status: "RESOLVED",
          reaction: null,
        },
      ],
      [],
      "en",
    );
    expect(text).toContain("Penicillin (severe, reaction: Anaphylaxis)");
    expect(text).toContain("Lactose (intolerance, resolved)");
  });

  it("renders family history with relationship labels and onset age (de)", () => {
    const text = composeStructuredRecordsText(
      [],
      [
        { relationship: "MOTHER", condition: "Typ-2-Diabetes", ageAtOnset: 55 },
        { relationship: "FATHER", condition: "Hypertonie", ageAtOnset: null },
      ],
      "de",
    );
    expect(text).toContain("Familienanamnese");
    expect(text).toContain("Mutter: Typ-2-Diabetes (Beginn mit 55)");
    expect(text).toContain("Vater: Hypertonie");
    expect(text).not.toContain("Vater: Hypertonie (");
  });
});

describe("clampPendingQuestions", () => {
  it("caps at 3 questions and per-question length", () => {
    const long = "x".repeat(PENDING_QUESTION_MAX_CHARS + 50);
    const result = clampPendingQuestions(["a", "b", long, "d"]);
    expect(result).toHaveLength(3);
    expect(result[2]).toHaveLength(PENDING_QUESTION_MAX_CHARS);
  });

  it("drops non-strings, blanks, and non-arrays", () => {
    expect(clampPendingQuestions(["  ok  ", 42, "", null])).toEqual(["ok"]);
    expect(clampPendingQuestions("not an array")).toEqual([]);
    expect(clampPendingQuestions(undefined)).toEqual([]);
  });
});

describe("parseQuestionsReply", () => {
  it("parses a bare JSON array", () => {
    expect(parseQuestionsReply('["Frage 1?", "Frage 2?"]')).toEqual([
      "Frage 1?",
      "Frage 2?",
    ]);
  });

  it("tolerates code fences and prose around the array", () => {
    const reply =
      'Sure! Here are the questions:\n```json\n["A?", "B?"]\n```\nHope that helps.';
    expect(parseQuestionsReply(reply)).toEqual(["A?", "B?"]);
  });

  it("yields [] for garbage so the caller falls back", () => {
    expect(parseQuestionsReply("no array here")).toEqual([]);
    expect(parseQuestionsReply("[broken")).toEqual([]);
    expect(parseQuestionsReply('{"not": "an array"}')).toEqual([]);
  });
});

describe("buildFallbackQuestions", () => {
  it("returns the first two missing fields in priority order, localised", () => {
    const hints = buildFallbackQuestions(emptyCtx, "de");
    expect(hints).toEqual([
      "Hast du chronische Erkrankungen, die der Coach kennen sollte?",
      "Gibt es etwas Bestimmtes, worauf der Coach achten soll?",
    ]);
  });

  it("skips answered fields", () => {
    const hints = buildFallbackQuestions(
      {
        aboutMe: "text",
        conditions: "hypertension",
        allergies: null,
        coachFocus: "bp",
      },
      "en",
    );
    expect(hints).toEqual(["Do you have any allergies or intolerances?"]);
  });

  it("never offers questions for excluded fields", () => {
    const hints = buildFallbackQuestions(emptyCtx, "en", ["ABOUT_ME"]);

    expect(hints).toEqual([
      "Want to tell the Coach a bit about yourself: routines, goals, context?",
    ]);
  });

  it("returns nothing for a fully answered questionnaire", () => {
    expect(
      buildFallbackQuestions(
        {
          aboutMe: "a",
          conditions: "b",
          allergies: "c",
          coachFocus: "d",
        },
        "en",
      ),
    ).toEqual([]);
  });
});

describe("buildPrompts", () => {
  // v1.16.6 — the questions completion rides the Coach snapshot so the
  // model can ask about what the user actually tracks.
  it("appends the health-data snapshot block when one is available", () => {
    const { systemPrompt, userPrompt } = buildPrompts(
      { ...emptyCtx, coachFocus: "sleep" },
      "en",
      '{"weight":{"trend":"down"}}',
    );
    expect(userPrompt).toContain("HEALTH DATA SNAPSHOT");
    expect(userPrompt).toContain('{"weight":{"trend":"down"}}');
    expect(userPrompt).toContain("coach focus: sleep");
    expect(systemPrompt).toContain("health-data snapshot");
  });

  it("stays fields-only without a snapshot", () => {
    const { userPrompt } = buildPrompts(emptyCtx, "en", null);
    expect(userPrompt).not.toContain("HEALTH DATA SNAPSHOT");
    expect(userPrompt).toContain("conditions: (not answered)");
  });

  it("omits excluded fields from the model prompt", () => {
    const { systemPrompt, userPrompt } = buildPrompts(emptyCtx, "en", null, [
      "COACH_FOCUS",
    ]);

    expect(userPrompt).toBe("coach focus: (not answered)");
    expect(systemPrompt).toContain(
      "Omitted fields are excluded by the user and must never be requested.",
    );
  });
});
