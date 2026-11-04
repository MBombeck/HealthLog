/**
 * Every population-norm pattern of every locale has to match at least one
 * realistic reference sentence below. A pattern that never fires exempts
 * nothing and fails silently; French "en bonne santé" and Polish "zdrowi
 * dorośli" were dead that way, the one behind an ASCII `\b` after "é", the
 * other spelled for "dorosli" without the "ś".
 */
import { describe, expect, it } from "vitest";

import { accentedBoundaries } from "@/__tests__/helpers/ascii-boundary";
import { locales, type Locale } from "@/lib/i18n/config";

import { POPULATION_NORM_PATTERNS } from "..";

const SENTENCES: Record<Locale, readonly string[]> = {
  en: [
    "The normal range is 60 to 100.",
    "Healthy adults sleep 7 to 9 hours.",
    "The general population averages 120.",
    "Guidelines recommend 150 minutes a week.",
    "Adults generally need 7 hours of sleep.",
    "The reference range is 4 to 6.",
    "The recommended amount is 2 litres.",
  ],
  de: [
    "Der Normalbereich liegt bei 60 bis 100.",
    "Die normale Herzfrequenz liegt bei 60.",
    "Gesunde Erwachsene schlafen 8 Stunden.",
    "Ärzte empfehlen 150 Minuten pro Woche.",
    "Erwachsene brauchen in der Regel 8 Stunden.",
    "Normale Werte liegen bei 4 bis 6.",
    "Der Puls liegt normalerweise zwischen 60 und 100.",
  ],
  fr: [
    "La plage normale va de 60 à 100.",
    "Les adultes en bonne santé dorment 8 heures.",
    "La plupart des adultes dorment 8 heures.",
    "Les médecins recommandent 150 minutes.",
    "Les adultes ont besoin de 8 heures.",
    "Elle se situe généralement entre 60 et 100.",
  ],
  es: [
    "El rango normal va de 60 a 100.",
    "Los adultos sanos duermen 8 horas.",
    "La mayoría de los adultos duerme 8 horas.",
    "Los médicos recomiendan 150 minutos.",
    "Los adultos generalmente necesitan 8 horas.",
    "Se sitúa normalmente entre 60 y 100.",
  ],
  it: [
    "L'intervallo normale va da 60 a 100.",
    "Gli adulti sani dormono 8 ore.",
    "La maggior parte degli adulti dorme 8 ore.",
    "I medici raccomandano 150 minuti.",
    "Gli adulti di solito hanno bisogno di 8 ore.",
    "Si colloca di solito tra 60 e 100.",
  ],
  pl: [
    "Prawidłowy zakres wynosi 60 do 100.",
    "Zdrowi dorośli śpią 8 godzin.",
    "Większość dorosłych śpi 8 godzin.",
    "Lekarze zalecają 150 minut.",
    "Dorośli zwykle potrzebują 8 godzin.",
    "Zakres referencyjny to 4 do 6.",
    "Wynosi zwykle od 60 do 100.",
  ],
  nl: [
    "Het normale bereik is 60 tot 100.",
    "Een normale hartslag ligt rond 60.",
    "De meeste volwassenen slapen 8 uur.",
    "De algemene bevolking slaapt 7 uur.",
    "Artsen adviseren 150 minuten per week.",
    "Volwassenen hebben doorgaans nodig: 7 tot 9 uur slaap.",
    "Het referentiebereik is 4 tot 6.",
    "Je hartslag ligt meestal tussen 60 en 100.",
  ],
  ko: [
    "정상 범위는 60~100이에요.",
    "참고 범위는 4~6이에요.",
    "건강한 성인은 8시간 자요.",
    "일반 인구는 7시간 자요.",
    "전문가들은 150분을 권장해요.",
    "성인은 보통 8시간이 필요해요.",
    "보통 60에서 100 사이예요.",
  ],
  "pt-BR": [
    "A faixa normal vai de 60 a 100.",
    "Os valores de referência vão de 4 a 6.",
    "Adultos saudáveis dormem 8 horas.",
    "A maioria dos adultos dorme 8 horas.",
    "Os médicos recomendam 150 minutos por semana.",
    "Os adultos precisam de 8 horas de sono.",
    "A pressão arterial normal fica abaixo de 120/80.",
  ],
  ru: [
    "Нормальный диапазон — от 60 до 100.",
    "Референсный интервал составляет от 4 до 6.",
    "Большинство взрослых спит 7–9 часов.",
    "Взрослые обычно спят около 8 часов.",
    "Врачи рекомендуют 150 минут в неделю.",
    "В общей популяции средний уровень — около 120.",
    "Здоровые показатели лежат в этих пределах.",
    "В среднем по популяции это около 120.",
  ],
};

describe("population-norm banks: no pattern is dead", () => {
  it.each(locales)(
    "every %s pattern matches one of its sentences",
    (locale) => {
      const dead = POPULATION_NORM_PATTERNS[locale]
        .map((pattern, index): [number, RegExp] => [index, pattern])
        .filter(
          ([, pattern]) => !SENTENCES[locale].some((s) => pattern.test(s)),
        )
        .map(([index, pattern]) => `[${index}] /${pattern.source}/`);
      expect(dead, `${locale} patterns no sentence matches`).toEqual([]);
    },
  );

  it.each(locales)(
    "no %s pattern puts an ASCII word boundary next to an accented letter",
    (locale) => {
      const offenders = POPULATION_NORM_PATTERNS[locale]
        .map((pattern, index): [string, RegExp] => [`[${index}]`, pattern])
        .filter(([, pattern]) => accentedBoundaries(pattern.source).length > 0)
        .map(([name]) => name);
      expect(offenders, `${locale} population-norm patterns`).toEqual([]);
    },
  );
});
