import { describe, it, expect } from "vitest";

import {
  screenModelOutput,
  CONVERSATIONAL_CONTRACTS,
  INSIGHTS_CONTRACTS,
} from "@/lib/ai/safety/outbound-screen";
import { locales, type Locale } from "@/lib/i18n/config";

/**
 * The whole point of threading locale is that fr / es / it / pl are enforced,
 * not just en / de. Every contract below is asserted in all six languages: a
 * violating sentence written in the reader's language must be caught, and an
 * ordinary sentence in that same language must pass untouched.
 */

// ── dose-prescription ────────────────────────────────────────────────────

const DOSE_VIOLATIONS: Record<Locale, string> = {
  en: "You should step up to 2.4 mg next week.",
  de: "Erhöhe auf 7,5 mg, sobald du dich daran gewöhnt hast.",
  fr: "Augmentez votre dose à 2,4 mg la semaine prochaine.",
  es: "Aumente su dosis a 2,4 mg la próxima semana.",
  it: "Aumenti la sua dose a 2,4 mg la prossima settimana.",
  pl: "Proszę zwiększyć dawkę do 2,4 mg w przyszłym tygodniu.",
  nl: "Verhoog je dosis volgende week naar 2,4 mg.",
  "pt-BR": "Aumente sua dose para 2,4 mg na próxima semana.",
  ko: "다음 주에 2.4mg으로 늘려 보세요.",
  ru: "Увеличьте дозу до 2,4 мг со следующей недели.",
};

/**
 * Factual restatements of a CURRENT dose. The contracts explicitly permit
 * these, so a screen that flagged them would make the Coach useless on exactly
 * the topic users bring it.
 */
const DOSE_CLEAN: Record<Locale, string> = {
  en: "You're in week 3 on 7.5 mg, and your weight is tracking down.",
  de: "Du bist in Woche 3 bei 7,5 mg, und dein Gewicht geht zurück.",
  fr: "Vous êtes en semaine 3 à 7,5 mg, et votre poids diminue.",
  es: "Está en la semana 3 con 7,5 mg, y su peso está bajando.",
  it: "È alla settimana 3 con 7,5 mg, e il suo peso sta calando.",
  pl: "Jest Pan w 3. tygodniu na 7,5 mg, a waga spada.",
  nl: "Je zit in week 3 op 7,5 mg, en je gewicht gaat omlaag.",
  "pt-BR": "Você está na semana 3 com 7,5 mg, e seu peso está diminuindo.",
  ko: "3주째 7.5mg을 복용 중이고, 체중은 내려가고 있어요.",
  ru: "Вы третью неделю на 7,5 мг, и вес понемногу снижается.",
};

