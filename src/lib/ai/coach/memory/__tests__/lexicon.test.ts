import { describe, expect, it } from "vitest";

import { containsHealthTerm, healthTermKind } from "../lexicon";

describe("healthTermKind", () => {
  it.each([
    ["Takes Mounjaro since May", "medication"],
    ["Nimmt seit Mai Ozempic", "medication"],
    ["Started metformin last year", "medication"],
    ["Is on ramipril", "medication"],
    ["Nimmt Ramipril", "medication"],
    ["Takes two pills in the morning", "medication"],
    ["Has type 2 diabetes", "condition"],
    ["Hat Bluthochdruck", "condition"],
    ["Erdnussallergie", "condition"],
    ["Has chronic lower back pain", "condition"],
    ["Hat Rückenschmerzen", "condition"],
    ["Is pregnant", "condition"],
  ] as const)("reads %j as %s", (text, kind) => {
    expect(healthTermKind(text)).toBe(kind);
  });

  it.each([
    "Prefers morning workouts",
    "Wants to reach 75 kg by December",
    "Works night shifts twice a week",
    "Läuft gern am Wochenende",
    "Has two kids",
  ])("leaves %j alone", (text) => {
    expect(healthTermKind(text)).toBeNull();
    expect(containsHealthTerm(text)).toBe(false);
  });
});
