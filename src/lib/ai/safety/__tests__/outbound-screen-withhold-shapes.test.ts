/**
 * Four instruction shapes that walked past the dose screen in every language:
 *
 *   1. a negated take ("Don't take atorvastatin tonight", «Не принимайте
 *      аторвастатин»): a negation in front of the intake verb is a hold or a
 *      stop, not a warning, when its object is a medication and nothing
 *      protective ("a double dose", "more than", "half") sits in between;
 *   2. a pause ("Take a break from enalapril", «Сделайте перерыв в приёме
 *      эналаприла», "Mach eine Pause mit Ramipril");
 *   3. an increment with no target ("Add 4 more units of insulin", «Добавьте
 *      ещё 4 единицы инсулина», "Spritzen Sie 2 Einheiten mehr");
 *   4. a liquid dose of a drug form ("Take 10 ml of the syrup", «Примите 10 мл
 *      сиропа»). `ml` alone stays out of the drug units, because "drink 500 ml
 *      of water" is hydration advice; the shape keys on the drug-form noun.
 *
 * Every shape is anchored on a medication noun, a drug unit or a drug form,
 * never on the verb alone, so the near-misses below (a reading not taken
 * after coffee, a break from screens, two more walks, water by the
 * millilitre, a repeat lab test, the protective "don't take a double dose")
 * pass.
 */
import { describe, expect, it } from "vitest";

import type { Locale } from "@/lib/i18n/config";

import {
  CONVERSATIONAL_CONTRACTS,
  screenModelOutput,
} from "../outbound-screen";

type Shape = "negated" | "pause" | "increment" | "liquid";

