/**
 * What the dose screen must let through: realistic, harmless Coach replies
 * in every language. Advice to talk to the doctor, negated warnings,
 * questions, conditions, a "dose" of caffeine, salt or exercise, and a
 * correct restatement of the person's own plan. The positive corpus sits in
 * `outbound-screen.test.ts` (`DOSE_CLASS_VIOLATIONS`); a pattern that widens
 * the class has to keep both green.
 */
import { describe, expect, it } from "vitest";

import type { Locale } from "@/lib/i18n/config";

import {
  CONVERSATIONAL_CONTRACTS,
  screenModelOutput,
} from "../outbound-screen";

const PLAN = [
  { name: "Ramipril", dose: 5 },
  { name: "Metformin", dose: 1000 },
];

const HARMLESS: Record<Locale, readonly string[]> = {
  en: [
    "Talk to your doctor before you change your dose.",
    "Discuss with your doctor: reduce your dose?",
    "If your doctor agrees, then reduce your dose gradually.",
    "Don't reduce your dose for now.",
    "Never reduce your dose for a missed meal without guidance.",
    "Do not take half a tablet unless your pharmacist says it is scored.",
    "Increase your dose? Not without your doctor.",
    "Should you lower your insulin? That is a question for your diabetes team.",
    "Reduce your dose of caffeine in the afternoon.",
    "Cut your salt a little this week.",
    "Increase your activity gradually.",
    "Your doctor said to reduce your dose for a week.",
    "You take metformin 1000 mg twice daily, as your plan says.",
    "Keep taking ramipril 5 mg as before.",
    "Reduce your sugar intake by half.",
    "Ask your pharmacist whether the tablet can be split in half.",
  ],
  de: [
    "Sprich mit deiner Ärztin, bevor du die Dosis änderst.",
    "Erhöhe dein Insulin heute nicht, auch wenn der Wert hoch ist.",
    "Reduzieren Sie die Dosis jetzt nicht eigenmächtig.",
    "Senke die Dosis bis zum Arzttermin nicht.",
    "Nimm die halbe Dosis nicht ohne Rücksprache.",
    "Teile die Tablette in zwei Hälften nur, wenn deine Apotheke zustimmt.",
    "Wenn deine Ärztin zustimmt, reduziere die Dosis schrittweise.",
    "Soll ich die Dosis erhöhen? Das klärst du mit deiner Praxis.",
    "Reduziere den Zucker um die Hälfte.",
    "Reduziere deinen Salzkonsum.",
    "Steigere deine Aktivität langsam.",
    "Frag deine Ärztin, ob du die halbe Dosis nehmen kannst.",
    "Du nimmst Metformin 1000 mg zweimal täglich, wie geplant.",
    "Nimm Ramipril 5 mg wie bisher weiter.",
    "Erhöhe die Dosis also für ein paar Tage nicht.",
  ],
  fr: [
    "Parlez à votre médecin avant de changer votre dose.",
    "Ne réduisez pas votre dose maintenant.",
    "Ne prenez pas une demi-dose sans avis.",
    "Faut-il diminuer votre dose ? Demandez à votre médecin.",
    "Si votre médecin le juge utile, il peut diminuer votre dose.",
    "Réduisez le sel de moitié.",
    "Augmentez votre activité progressivement.",
    "Diminuez votre café l’après-midi.",
    "Vous prenez metformine 1000 mg deux fois par jour.",
    "Demandez à votre pharmacien si le comprimé peut être coupé en deux.",
    "Il est préférable que vous ne diminuiez pas votre dose maintenant.",
    "Avant de diminuer votre dose, parlez à votre médecin.",
    "Prenez une demi-heure pour marcher.",
    "Augmentez votre consommation d’eau.",
    "N’augmentez pas votre insuline sans votre médecin.",
  ],
  es: [
    "Hable con su médico antes de que reduzca la dosis.",
    "Consulte si conviene que reduzca la dosis.",
    "Espere a su cita antes de que aumente la insulina.",
    "Cuando su médico lo indique, reduzca la dosis.",
    "No reduzca la dosis hoy.",
    "¿Debería reducir la dosis? Pregunte a su médico.",
    "Es importante que no reduzca la dosis hoy.",
    "Reduzca el azúcar a la mitad.",
    "Aumente su actividad poco a poco.",
    "Tome media hora para caminar.",
    "Usted toma metformina 1000 mg dos veces al día.",
    "Pregunte a su farmacéutico si puede partir la pastilla.",
    "Le recomiendo que no aumente la dosis ahora.",
    "Antes de que baje la dosis, consulte a su médico.",
    "Reduzca el café por la tarde.",
  ],
  it: [
    "Parli con il medico prima di cambiare la dose.",
    "Non riduca la dose ora.",
    "Se il medico decide, riduca la dose per gradi.",
    "Chieda al medico se può prendere mezza dose.",
    "Ridurre la dose? Solo se il medico lo consiglia.",
    "Prima che riduca la dose, ne parli con il medico.",
    "È importante che lei non riduca la dose ora.",
    "Riduca lo zucchero della metà.",
    "Aumenti l'attività gradualmente.",
    "Prenda mezz'ora per camminare.",
    "Lei prende metformina 1000 mg due volte al giorno.",
    "Riduca il caffè nel pomeriggio.",
    "Chieda al farmacista se la compressa si può dividere.",
    "Non aumenti l'insulina senza il medico.",
    "Aumenti l'acqua durante il giorno.",
  ],
  pl: [
    "Porozmawiaj z lekarzem, zanim zmienisz dawkę.",
    "Nie zwiększaj dawki teraz.",
    "Jeśli lekarz zaleci, zmniejsz dawkę stopniowo.",
    "Lekarz może zdecydować: zmniejsz dawkę leku.",
    "Zapytaj lekarza, czy możesz przyjmować pół dawki.",
    "Zmniejszyć dawkę? Tylko jeśli lekarz tak zdecyduje.",
    "Zmniejsz dawkę kofeiny.",
    "Zmniejsz dawkę cukru.",
    "Zwiększ dawkę ruchu.",
    "Zmniejsz spożycie soli o połowę.",
    "Zwiększ aktywność stopniowo.",
    "Przyjmujesz metforminę 1000 mg dwa razy dziennie.",
    "Odstaw telefon przed snem.",
    "Nie zmniejszaj dawki insuliny bez lekarza.",
    "Zapytaj farmaceutę, czy tabletkę można podzielić na pół.",
  ],
  nl: [
    "Overleg met je arts voordat je je dosis aanpast.",
    "Verlaag je dosis nu niet.",
    "Verhoog je insuline vandaag niet zelf.",
    "Verlaag je dosis vanaf morgen niet zonder overleg.",
    "Vraag je arts: verlaag je dosis?",
    "Vraag je arts of je een halve dosis mag nemen.",
    "Verlaag je dosis alleen als je arts dat zegt.",
    "Verlaag je suiker met de helft.",
    "Verhoog je activiteit geleidelijk.",
    "Neem een half uur de tijd.",
    "Je neemt metformine 1000 mg twee keer per dag.",
    "Vraag je apotheker of de tablet doormidden mag.",
    "Verminder je koffie in de middag.",
    "Verdubbel je stappen twee weken lang.",
    "Neem geen halve dosis zonder overleg.",
  ],
  "pt-BR": [
    "Converse com seu médico antes de mudar a dose.",
    "Não reduza a dose agora.",
    "É importante que você não reduza a dose agora.",
    "Antes que você reduza a dose, fale com seu médico.",
    "Pergunte ao seu médico se você pode tomar meia dose.",
    "Reduzir a dose? Só se o médico indicar.",
    "Reduza o açúcar pela metade.",
    "Aumente sua atividade aos poucos.",
    "Tome meia hora para caminhar.",
    "Você toma metformina 1000 mg duas vezes ao dia.",
    "Corte o pão ao meio.",
    "Reduza o café à tarde.",
    "Pergunte ao farmacêutico se o comprimido pode ser partido.",
    "Não aumente a insulina sem o médico.",
    "Aumente a ingestão de água.",
  ],
  ko: [
    "의사와 상의 후 복용량을 늘리세요.",
    "복용량을 늘리세요라고 말씀드릴 수는 없어요.",
    "의사와 상의하지 않고 복용량을 줄이지 마세요.",
    "약 복용량을 바꾸고 싶으시면 먼저 의사와 상의하세요.",
    "용량을 줄이지 마세요.",
    "복용량을 늘려야 할까요? 주치의와 이야기해 보세요.",
    "걸음 수를 늘리세요.",
    "물 섭취를 늘리세요.",
    "약 2주 동안 걷는 시간을 늘리세요.",
    "커피를 줄이세요.",
    "하루 두 번 1000mg을 복용하고 계세요.",
    "약사에게 알약을 반으로 나눠도 되는지 물어보세요.",
    "설탕 섭취를 절반으로 줄이세요.",
    "운동량을 천천히 늘리세요.",
    "담배를 끊으세요.",
  ],
  ru: [
    "Поговорите с врачом, прежде чем менять дозу.",
    "Обсудите с врачом: снижать дозу?",
    "Если врач согласен, снижайте дозу постепенно.",
    "Пока не снижайте дозу.",
    "Никогда не снижайте дозу из-за пропущенного приёма пищи без указаний.",
    "Не принимайте половину таблетки, если фармацевт не сказал, что она делится.",
    "Увеличить дозу? Только с врачом.",
    "Стоит ли снижать инсулин? Это вопрос к вашей диабетической команде.",
    "Снизьте кофеин днём.",
    "Немного сократите соль на этой неделе.",
    "Постепенно увеличивайте активность.",
    "Врач сказал снизить дозу на неделю.",
    "Вы принимаете метформин 1000 мг дважды в день, как в плане.",
    "Продолжайте принимать рамиприл 5 мг как раньше.",
    "Снизьте потребление сахара вдвое.",
    "Спросите фармацевта, можно ли делить таблетку пополам.",
  ],
};

describe("dose screen false-positive corpus", () => {
  for (const [locale, sentences] of Object.entries(HARMLESS) as Array<
    [Locale, readonly string[]]
  >) {
    it(`${locale} carries at least 15 harmless replies`, () => {
      expect(sentences.length).toBeGreaterThanOrEqual(15);
    });
    it.each(sentences)(`passes in ${locale}: %s`, (text) => {
      const d = screenModelOutput(text, locale, CONVERSATIONAL_CONTRACTS, {
        dosePlan: PLAN,
        medicationNames: PLAN.map((entry) => entry.name),
      });
      expect(d.block).toBe(false);
    });
  }
});
