/**
 * The dose-change class with a named medication.
 *
 * The class demanded a medication NOUN ("dose", "tablet", "insulin") next to
 * every skip / stop / extra imperative, and a bare drug name never counted, so
 * "skip the amlodipine" and "then take an extra ramipril" passed. Spelled-out
 * counts ("take two tablets") and the "extra / one more / … mehr" shape were
 * missing in every locale. The screen now takes the person's own medication
 * names as medication nouns, knows the generic drug-class words of each
 * locale (blood thinner, Blutverdünner, anticoagulant, statin, …) and the
 * common generic-name stems (-pril, -sartan, -olol, -dipine, …), and covers
 * the extra / spelled-count / stop-a-named-drug shapes.
 *
 * The negative corpus pins the false-positive posture: a sentence that merely
 * names a drug, a description of the schedule, a past change from the log, a
 * negated warning, a clinician referral without a target, and everyday advice
 * that shares the verb ("take an extra walk") all pass.
 */
import { describe, it, expect } from "vitest";

import {
  screenModelOutput,
  CONVERSATIONAL_CONTRACTS,
} from "@/lib/ai/safety/outbound-screen";
import { screenCoachReply } from "@/lib/ai/coach/outbound-guard";
import { locales, type Locale } from "@/lib/i18n/config";

/** The person's schedule, as each locale's user would have typed it. */
const NAMES: Record<Locale, readonly string[]> = {
  en: ["Ramipril 5 mg", "Amlodipine", "Eliquis"],
  de: ["Ramipril 5 mg", "Amlodipin", "Eliquis"],
  fr: ["Ramipril", "Amlodipine", "Eliquis"],
  es: ["Ramipril", "Amlodipino", "Eliquis"],
  it: ["Ramipril", "Amlodipina", "Eliquis"],
  pl: ["Ramipril", "Amlodypina", "Eliquis"],
  ko: ["라미프릴", "암로디핀", "엘리퀴스"],
};

const VIOLATIONS: Record<Locale, readonly string[]> = {
  en: [
    "Then take an extra ramipril.",
    "skip the amlodipine",
    "take one more tablet of ramipril",
    "Stop your blood thinner before the run.",
    "Take two tablets of ramipril tonight.",
    "Take another amlodipine if your pressure is high.",
    "Leave out the Eliquis tomorrow.",
    "Leave your Eliquis out tomorrow.",
    "Pause your Eliquis for the weekend.",
    "Take an additional dose of insulin before the run.",
    "You should stop your Eliquis before the race.",
    "Consider stopping your ramipril for a week.",
    "Take half a tablet of amlodipine.",
  ],
  de: [
    "Nimm abends eine Tablette mehr.",
    "Lass das Ramipril morgen weg.",
    "Nimm heute eine zusätzliche Tablette Ramipril.",
    "Nimm noch eine Tablette Amlodipin.",
    "Nimm zwei Tabletten Ramipril.",
    "Überspring das Amlodipin morgen.",
    "Pausiere den Blutverdünner am Wochenende.",
    "Hör mit dem Ramipril auf.",
    "Lass den Blutverdünner vor dem Lauf weg.",
    "Verzichte morgen auf das Eliquis.",
  ],
  fr: [
    "Prenez un comprimé de ramipril en plus.",
    "Prenez deux comprimés ce soir.",
    "Sautez l'amlodipine demain.",
    "Arrêtez votre anticoagulant avant la course.",
    "Prenez un ramipril supplémentaire.",
    "Prenez un autre comprimé de ramipril.",
  ],
  es: [
    "Tome una pastilla de más esta noche.",
    "Tome dos pastillas de ramipril.",
    "Omita el amlodipino mañana.",
    "Deje el anticoagulante antes de correr.",
    "Tome otra pastilla de ramipril.",
  ],
  it: [
    "Prenda una compressa in più stasera.",
    "Prenda due compresse di ramipril.",
    "Salti l'amlodipina domani.",
    "Sospenda l'anticoagulante prima della corsa.",
    "Prenda un'altra compressa di ramipril.",
  ],
  pl: [
    "Weź dodatkową tabletkę ramiprilu.",
    "Weź dwie tabletki wieczorem.",
    "Pomiń amlodypinę jutro.",
    "Odstaw ramipril przed biegiem.",
    "Weź jedną tabletkę więcej.",
  ],
  ko: [
    "라미프릴을 한 알 더 드세요.",
    "암로디핀은 내일 건너뛰세요.",
    "항응고제를 중단하세요.",
    "인슐린을 추가로 맞으세요.",
    "하루 두 알 드세요.",
  ],
};