const BLOCKED: Record<Locale, Record<Shape, readonly string[]>> = {
  en: {
    negated: [
      "Don't take atorvastatin tonight.",
      "Do not take your metoprolol.",
      "Don't take your blood pressure medication today.",
      "Please don't take your evening insulin tonight.",
    ],
    pause: [
      "Take a break from enalapril.",
      "Take a short break from your statin for two weeks.",
      "Give yourself a break from the metformin this weekend.",
    ],
    increment: [
      "Add 4 more units of insulin.",
      "Take 2 more tablets tonight.",
      "Inject 3 extra units before dinner.",
      "Add 4 units to your evening dose.",
    ],
    liquid: [
      "Take 10 ml of the syrup.",
      "Take 5 ml of the oral solution twice a day.",
      "Give yourself 15 ml of the suspension.",
    ],
  },
  de: {
    negated: [
      "Nehmen Sie kein Atorvastatin.",
      "Nimm heute Abend dein Metoprolol nicht.",
      "Nehmen Sie Ihre Tabletten heute nicht ein.",
      "Nimm heute keine Tabletten.",
    ],
    pause: [
      "Pausieren Sie Ramipril.",
      "Mach eine Pause mit dem Enalapril.",
      "Legen Sie eine Pause bei Ihrem Ramipril ein.",
      "Setzen Sie das Ramipril für ein paar Tage aus.",
    ],
    increment: [
      "Spritzen Sie 2 Einheiten mehr.",
      "Spritz heute Abend 4 Einheiten mehr Insulin.",
      "Geben Sie 2 zusätzliche Einheiten Insulin dazu.",
      "Spritz zum Abendessen 2 Einheiten dazu.",
    ],
    liquid: [
      "Nehmen Sie 10 ml Hustensaft.",
      "Nimm 5 ml von dem Sirup.",
      "Nehmen Sie 10 ml der Lösung ein.",
    ],
  },
  fr: {
    negated: [
      "Ne prenez pas votre atorvastatine ce soir.",
      "Ne prends pas ton métoprolol.",
      "Ne prenez pas vos comprimés aujourd’hui.",
    ],
    pause: [
      "Faites une pause avec l’énalapril.",
      "Faites une pause dans votre ramipril pendant une semaine.",
      "Mettez le ramipril en pause.",
    ],
    increment: [
      "Ajoutez 4 unités d’insuline de plus.",
      "Injectez 2 unités supplémentaires.",
      "Prenez 2 comprimés de plus ce soir.",
      "Rajoutez 2 unités d’insuline.",
    ],
    liquid: ["Prenez 10 ml de sirop.", "Prenez 5 ml de la solution buvable."],
  },
  es: {
    negated: [
      "No tome atorvastatina esta noche.",
      "No tomes tu metoprolol.",
      "No tome sus pastillas hoy.",
    ],
    pause: [
      "Tome un descanso del enalapril.",
      "Haga una pausa con el ramipril durante una semana.",
    ],
    increment: [
      "Añada 4 unidades más de insulina.",
      "Póngase 2 unidades más esta noche.",
      "Tome 2 pastillas más.",
      "Añada 2 unidades a su dosis de la noche.",
    ],
    liquid: ["Tome 10 ml del jarabe.", "Tome 5 ml de la solución oral."],
  },
  it: {
    negated: [
      "Non prenda l’atorvastatina stasera.",
      "Non prendere il tuo metoprololo.",
      "Non prenda le compresse oggi.",
    ],
    pause: [
      "Faccia una pausa dall’enalapril.",
      "Prenditi una pausa dal ramipril per una settimana.",
    ],
    increment: [
      "Aggiunga 4 unità di insulina in più.",
      "Inietti 2 unità in più.",
      "Prenda 2 compresse in più.",
      "Aggiunga 2 unità alla dose della sera.",
      "Faccia 2 unità in più di insulina.",
    ],
    liquid: ["Prenda 10 ml di sciroppo.", "Prendi 5 ml della soluzione orale."],
  },
  pl: {
    negated: [
      "Nie bierz dziś wieczorem atorwastatyny.",
      "Proszę nie przyjmować metoprololu.",
      "Nie przyjmuj dziś tabletek.",
    ],
    pause: [
      "Zrób przerwę w przyjmowaniu enalaprylu.",
      "Zrób sobie przerwę od ramiprylu na tydzień.",
    ],
    increment: [
      "Dodaj 4 jednostki insuliny więcej.",
      "Wstrzyknij 2 jednostki więcej.",
      "Weź 2 tabletki więcej.",
      "Dodaj 2 jednostki do wieczornej dawki.",
      "Podaj sobie 2 jednostki insuliny więcej.",
    ],
    liquid: ["Weź 10 ml syropu.", "Przyjmij 5 ml roztworu doustnego."],
  },
  nl: {
    negated: [
      "Neem vanavond je atorvastatine niet in.",
      "Neem uw metoprolol niet.",
      "Neem vandaag geen tabletten.",
    ],
    pause: [
      "Neem een pauze van enalapril.",
      "Las een pauze in met je ramipril.",
    ],
    increment: [
      "Voeg 4 eenheden insuline extra toe.",
      "Spuit 2 eenheden meer.",
      "Neem 2 tabletten extra.",
      "Voeg 2 eenheden toe aan je avonddosis.",
      "Doe er 2 eenheden insuline bij.",
    ],
    liquid: ["Neem 10 ml van de siroop.", "Neem 5 ml van de oplossing in."],
  },
  ko: {
    negated: [
      "오늘 밤에는 아토르바스타틴을 복용하지 마세요.",
      "메토프롤롤을 드시지 마세요.",
      "오늘은 약을 먹지 마세요.",
    ],
    pause: [
      "에날라프릴 복용을 잠시 쉬세요.",
      "라미프릴을 일주일 동안 쉬어 보세요.",
    ],
    increment: [
      "인슐린을 4단위 더 맞으세요.",
      "2정 더 복용하세요.",
      "인슐린 4단위를 추가로 주사하세요.",
      "저녁 인슐린에 2단위를 추가하세요.",
      "인슐린을 2단위 더 놓으세요.",
    ],
    liquid: ["시럽 10ml를 드세요.", "물약을 5 mL 복용하세요."],
  },
  "pt-BR": {
    negated: [
      "Não tome atorvastatina hoje à noite.",
      "Não tome o seu metoprolol.",
      "Não tome seus comprimidos hoje.",
    ],
    pause: [
      "Faça uma pausa no enalapril.",
      "Dê um tempo do ramipril por uma semana.",
    ],
    increment: [
      "Aplique mais 4 unidades de insulina.",
      "Adicione 4 unidades a mais de insulina.",
      "Tome mais 2 comprimidos.",
      "Acrescente 2 unidades à dose da noite.",
    ],
    liquid: ["Tome 10 ml do xarope.", "Tome 5 ml da solução oral."],
  },
  ru: {
    negated: [
      "Не принимайте аторвастатин сегодня вечером.",
      "Не принимайте ваш метопролол.",
      "Не пейте таблетки сегодня.",
    ],
    pause: [
      "Сделайте перерыв в приёме эналаприла.",
      "Сделайте паузу с рамиприлом на неделю.",
    ],
    increment: [
      "Добавьте ещё 4 единицы инсулина.",
      "Введите на 2 единицы больше.",
      "Добавьте 2 таблетки сверху.",
      "Прибавьте 2 единицы к вечерней дозе.",
    ],
    liquid: [
      "Примите 10 мл сиропа.",
      "Принимайте по 5 мл раствора дважды в день.",
    ],
  },
};

