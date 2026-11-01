/**
 * GAD-7, Russian: a working translation written for HealthLog (not a
 * published validated one), faithful to the English original and on the same
 * 0-3 scale.
 *
 * Источник: Рабочий перевод HealthLog с английского оригинала GAD-7 (Spitzer, Kroenke, Williams & Löwe, Arch Intern Med 2006;166:1092-1097). Валидированный русскоязычный вариант в открытом доступе отсутствует.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: {
    period:
      "За последние 2 недели как часто вас беспокоили следующие проблемы?",
  },
  items: [
    "Вы чувствовали нервозность, тревогу или напряжённость",
    "Вам не удавалось остановить или сдержать беспокойство",
    "Вы слишком много беспокоились о разных вещах",
    "Вам было трудно расслабиться",
    "Вы были настолько беспокойны, что трудно было усидеть на месте",
    "Вы легко раздражались",
    "Вы боялись, что может случиться что-то ужасное",
  ],
  anchors: {
    all: {
      0: "Совсем нет",
      1: "Несколько дней",
      2: "Больше половины дней",
      3: "Почти каждый день",
    },
  },
};

export default wording;
