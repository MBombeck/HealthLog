/**
 * WHO-5, Russian: a working translation written for HealthLog (the WHO's own
 * Russian version is under CC BY-NC-SA and not reproduced verbatim here),
 * faithful to the five items and the 0-5 scale.
 *
 * Источник: Рабочий перевод HealthLog опросника ВОЗ-5 (World Health Organization. The World Health Organization-Five Well-Being Index (WHO-5). Geneva: WHO; 2024, WHO/UCN/MSD/MHE/2024.1).
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: { period: "За последние две недели…" },
  items: [
    "Я чувствовал себя бодрым и в хорошем настроении",
    "Я чувствовал себя спокойно и расслабленно",
    "Я чувствовал себя активным и полным сил",
    "Я просыпался свежим и отдохнувшим",
    "Моя повседневная жизнь была наполнена тем, что мне интересно",
  ],
  anchors: {
    all: {
      0: "Ни разу",
      1: "Иногда",
      2: "Меньше половины времени",
      3: "Больше половины времени",
      4: "Большую часть времени",
      5: "Всё время",
    },
  },
};

export default wording;