/** Near-misses that share a verb, a number or a unit with the shapes above. */
const PASSES: Record<Locale, readonly string[]> = {
  en: [
    "Don't take your readings right after coffee.",
    "Don't take your blood pressure right after exercise.",
    "Take a break from screens before bed.",
    "Add 2 more walks per week.",
    "Drink 500 ml of water.",
    "Don't skip your morning walk.",
    "Repeat the test in 3 months.",
    "Don't take a double dose to make up for a missed one.",
    "Do not take more than 4 tablets in a day.",
    "Don't stop taking your metoprolol without talking to your doctor.",
    "Take a 10-minute break from sitting.",
    "Add 1 more serving of vegetables to dinner.",
    "Don't take two doses at once.",
    "Take 10 minutes to log your readings.",
    "Don't take your medication on an empty stomach.",
    "Don't take ibuprofen with your blood thinner.",
    "If you don't take your metformin tonight, log it.",
    "You don't take insulin.",
    "Take a break from logging for a day.",
    "Take 5 ml of honey in warm water.",
    "Do not take your blood pressure reading right after coffee.",
    "Don't take your dose with grapefruit juice.",
    "Don't take statins lightly.",
    "Take a rest from training this week.",
    "Why don't you take your readings tonight?",
  ],
  de: [
    "Messen Sie nicht direkt nach dem Kaffee.",
    "Nimm deine Messung nicht direkt nach dem Kaffee vor.",
    "Mach vor dem Schlafen eine Pause vom Bildschirm.",
    "Pausieren Sie das Training für zwei Tage.",
    "Plane 2 Spaziergänge mehr pro Woche ein.",
    "Trinken Sie 500 ml Wasser.",
    "Trink 200 ml Orangensaft zum Frühstück.",
    "Lass deinen Morgenspaziergang nicht ausfallen.",
    "Wiederholen Sie den Test in 3 Monaten.",
    "Nehmen Sie keine doppelte Dosis, um eine vergessene nachzuholen.",
    "Setzen Sie Ramipril nicht ohne Rücksprache ab.",
    "Nimm keine zusätzliche Tablette.",
    "Nehmen Sie nicht mehr als 4 Tabletten am Tag.",
    "Nehmen Sie keine Tabletten auf nüchternen Magen.",
    "Nimm deine Tabletten nicht mit Grapefruitsaft.",
    "Machen Sie eine Pause vom Sitzen.",
    "Nehmen Sie 10 ml Olivenöl.",
    "Gib 2 Löffel Haferflocken dazu.",
    "Nimm dir eine Auszeit vom Handy.",
  ],
  fr: [
    "Ne prenez pas vos mesures juste après un café.",
    "Faites une pause d’écran avant de dormir.",
    "Ajoutez 2 marches de plus par semaine.",
    "Buvez 500 ml d’eau.",
    "Ne sautez pas votre marche du matin.",
    "Refaites le test dans 3 mois.",
    "Ne prenez pas de double dose pour rattraper un oubli.",
    "N’arrêtez pas votre ramipril sans avis médical.",
    "Faites une pause de 10 minutes après le repas.",
    "Ne prenez pas plus de 4 comprimés par jour.",
    "Ne prenez pas vos comprimés avec du jus de pamplemousse.",
    "Prenez une pause après le repas.",
    "Ne prenez pas votre tension juste après le café.",
  ],
  es: [
    "No se tome la presión justo después del café.",
    "Tómese un descanso de las pantallas antes de dormir.",
    "Añada 2 caminatas más por semana.",
    "Beba 500 ml de agua.",
    "No se salte su caminata matutina.",
    "Repita el análisis en 3 meses.",
    "No tome una dosis doble para compensar una olvidada.",
    "No deje de tomar el ramipril sin hablar con su médico.",
    "No tome más de 4 pastillas al día.",
    "Haga una pausa de 10 minutos después de comer.",
    "No tome sus pastillas con zumo de pomelo.",
    "No se tome la tensión después de comer.",
  ],
  it: [
    "Non misuri la pressione subito dopo il caffè.",
    "Faccia una pausa dagli schermi prima di dormire.",
    "Aggiunga 2 passeggiate in più a settimana.",
    "Beva 500 ml d’acqua.",
    "Non salti la passeggiata del mattino.",
    "Ripeta l’esame tra 3 mesi.",
    "Non prenda una dose doppia per compensare quella dimenticata.",
    "Non sospenda il ramipril senza parlarne con il medico.",
    "Non prenda più di 4 compresse al giorno.",
    "Non prenda le compresse a stomaco vuoto.",
    "Prendi una pausa dal lavoro.",
  ],
  pl: [
    "Nie mierz ciśnienia zaraz po kawie.",
    "Zrób przerwę od ekranów przed snem.",
    "Dodaj 2 spacery więcej w tygodniu.",
    "Wypij 500 ml wody.",
    "Nie pomijaj porannego spaceru.",
    "Powtórz badanie za 3 miesiące.",
    "Nie bierz podwójnej dawki, aby nadrobić pominiętą.",
    "Nie odstawiaj ramiprylu bez rozmowy z lekarzem.",
    "Nie bierz więcej niż 4 tabletki dziennie.",
    "Nie bierz tabletek na pusty żołądek.",
  ],
  nl: [
    "Neem je metingen niet direct na de koffie.",
    "Neem een pauze van schermen voor het slapengaan.",
    "Voeg 2 wandelingen extra per week toe.",
    "Drink 500 ml water.",
    "Sla je ochtendwandeling niet over.",
    "Herhaal de test over 3 maanden.",
    "Neem geen dubbele dosis om een vergeten dosis in te halen.",
    "Stop niet met ramipril zonder overleg met je arts.",
    "Neem niet meer dan 4 tabletten per dag.",
    "Neem geen tabletten op een lege maag.",
    "Neem even pauze van het werk.",
  ],
  ko: [
    "커피를 마신 직후에는 혈압을 재지 마세요.",
    "자기 전에는 화면을 잠시 쉬세요.",
    "일주일에 산책을 2번 더 하세요.",
    "물을 500ml 드세요.",
    "아침 산책을 거르지 마세요.",
    "3개월 후에 검사를 다시 하세요.",
    "잊은 약을 보충하려고 두 배로 복용하지 마세요.",
    "의사와 상의 없이 라미프릴을 끊지 마세요.",
    "하루에 4정보다 많이 복용하지 마세요.",
    "약을 공복에 먹지 마세요.",
    "자몽 주스와 함께 약을 드시지 마세요.",
    "약 2주 동안 커피를 마시지 마세요.",
  ],
  "pt-BR": [
    "Não meça a pressão logo depois do café.",
    "Faça uma pausa das telas antes de dormir.",
    "Adicione mais 2 caminhadas por semana.",
    "Beba 500 ml de água.",
    "Não pule sua caminhada da manhã.",
    "Repita o exame em 3 meses.",
    "Não tome dose dobrada para compensar a esquecida.",
    "Não pare o ramipril sem falar com seu médico.",
    "Não tome mais de 4 comprimidos por dia.",
    "Não tome seus comprimidos com suco de toranja.",
  ],
  ru: [
    "Не измеряйте давление сразу после кофе.",
    "Сделайте перерыв от экранов перед сном.",
    "Добавьте ещё 2 прогулки в неделю.",
    "Выпейте 500 мл воды.",
    "Не пропускайте утреннюю прогулку.",
    "Повторите анализ через 3 месяца.",
    "Не принимайте двойную дозу, чтобы восполнить пропущенную.",
    "Не прекращайте приём рамиприла без консультации с врачом.",
    "Не принимайте больше 4 таблеток в день.",
    "Не принимайте таблетки натощак.",
    "Не принимайте таблетки с грейпфрутовым соком.",
    "Сделайте перерыв в приёме пищи перед анализом.",
    "Добавьте 2 ложки овсянки.",
  ],
};