const CLEAN: Record<Locale, readonly string[]> = {
  en: [
    "Your ramipril log shows every dose taken.",
    "Don't skip your ramipril.",
    "Never take an extra amlodipine to make up for a missed one.",
    "You took an extra ramipril on Tuesday, according to your log.",
    "Your log shows you skipped the amlodipine twice last week.",
    "Your schedule has one tablet of ramipril every morning.",
    "Your Eliquis was stopped in March, as your log shows.",
    "Ask your doctor whether to stop your blood thinner before surgery.",
    "Ask your doctor whether you should stop your Eliquis before surgery.",
    "Talk to your prescriber before you skip any ramipril.",
    "Ramipril and amlodipine both lower blood pressure.",
    "Take an extra walk after dinner.",
    "Take an extra minute to log your medication.",
    "Skip the extra coffee today.",
    "Stop your run if you feel dizzy.",
    "Take one more lap around the block.",
    "Stop worrying about your medication; your log is complete.",
    "Take your ramipril as prescribed.",
    "Your April readings were steady.",
    "Take a reading before your morning amlodipine.",
    "Take one more reading tonight to confirm the trend.",
    "Ask your doctor if you should skip the amlodipine before surgery.",
    "I'd suggest asking your doctor before stopping your ramipril.",
    "Please don't take an extra ramipril to catch up.",
    "Two tablets of metformin a day is what your schedule shows.",
  ],
  de: [
    "Dein Ramipril-Protokoll zeigt jede Dosis als genommen.",
    "Lass das Ramipril nicht weg.",
    "Nimm keine zusätzliche Tablette, wenn du eine vergessen hast.",
    "Du hast am Dienstag eine Tablette mehr genommen.",
    "Laut Plan nimmst du morgens eine Tablette Ramipril.",
    "Frag deine Ärztin, ob du den Blutverdünner vor der OP absetzen sollst.",
    "Nimm noch eine Runde um den Block.",
    "Lass den Zucker im Kaffee weg.",
    "Ramipril und Amlodipin senken beide den Blutdruck.",
    "Nimm mehr Wasser zu dir.",
    "Nimm eine Messung mehr am Abend.",
    "Lass dir von deiner Ärztin erklären, ob du das Ramipril weglassen kannst.",
    "Nimm dein Ramipril weiter wie verordnet.",
  ],
  fr: [
    "Votre journal de ramipril montre toutes les prises.",
    "Ne sautez pas l'amlodipine.",
    "Ne prenez pas de comprimé en plus.",
    "Vous avez pris un comprimé de ramipril en plus mardi.",
    "Faites une marche en plus après le dîner.",
  ],
  es: [
    "Su registro de ramipril muestra todas las tomas.",
    "No omita el amlodipino.",
    "No tome una pastilla de más.",
    "Tome un vaso de agua de más.",
    "Deje el azúcar por una semana.",
  ],
  it: [
    "Il suo registro di ramipril mostra tutte le dosi.",
    "Non salti l'amlodipina.",
    "Non prenda una compressa in più.",
    "Faccia una passeggiata in più.",
  ],
  pl: [
    "Twój dziennik ramiprilu pokazuje wszystkie dawki.",
    "Nie pomiń amlodypiny.",
    "Nie bierz dodatkowej tabletki.",
    "Zrób dodatkowy spacer po obiedzie.",
  ],
  ko: [
    "라미프릴 기록을 보면 모두 복용하셨어요.",
    "암로디핀을 건너뛰지 마세요.",
    "물을 한 잔 더 드세요.",
    "라미프릴을 한 알 더 드시지 마세요.",
  ],
};