describe("screenModelOutput — dose-prescription, all six locales", () => {
  for (const locale of locales) {
    it(`blocks a dose-change imperative in ${locale}`, () => {
      const d = screenModelOutput(
        DOSE_VIOLATIONS[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    });

    it(`passes a factual dose restatement in ${locale}`, () => {
      const d = screenModelOutput(
        DOSE_CLEAN[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    });
  }
});

describe("screenModelOutput — a German change verb with its object", () => {
  it.each([
    "Erhöhe deine Dosis auf 2,4 mg pro Woche.",
    "Steigere die Dosierung um 0,5 mg.",
    "Reduziere deine Dosis auf 5 mg.",
    "Senke die Tagesdosis auf 25 mg.",
  ])("blocks %s", (text) => {
    const d = screenModelOutput(text, "de", CONVERSATIONAL_CONTRACTS);
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });

  it("still passes a restatement that names the dose", () => {
    const d = screenModelOutput(
      "Deine Dosis liegt seit drei Wochen bei 7,5 mg.",
      "de",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });
});

// ── risk-score fabrication ───────────────────────────────────────────────

const RISK_VIOLATIONS: Record<Locale, string> = {
  en: "Your 10-year cardiovascular risk is about 12%.",
  de: "Dein Risiko liegt bei etwa 14%.",
  fr: "Votre risque est d'environ 12%.",
  es: "Su riesgo es del 12%.",
  it: "Il suo rischio è del 12%.",
  pl: "Pana ryzyko wynosi 12%.",
  nl: "Je risico ligt op ongeveer 12%.",
  "pt-BR": "Seu risco é de cerca de 12%.",
  ko: "10년 심혈관 위험도는 약 12%예요.",
  ru: "Ваш 10-летний сердечно-сосудистый риск — около 12%.",
};

/** A plain percentage that is NOT a clinical risk claim must pass. */
const RISK_CLEAN: Record<Locale, string> = {
  en: "Your adherence was 92% over the last 30 days.",
  de: "Deine Einnahmetreue lag bei 92% in den letzten 30 Tagen.",
  fr: "Votre observance était de 92% sur les 30 derniers jours.",
  es: "Su adherencia fue del 92% en los últimos 30 días.",
  it: "La sua aderenza è stata del 92% negli ultimi 30 giorni.",
  pl: "Przestrzeganie zaleceń wyniosło 92% w ostatnich 30 dniach.",
  nl: "Je therapietrouw was 92% in de afgelopen 30 dagen.",
  "pt-BR": "Sua adesão foi de 92% nos últimos 30 dias.",
  ko: "지난 30일 복약 순응도는 92%였어요.",
  ru: "Приверженность лечению за последние 30 дней — 92%.",
};

describe("screenModelOutput — risk-score, all six locales", () => {
  for (const locale of locales) {
    it(`blocks a fabricated clinical risk figure in ${locale}`, () => {
      const d = screenModelOutput(
        RISK_VIOLATIONS[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    });

    it(`passes a non-risk percentage in ${locale}`, () => {
      const d = screenModelOutput(
        RISK_CLEAN[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(false);
    });
  }
});

// ── issue #587 — bare "score" is not a fabricated clinical risk score ─────

/**
 * The named-risk-engine pattern used `score2?` (the `2` optional), so it
 * matched bare "score" too — any mention of one of THIS APP's own computed,
 * documented scores (Sleep Score, Readiness Score, Health Score, …) tripped
 * the fabricated-risk-engine bank meant for SCORE2/Framingham/ASCVD/QRISK.
 */
const WELLNESS_SCORE_CLEAN: readonly string[] = [
  "Your Sleep Score is based on sleep duration and stage balance.",
  "Your Readiness Score is lower than your recent baseline.",
  "This Health Score is based on the available tracked pillars.",
  "Your Recovery Score and Stress Score both moved this week.",
  "The Strain Score reflects yesterday's training load.",
];

describe("screenModelOutput — issue #587 ordinary wellness-score wording", () => {
  for (const text of WELLNESS_SCORE_CLEAN) {
    it(`passes: ${text}`, () => {
      const d = screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    });
  }

  it("blocks a named engine paired with a fabricated number", () => {
    const d = screenModelOutput(
      "Based on SCORE2, your risk sits at about 14%.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("blocks a named engine paired with a categorical result verdict (numberless)", () => {
    for (const engine of [
      "Based on Framingham, you fall into the intermediate-risk category.",
      "SCORE2 would put you in the high-risk band given your profile.",
      "QRISK classifies you as elevated-risk group.",
    ]) {
      const d = screenModelOutput(engine, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    }
  });

  it("PASSES a bare engine mention with no asserted result or figure (D1/D4)", () => {
    // Naming what ASCVD is — education or a refusal — is not a fabrication.
    for (const mention of [
      "I can't compute your ASCVD, that's for your clinician.",
      "An ASCVD score is something a doctor calculates from lab values.",
      "Framingham and QRISK are two examples of cardiovascular risk tools.",
    ]) {
      const d = screenModelOutput(mention, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    }
  });
});

// ── D1/D4 — hedge-then-assert, spelled-out percent, model-perfect refusal ──

describe("screenModelOutput — risk narrowing (D1/D4/M4)", () => {
  it("blocks the hedge-then-assert bypass (H1) — the 14% is caught", () => {
    const d = screenModelOutput(
      "I can't compute your exact ASCVD score, but based on your numbers your risk is about 14%.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("blocks a spelled-out percent risk figure (H4b)", () => {
    for (const text of [
      "Your ten-year cardiovascular risk is roughly twelve percent.",
      "Your ten-year risk is roughly twelve percent.",
    ]) {
      const d = screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    }
  });

  it("blocks a numberless categorical engine result (H4a)", () => {
    const d = screenModelOutput(
      "SCORE2 would put you in the high-risk band.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("blocks a numberless categorical risk-level verdict on the horizon", () => {
    const d = screenModelOutput(
      "Your 10-year cardiovascular risk is elevated — consider stepping your dose up.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("PASSES a model-perfect refusal that names the horizon and the engine (M4)", () => {
    const d = screenModelOutput(
      "I can't calculate a 10-year cardiovascular risk for you — an ASCVD score is something your clinician computes with lab values I don't have.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("blocks a DE spelled-out percent risk figure and a DE engine result", () => {
    expect(
      screenModelOutput(
        "Dein Risiko liegt bei etwa zwölf Prozent.",
        "de",
        CONVERSATIONAL_CONTRACTS,
      ).block,
    ).toBe(true);
    expect(
      screenModelOutput(
        "SCORE2 würde dich in den hohen Risikobereich einordnen.",
        "de",
        CONVERSATIONAL_CONTRACTS,
      ).block,
    ).toBe(true);
  });

  it("PASSES a DE bare-horizon refusal with no figure", () => {
    const d = screenModelOutput(
      "Ein 10-Jahres-Risiko kann ich dir nicht berechnen, das macht deine Ärztin.",
      "de",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });
});

// ── D7 — dose continuation-exclusion ─────────────────────────────────────

describe("screenModelOutput — dose continuation-exclusion (D7)", () => {
  const PLAN = [{ name: "Semaglutide", dose: 7.5 }];

  it("PASSES an adherence-supporting continuation of the planned dose", () => {
    const d = screenModelOutput(
      "You should keep taking your prescribed semaglutide 7.5 mg exactly as directed.",
      "en",
      CONVERSATIONAL_CONTRACTS,
      { dosePlan: PLAN },
    );
    expect(d.block).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("blocks the same continuation where no plan can confirm the amount", () => {
    const d = screenModelOutput(
      "You should keep taking your prescribed 7.5 mg exactly as directed.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
  });

  it("still blocks 'keep in mind that trying 5 mg' — no maintenance anchor", () => {
    const d = screenModelOutput(
      "You should keep in mind that trying 5 mg could help.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });

  it("still blocks 'continue tapering to 2.4 mg' — a change stem voids the exemption", () => {
    for (const text of [
      "You should continue tapering to 2.4 mg next week.",
      "Continue tapering to 2.4 mg next week.",
    ]) {
      const d = screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    }
  });

  it("still blocks 'you should try 5 mg' — exclusion is of continuation, not requirement of change", () => {
    const d = screenModelOutput(
      "You should try 5 mg and see how it feels.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });

  it("PASSES a DE continuation that trips a DE dose pattern but is anchored", () => {
    // "du solltest … 7,5 mg" trips the DE consider/should dose pattern; the
    // "weiterhin … wie verordnet" maintenance anchor exempts it.
    const d = screenModelOutput(
      "Du solltest weiterhin dein Semaglutid 7,5 mg wie verordnet einnehmen.",
      "de",
      CONVERSATIONAL_CONTRACTS,
      { dosePlan: PLAN },
    );
    expect(d.block).toBe(false);
  });

  it("still blocks a DE dose increase even with a continuation word present", () => {
    const d = screenModelOutput(
      "Du solltest weiterhin erhöhen, und zwar auf 5 mg.",
      "de",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });
});

// ── causal claims (GROUND RULE 12) ───────────────────────────────────────

const CAUSAL_VIOLATIONS: Record<Locale, string> = {
  en: "Your weight fell because you slept more.",
  de: "Dein Gewicht sank wegen des Schlafs.",
  fr: "Votre poids a baissé parce que vous avez mieux dormi.",
  es: "Su peso bajó porque durmió más.",
  it: "Il suo peso è calato perché ha dormito di più.",
  pl: "Waga spadła, ponieważ spał Pan więcej.",
  nl: "Je gewicht daalde omdat je meer sliep.",
  "pt-BR": "Seu peso caiu porque você dormiu mais.",
  ko: "수면 때문에 체중이 줄었어요.",
  ru: "Ваш вес снизился, потому что вы больше спали.",
};

/** Descriptive association framing is what the contract REQUIRES. */
const CAUSAL_CLEAN: Record<Locale, string> = {
  en: "Your weight moved with your sleep this week.",
  de: "Dein Gewicht bewegte sich diese Woche mit deinem Schlaf.",
  fr: "Votre poids a évolué avec votre sommeil cette semaine.",
  es: "Su peso evolucionó junto con su sueño esta semana.",
  it: "Il suo peso si è mosso insieme al suo sonno questa settimana.",
  pl: "Waga zmieniała się razem ze snem w tym tygodniu.",
  nl: "Je gewicht bewoog deze week mee met je slaap.",
  "pt-BR": "Seu peso acompanhou o seu sono nesta semana.",
  ko: "이번 주 체중은 수면과 함께 움직였어요.",
  ru: "На этой неделе вес двигался вместе со сном.",
};

describe("screenModelOutput — causal claims, all six locales", () => {
  for (const locale of locales) {
    it(`blocks asserted causation in ${locale}`, () => {
      const d = screenModelOutput(
        CAUSAL_VIOLATIONS[locale],
        locale,
        INSIGHTS_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("causal_claim");
    });

    it(`passes descriptive association framing in ${locale}`, () => {
      const d = screenModelOutput(
        CAUSAL_CLEAN[locale],
        locale,
        INSIGHTS_CONTRACTS,
      );
      expect(d.block).toBe(false);
    });
  }
});

// ── contract selection ───────────────────────────────────────────────────

describe("screenModelOutput — contract selection", () => {
  it("does NOT flag causal wording under the conversational contracts", () => {
    // The Coach must keep "because" — GROUND RULE 12's surface is `insights`,
    // and blocking it conversationally would gut ordinary explanation.
    const d = screenModelOutput(
      CAUSAL_VIOLATIONS.en,
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });

  it("flags the same sentence under the insights contracts", () => {
    const d = screenModelOutput(CAUSAL_VIOLATIONS.en, "en", INSIGHTS_CONTRACTS);
    expect(d.block).toBe(true);
  });

  it("reports dose before risk when a reply trips both", () => {
    const d = screenModelOutput(
      "Your risk is 12% — step up to 2.4 mg.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.reason).toBe("dose_prescription");
  });
});

// ── cross-language coverage ──────────────────────────────────────────────

describe("screenModelOutput — English violations reach non-English readers", () => {
  /**
   * A provider routinely answers in English regardless of the locale
   * directive. If the screen consulted only the reader's bank, the proven
   * English violation shapes would pass on five of six locales.
   */
  for (const locale of locales) {
    it(`blocks an English dose imperative for a ${locale} reader`, () => {
      const d = screenModelOutput(
        DOSE_VIOLATIONS.en,
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    });
  }
});

describe("screenModelOutput — empty input", () => {
  it("passes empty and whitespace-only text (handled upstream)", () => {
    expect(screenModelOutput("", "en", INSIGHTS_CONTRACTS).block).toBe(false);
    expect(screenModelOutput("   ", "fr", INSIGHTS_CONTRACTS).block).toBe(
      false,
    );
  });
});

// ── the dose-change class ────────────────────────────────────────────────

/**
 * "Increase your metformin to 2000 mg daily" passed the screen: the English
 * change pattern allowed only "it" or "your dose" between the verb and "to",
 * so naming the drug walked past it. These cases pin the class — a change
 * verb with any short object and a target, an imperative to take a stated
 * amount, and an imperative to halve / skip / stop a medication — in every
 * locale the banks cover.
 */
const DOSE_CLASS_VIOLATIONS: Record<Locale, readonly string[]> = {
  en: [
    "Reduce your dose by half.",
    "Cut your dose in half.",
    "Take half a dose.",
    "Take half your usual dose.",
    "Reduce your dose.",
    "Increase your insulin.",
    "Lower your ramipril a little.",
    "Increase your metformin to 2000 mg daily.",
    "Raise your insulin by 4 units tonight.",
    "Up your metformin to 1500 mg.",
    "Bump the semaglutide to 1 mg next week.",
    "Titrate your evening insulin up to 20 units.",
    "Reduce your metformin from 2000 mg to 1000 mg.",
    "Lower your lisinopril to 5 mg.",
    "Halve your metformin to 500 mg.",
    "Double your vitamin D to 4000 IU.",
    "Take 2000 mg daily.",
    "Take 3 tablets of metformin with dinner.",
    "Here's the plan: take 2 pills in the morning.",
    "Your glucose ran high.\nTake 1000 mg more tonight.",
    "It might be worth increasing your metformin to 2000 mg.",
    "Skip your evening dose tonight.",
    "Consider skipping tonight's insulin dose.",
    "Stop taking metformin.",
    "You should stop taking your lisinopril.",
  ],
  de: [
    "Reduzieren Sie die Dosis um die Hälfte.",
    "Reduziere deine Dosis um die Hälfte.",
    "Nehmen Sie nur die halbe Dosis.",
    "Teilen Sie die Tablette in zwei Hälften.",
    "Reduzieren Sie die Dosis.",
    "Erhöhe dein Insulin.",
    "Senken Sie die Dosis etwas.",
    "Erhöhe dein Metformin auf 2000 mg täglich.",
    "Reduzieren Sie Ihr Insulin um 4 Einheiten.",
    "Nimm 2 Tabletten am Abend.",
    "Halbiere deine Insulindosis.",
    "Lass die Abenddosis heute aus.",
    "Setz dein Metformin ab.",
    "Du solltest das Metformin absetzen.",
  ],
  fr: [
    "Réduisez la dose de moitié.",
    "Prenez une demi-dose.",
    "Prenez la moitié de votre dose.",
    "Coupez le comprimé en deux.",
    "Diminuez votre dose.",
    "Augmentez votre insuline.",
    "Augmentez votre metformine à 2000 mg.",
    "Réduisez votre insuline de 4 unités.",
    "Prenez 2 comprimés le soir.",
    "Sautez la dose du soir.",
    "Arrêtez de prendre la metformine.",
  ],
  es: [
    "Reduzca la dosis a la mitad.",
    "Tome media dosis.",
    "Tome la mitad de la dosis.",
    "Parta la pastilla por la mitad.",
    "Reduzca la dosis.",
    "Aumente la insulina.",
    "Aumente su metformina a 2000 mg.",
    "Reduzca la insulina en 4 unidades.",
    "Tome 2 pastillas por la noche.",
    "Omita la dosis de la noche.",
    "Deje de tomar la metformina.",
  ],
  it: [
    "Riduca la dose della metà.",
    "Riduca la dose a metà.",
    "Prenda mezza dose.",
    "Prenda metà della dose.",
    "Riduca la dose.",
    "Aumenti l'insulina.",
    "Aumenti la metformina a 2000 mg.",
    "Riduca l'insulina di 4 unità.",
    "Prenda 2 compresse la sera.",
    "Salti la dose serale.",
    "Smetta di prendere la metformina.",
  ],
  pl: [
    "Zmniejsz dawkę o połowę.",
    "Weź pół tabletki.",
    "Weź połowę dawki.",
    "Przyjmij pół dawki.",
    "Zmniejsz dawkę.",
    "Zwiększ dawkę insuliny.",
    "Odstaw ramipryl.",
    "Odstaw enalapryl.",
    "Zwiększ metforminę do 2000 mg.",
    "Zmniejsz insulinę o 4 jednostki.",
    "Proszę przyjąć 2 tabletki wieczorem.",
    "Pomiń wieczorną dawkę.",
    "Przestań brać metforminę.",
  ],
  nl: [
    "Verlaag je dosis met de helft.",
    "Neem een halve dosis.",
    "Verlaag je dosis.",
    "Verhoog je insuline.",
    "Verhoog je metformine naar 2000 mg per dag.",
    "Verlaag je insuline met 4 eenheden.",
    "Neem 's avonds 2 tabletten.",
    "Halveer je insulinedosis.",
    "Sla de avonddosis vandaag over.",
    "Stop met het innemen van metformine.",
    "Je zou de metformine een week kunnen stoppen.",
    "Bouw je dosis af naar 5 mg.",
  ],
  "pt-BR": [
    "Reduza a dose pela metade.",
    "Tome meia dose.",
    "Tome metade da dose.",
    "Corte o comprimido ao meio.",
    "Diminua a dose.",
    "Reduza a dose.",
    "Aumente a insulina.",
    "Aumente sua metformina para 2000 mg por dia.",
    "Reduza sua insulina em 4 unidades.",
    "Tome 2 comprimidos à noite.",
    "Pule a dose da noite.",
    "Pare de tomar a metformina.",
    "Você poderia suspender a metformina por uma semana.",
    "Diminua a dose para 5 mg.",
    "Dobre a dose de insulina.",
    "Passe a tomar 10 mg pela manhã.",
    "Aplique 12 UI de insulina antes do jantar.",
  ],
  ko: [
    "복용량을 늘리세요.",
    "복용량을 줄이세요.",
    "인슐린 용량을 낮추세요.",
    "반 알만 드세요.",
    "용량을 늘려 보세요.",
    "메트포르민을 2000mg으로 증량하세요.",
    "하루 2정 드세요.",
    "저녁 인슐린 용량을 건너뛰세요.",
    "메트포르민 복용을 중단하세요.",
  ],
  ru: [
    "Снизьте дозу вдвое.",
    "Уменьшите дозу наполовину.",
    "Сократите дозу.",
    "Увеличьте инсулин.",
    "Немного снизьте рамиприл.",
    "Увеличьте метформин до 2000 мг в сутки.",
    "Поднимите инсулин на 4 единицы сегодня вечером.",
    "Удвойте витамин D до 4000 МЕ.",
    "Принимайте 2000 мг в сутки.",
    "Принимайте 3 таблетки метформина с ужином.",
    "Пропустите вечернюю дозу сегодня.",
    "Отмените вечерний укол инсулина.",
    "Прекратите приём метформина.",
    "Вам стоит прекратить приём лизиноприла.",
    "Примите ещё одну таблетку рамиприла.",
    "Начните с 5 мг завтра.",
    "Перейдите на 10 мг.",
    "Снизьте дозу до 1000 мг.",
    "Перестаньте принимать варфарин перед поездкой.",
    "Можете бросить принимать бисопролол.",
    "Колите инсулин 10 ЕД перед сном.",
    "Выпейте две таблетки ибупрофена.",
    "Увеличьте дозу витамина D до 4000 МЕ.",
    "Снизьте инсулин до 20 ЕД.",
  ],
};

/**
 * What must keep passing: a restatement of the logged schedule, a clinician
 * referral that names no target, a negated imperative (a warning), a past
 * change described from the log, and the ordinary non-dose advice that shares
 * a verb or a unit with the class — steps, walks, sodium, water, and lab
 * targets written as a concentration.
 */
const DOSE_CLASS_CLEAN: Record<Locale, readonly string[]> = {
  en: [
    "Reduce your sugar intake by half.",
    "Cut your screen time in half.",
    "Take half an hour to walk.",
    "Reduce your salt.",
    "Ask your doctor whether to reduce your dose.",
    "Your dose was reduced by half in May.",
    "Don't reduce your dose.",
    "Increase your activity.",
    "Lower your blood pressure with walks.",
    "Take your medication as prescribed.",
    "You take 1000 mg twice daily.",
    "Your log shows 2000 mg.",
    "Your log shows you take 1000 mg twice daily, and you haven't missed a dose.",
    "Ask your doctor whether to increase your dose.",
    "Talk to your doctor before you stop taking your metformin.",
    "Don't skip your evening dose.",
    "Never stop taking metformin without talking to your prescriber.",
    "Your dose was increased to 2000 mg in May.",
    "Since your metformin was raised to 2000 mg, your fasting glucose dropped.",
    "Double your steps for two weeks.",
    "Skip the evening walk if it rains.",
    "Stop using your phone an hour before bed.",
    "Lower your sodium to 1500 mg a day.",
    "Increase your water intake to 2000 ml.",
    "Try to keep your glucose under 140 mg/dL after meals.",
    "Aim to bring your LDL down to 100 mg/dL with your doctor.",
  ],
  de: [
    "Reduzieren Sie den Zucker um die Hälfte.",
    "Reduziere deinen Salzkonsum.",
    "Deine Dosis wurde im Mai halbiert.",
    "Reduziere die Dosis nicht.",
    "Nimm dir eine halbe Stunde Zeit.",
    "Teilen Sie Ihre Medikamentenliste mit der Ärztin.",
    "Du nimmst 1000 mg zweimal täglich.",
    "Dein Protokoll zeigt 2000 mg.",
    "Setz dein Metformin nicht ab.",
    "Lass keine Dosis aus.",
    "Frag deine Ärztin, ob du die Dosis erhöhen sollst.",
  ],
  fr: [
    "Réduisez le sel de moitié.",
    "Prenez une demi-heure pour marcher.",
    "Ne réduisez pas votre dose.",
    "Augmentez votre activité.",
    "Vous prenez 1000 mg deux fois par jour.",
    "Ne sautez pas votre dose du soir.",
    "N'arrêtez pas de prendre la metformine.",
  ],
  es: [
    "Reduzca el azúcar a la mitad.",
    "Tome media hora para caminar.",
    "No reduzca la dosis.",
    "Aumente su actividad.",
    "Usted toma 1000 mg dos veces al día.",
    "No deje de tomar la metformina.",
  ],
  it: [
    "Riduca lo zucchero della metà.",
    "Prenda mezz'ora per camminare.",
    "Non riduca la dose.",
    "Aumenti l'attività.",
    "Lei prende 1000 mg due volte al giorno.",
    "Non smetta di prendere la metformina.",
  ],
  pl: [
    "Zmniejsz spożycie soli o połowę.",
    "Nie zmniejszaj dawki.",
    "Odstaw telefon przed snem.",
    "Zwiększ aktywność.",
    "Przyjmuje Pan 1000 mg dwa razy dziennie.",
    "Nie przestawaj brać leków.",
  ],
  nl: [
    "Verlaag je suiker met de helft.",
    "Verlaag je dosis niet.",
    "Neem een half uur de tijd.",
    "Je neemt 1000 mg twee keer per dag.",
    "Je logboek laat 2000 mg zien.",
    "Sla je avonddosis niet over.",
    "Vraag je arts of je de dosis moet verhogen.",
    "Je dosis is in mei verhoogd naar 2000 mg.",
    "Verdubbel je stappen twee weken lang.",
    "Verlaag je natrium naar 1500 mg per dag.",
    "Probeer je glucose na de maaltijd onder 140 mg/dL te houden.",
    "Vraag je arts voordat je stopt met metformine.",
  ],
  "pt-BR": [
    "Reduza o açúcar pela metade.",
    "Tome meia hora para caminhar.",
    "Corte o pão ao meio.",
    "Não reduza a dose.",
    "Aumente sua atividade.",
    "Você toma 1000 mg duas vezes ao dia.",
    "Seu registro mostra 2000 mg.",
    "Não pule a dose da noite.",
    "Não deixe de tomar a metformina.",
    "Pergunte ao seu médico se deve aumentar a dose.",
    "Sua dose foi aumentada para 2000 mg em maio.",
    "A dose passou para 2000 mg em maio, segundo o registro.",
    "Dobre seus passos por duas semanas.",
    "Reduza o sódio para 1500 mg por dia.",
    "Aumente a ingestão de água para 2000 ml.",
    "Tente manter a glicose abaixo de 140 mg/dL depois das refeições.",
    "Converse com seu médico antes de parar de tomar a metformina.",
  ],
  ko: [
    "걸음 수를 늘리세요.",
    "용량을 줄이지 마세요.",
    "약 2주 동안 걷는 시간을 늘리세요.",
    "물 섭취를 늘리세요.",
    "하루 두 번 1000mg을 복용하고 계세요.",
    "저녁 용량을 건너뛰지 마세요.",
    "용량을 늘릴지 의사와 상담하세요.",
    "담배를 끊으세요.",
    "혈당을 140mg/dL 아래로 유지해 보세요.",
  ],
  ru: [
    "Снизьте потребление сахара вдвое.",
    "Сократите время у экрана наполовину.",
    "Погуляйте полчаса.",
    "Снизьте потребление соли.",
    "Спросите врача, стоит ли снижать дозу.",
    "Вашу дозу снизили вдвое в мае.",
    "Пока не снижайте дозу.",
    "Увеличьте активность.",
    "Снижайте давление прогулками.",
    "Принимайте лекарства как назначено.",
    "Вы принимаете 1000 мг дважды в день.",
    "В вашем журнале указано 2000 мг.",
    "В журнале указано, что вы принимаете 1000 мг дважды в день и не пропустили ни одной дозы.",
    "Спросите врача, стоит ли увеличивать дозу.",
    "Поговорите с врачом, прежде чем прекращать метформин.",
    "Не пропускайте вечернюю дозу.",
    "Никогда не прекращайте метформин без разговора с врачом.",
    "Вашу дозу повысили до 2000 мг в мае.",
    "Удвойте шаги на две недели.",
    "Пропустите вечернюю прогулку, если идёт дождь.",
    "Уберите телефон за час до сна.",
    "Пейте воду до 2000 мл в день.",
    "Держите глюкозу ниже 140 мг/дл после еды.",
    "Сбросьте лишнюю минуту на запись лекарства.",
  ],
};

describe("screenModelOutput — the dose-change class, every locale", () => {
  for (const locale of locales) {
    it.each(DOSE_CLASS_VIOLATIONS[locale])(
      `blocks in ${locale}: %s`,
      (text) => {
        const d = screenModelOutput(text, locale, CONVERSATIONAL_CONTRACTS);
        expect(d.block).toBe(true);
        expect(d.reason).toBe("dose_prescription");
      },
    );

    it.each(DOSE_CLASS_CLEAN[locale])(`passes in ${locale}: %s`, (text) => {
      const d = screenModelOutput(text, locale, CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    });
  }

  it("blocks the English drug-named change for a reader of every locale", () => {
    for (const locale of locales) {
      expect(
        screenModelOutput(
          "Increase your metformin to 2000 mg daily.",
          locale,
          CONVERSATIONAL_CONTRACTS,
        ).block,
      ).toBe(true);
    }
  });

  it("blocks the class under the insights contracts too", () => {
    const d = screenModelOutput(
      "Increase your metformin to 2000 mg daily.",
      "en",
      INSIGHTS_CONTRACTS,
    );
    expect(d.reason).toBe("dose_prescription");
  });

  it("keeps the schedule-gated continuation exemption for a take imperative", () => {
    // On schedule: the maintenance anchor exempts it.
    expect(
      screenModelOutput(
        "Take your metformin 1000 mg as usual.",
        "en",
        CONVERSATIONAL_CONTRACTS,
        { dosePlan: [{ name: "Metformin", dose: 1000 }] },
      ).block,
    ).toBe(false);
    // Off schedule: the same phrasing names a dose the user is not on.
    expect(
      screenModelOutput(
        "Take your metformin 2000 mg as usual.",
        "en",
        CONVERSATIONAL_CONTRACTS,
        { dosePlan: [{ name: "Metformin", dose: 1000 }] },
      ).block,
    ).toBe(true);
  });
});