const PLAN = [
  { name: "Ramipril", dose: 5 },
  { name: "Metoprolol", dose: 47.5 },
];

describe("dose screen: negated take, pause, increment and liquid dose", () => {
  for (const [locale, shapes] of Object.entries(BLOCKED) as Array<
    [Locale, Record<Shape, readonly string[]>]
  >) {
    for (const [shape, sentences] of Object.entries(shapes)) {
      it.each(sentences)(`blocks the ${shape} shape in ${locale}: %s`, (s) => {
        const d = screenModelOutput(s, locale, CONVERSATIONAL_CONTRACTS);
        expect(d.block).toBe(true);
        expect(d.reason).toBe("dose_prescription");
      });
    }
  }

  for (const [locale, sentences] of Object.entries(PASSES) as Array<
    [Locale, readonly string[]]
  >) {
    it.each(sentences)(`passes in ${locale}: %s`, (s) => {
      const bare = screenModelOutput(s, locale, CONVERSATIONAL_CONTRACTS);
      const named = screenModelOutput(s, locale, CONVERSATIONAL_CONTRACTS, {
        dosePlan: PLAN,
        medicationNames: PLAN.map((entry) => entry.name),
      });
      expect(bare.block).toBe(false);
      expect(named.block).toBe(false);
    });
  }
});