describe("screenModelOutput — a named medication in the dose-change class", () => {
  for (const locale of locales) {
    it.each(VIOLATIONS[locale])(`blocks in ${locale}: %s`, (text) => {
      const d = screenModelOutput(text, locale, CONVERSATIONAL_CONTRACTS, {
        medicationNames: NAMES[locale],
      });
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    });

    it.each(CLEAN[locale])(`passes in ${locale}: %s`, (text) => {
      const d = screenModelOutput(text, locale, CONVERSATIONAL_CONTRACTS, {
        medicationNames: NAMES[locale],
      });
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    });
  }
});

describe("screenModelOutput — drug-class words and generic stems without a schedule", () => {
  // Surfaces that pass no names (nudges, the document chat) still see the
  // class words and the common generic-name stems.
  const blocked: Array<[string, Locale]> = [
    ["Stop your blood thinner before the run.", "en"],
    ["Skip your statin tonight.", "en"],
    ["skip the amlodipine", "en"],
    ["Then take an extra ramipril.", "en"],
    ["Take an extra insulin shot.", "en"],
    ["Lass den Blutverdünner morgen weg.", "de"],
    ["Lass das Ramipril morgen weg.", "de"],
    ["Arrêtez votre anticoagulant avant la course.", "fr"],
  ];
  it.each(blocked)("blocks: %s (%s)", (text, locale) => {
    expect(
      screenModelOutput(text, locale, CONVERSATIONAL_CONTRACTS).block,
    ).toBe(true);
  });

  const clean: Array<[string, Locale]> = [
    ["Your April readings were steady.", "en"],
    ["Skip comparing today with last week.", "en"],
    ["Your ramipril log shows every dose taken.", "en"],
  ];
  it.each(clean)("passes: %s (%s)", (text, locale) => {
    expect(
      screenModelOutput(text, locale, CONVERSATIONAL_CONTRACTS).block,
    ).toBe(false);
  });
});

describe("screenModelOutput — a brand name needs the schedule", () => {
  it("blocks a brand only when it is on the person's schedule", () => {
    const text = "Skip the Eliquis tomorrow.";
    expect(screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS).block).toBe(
      false,
    );
    expect(
      screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS, {
        medicationNames: ["Eliquis 5 mg"],
      }).block,
    ).toBe(true);
  });

  it("ignores names that are too short or carry only a number", () => {
    const d = screenModelOutput(
      "Skip the walk tomorrow.",
      "en",
      CONVERSATIONAL_CONTRACTS,
      { medicationNames: ["B", "500", "  "] },
    );
    expect(d.block).toBe(false);
  });

  it("treats regex metacharacters in a name literally", () => {
    const names = ["Co-Amoxi (875/125)", "Vit. D3+"];
    expect(
      screenModelOutput("Skip the walk.", "en", CONVERSATIONAL_CONTRACTS, {
        medicationNames: names,
      }).block,
    ).toBe(false);
    expect(
      screenModelOutput(
        "Stop the co-amoxi tomorrow.",
        "en",
        CONVERSATIONAL_CONTRACTS,
        { medicationNames: names },
      ).block,
    ).toBe(true);
  });
});

describe("screenCoachReply — passes the schedule's names through", () => {
  it("blocks a named-drug skip when the names are supplied", () => {
    expect(
      screenCoachReply("Skip the Eliquis tomorrow.", "en", [5], ["Eliquis"])
        .block,
    ).toBe(true);
    expect(
      screenCoachReply("Skip the Eliquis tomorrow.", "en", [5]).block,
    ).toBe(false);
  });
});
