/** Outbound-screen banks for Russian, composed by `../../outbound-screen.ts`. */
import {
  DOSE_UNIT,
  DRUG_UNIT,
  UNIT_END,
  ENGINE,
  medicationExtras,
  unlessDeferred,
  type LocaleBank,
} from "../shared";

const RU_MED_NOUN =
  "(?:доз[аыуей]|дозу|таблетк[а-яё]*|капсул[а-яё]*|препарат[а-яё]*|лекарств[а-яё]*|инсулин[а-яё]*|инъекц[а-яё]*|укол[а-яё]*|средств[а-яё]*|терапи[а-яё]*|при[её]м[а-яё]*)";

/** Russian dosage-form counters, with the case endings an object takes. */
const RU_COUNT =
  "(?:таблетк[а-яё]*|капсул[а-яё]*|капл[а-яё]*|доз[а-яё]*|единиц[а-яё]*|ед\\.?|мл)";

const RU_TARGET = `(?:[\\d.,]+(?:\\s*${DRUG_UNIT}${UNIT_END}|\\s*${RU_COUNT})|(?:одну|одна|две|два|три|четыре|половину|полторы|пол)\\s*${RU_COUNT})`;

/**
 * A Russian imperative or recommendation that closes a dose clause. The
 * trailing lookahead keeps the past tense out: «пропустили» must not read as
 * «пропусти». The prohibitive forms ("не увеличивайте") never reach the verb
 * from a negation-aware lead, and the talking-about forms ("увеличил") carry a
 * different ending.
 */
const RU_IMPERATIVE =
  "(?:(?:увеличьте|увеличь|повысьте|повысь|поднимите|подними|нарастите|снизьте|снизь|уменьшите|уменьши|понизьте|понизь|опустите|опусти|сократите|сократи|удвойте|удвой|уполовиньте|разделите|пропустите|пропусти|отмените|отмени|прекратите|прекрати|примите|принимайте|начните|начинайте|перейдите|прекратить|отменить|пропустить|снизить|увеличить|повысить|уменьшить|понизить|сократить|удвоить|начать|перейти))(?![а-яё])";

// Russian writes "12%" with digits; the spelled-out counters ("двенадцать
// процентов") are rare in model prose and collide with the numeral declension,
// so only the digit forms are matched.
const QUAL_NUM_RU = "(?:\\d{1,3}\\s*(?:%|процент[а-яё]*))";

const RISK_NOUN_RU = "(?:риск[а-яё]*|вероятност[а-яё]*|шанс[а-яё]*)";

const HORIZON_RU =
  "(?:(?:10|десяти)[- ]?летн[а-яё]*|пожизненн[а-яё]*)\\s*(?:риск[а-яё]*|сердечно[- ]сосудист[а-яё]*|смертност[а-яё]*)";

const RESULT_VERB_RU =
  "(?:относит[а-яё]*|попада[а-яё]*|классифицир[а-яё]*|перевод[а-яё]*|помеща[а-яё]*|оказыва[а-яё]*\\s*в)";

const RISK_BAND_RU =
  "(?:высок|повышенн|промежуточн|умеренн|низк)[а-яё]*\\s*(?:риск[а-яё]*|категор[а-яё]*|групп[а-яё]*|диапазон[а-яё]*|полос[а-яё]*)";

const RISK_LEVEL_RU = "(?:высок|повышен|умеренн|низк|пограничн|тревожн)";

const RISK_VERDICT_RU = `(?:[—–-]|это|является|находится|означает)\\s*[^.?!]{0,10}${RISK_LEVEL_RU}`;

const RU_MED_CLASS =
  "(?:антикоагулянт[а-яё]*|антиагрегант[а-яё]*|статины|статин[а-яё]*|бета[- ]блокатор[а-яё]*|диуретик[а-яё]*|антидепрессант[а-яё]*|метформин[а-яё]*|инсулин[а-яё]*|витамин[а-яё]*|кроворазжижающ[а-яё]*|кроверазжижающ[а-яё]*|рамиприл[а-яё]*|амлодипин[а-яё]*|лизиноприл[а-яё]*|эналаприл[а-яё]*|лозартан[а-яё]*|бисопролол[а-яё]*|аторвастатин[а-яё]*|розувастатин[а-яё]*|семаглутид[а-яё]*|оземпик[а-яё]*|апиксабан[а-яё]*|эликвис[а-яё]*|варфарин[а-яё]*|левотироксин[а-яё]*|эутирокс[а-яё]*|омепразол[а-яё]*|пантопразол[а-яё]*)";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const RU_DEFERRAL =
  "\\?|врач[а-яё]*|доктор[а-яё]*|специалист[а-яё]*|эндокринолог[а-яё]*|фармацевт[а-яё]*|обсуди[а-яё]*|посовету[а-яё]*|спроси[а-яё]*|если\\s+только|как\\s+назначено|как\\s+обычно|как\\s+и\\s+раньше|не\\s+";

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `(?:${RU_MED_NOUN}|(?:${medicationExtras(RU_MED_CLASS, names, false)})\\S{0,3})`,
  doseChangeClass: (med) => [
    // A stated amount closed by an imperative or a recommendation:
    // "2000 мг увеличьте", "принимайте 2 таблетки".
    new RegExp(`${RU_TARGET}[^.?!]{0,25}${RU_IMPERATIVE}`, "i"),
    // Verb-first, the usual Russian word order. The amount has to be either a
    // counted dosage form ("принимайте 2 таблетки") or a unit reached through a
    // dose word ("увеличьте дозу до 2,4 мг"), so a plain instruction about salt
    // or sodium ("снизьте натрий до 1500 мг") stays clean.
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `${RU_IMPERATIVE}[^.?!]{0,15}(?:[\\d.,]+|одну|одна|две|два|три|четыре|половину|полторы)\\s*(?:таблетк[а-яё]*|капсул[а-яё]*|доз[а-яё]*|инъекц[а-яё]*|укол[а-яё]*)`,
        "i",
      ),
    ),
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `${RU_IMPERATIVE}[^.?!]{0,25}(?:доз[а-яё]*|таблетк[а-яё]*|капсул[а-яё]*|препарат[а-яё]*|лекарств[а-яё]*|инсулин[а-яё]*|витамин[а-яё]*|при[её]м[а-яё]*)[^.?!]{0,10}[\\d.,]+\\s*(?:мкг|мг|мл|ед|ме)${UNIT_END}`,
        "i",
      ),
    ),
    // "Принимайте 2000 мг в сутки", "Примите 500 мг": the intake verb carries
    // the whole instruction, no dose noun in between.
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `(?:примите|принимайте|выпейте|выпить|принять)[^.?!]{0,12}[\\d.,]+\\s*(?:мкг|мг|мл|ед|ме)${UNIT_END}`,
        "i",
      ),
    ),
    // "Начните с 5 мг", "Перейдите на 10 мг".
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `(?:начните|начинайте|перейдите|переходите)[^.?!]{0,15}[\\d.,]+\\s*(?:мкг|мг|мл|ед|ме)${UNIT_END}`,
        "i",
      ),
    ),
    // "Удвойте витамин D до 4000 МЕ" — the doubling verb plus any unit.
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `(?:удвойте|удвой|уполовиньте|уполовинь)[^.?!]{0,25}[\\d.,]+\\s*(?:мкг|мг|мл|ед|ме)${UNIT_END}`,
        "i",
      ),
    ),
    // Verb-first extra dose: "примите дополнительную дозу инсулина".
    new RegExp(
      `${RU_IMPERATIVE}[^.?!]{0,15}(?:ещ[её]|дополнительн[а-яё]*|лишн[а-яё]*)\\s*(?:доз[а-яё]*|таблетк[а-яё]*|капсул[а-яё]*|инъекц[а-яё]*|укол[а-яё]*|инсулин[а-яё]*)`,
      "i",
    ),
    // Verb-first over the medication noun alone: "снизьте дозу", "отмените
    // инъекцию". Deferral words ("спросите врача") stand it down, exactly as
    // the verb-second shape above does.
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(`${RU_IMPERATIVE}[^.?!]{0,12}${med}`, "i"),
    ),
    // A medication object halved, doubled, skipped or stopped by imperative.
    new RegExp(
      `${med}[^.?!]{0,20}(?:(?:вдвое|в\\s*два\\s*раза|пополам|вдвое\\s+меньше|наполовину)\\s*(?:увеличьте|увеличь|снизьте|снизь|уменьшите|уменьши|сократите|разделите|удвойте)|(?:пропустите|пропусти|пропускать|отмените|отмени|прекратите|прекрати|бросьте)(?![а-яё]))`,
      "i",
    ),
    new RegExp(
      `(?:доз[уа]|при[её]м|инъекци[а-яё]*|укол[а-яё]*)\\s*(?:пропустите|пропусти|пропускать|отмените|отмени|прекратите|прекрати)`,
      "i",
    ),
    // The same skip/stop in verb-first order: "пропустите дозу метформина".
    new RegExp(
      `(?:пропустите|пропусти|отмените|отмени|прекратите|прекрати|бросьте|пропустить|отменить|прекратить)(?![а-яё])[^.?!]{0,15}${med}`,
      "i",
    ),
    // One more dose of a medication, closed by an imperative:
    // "примите ещё одну таблетку метформина".
    new RegExp(
      `${med}[^.?!]{0,12}(?:ещ[её]|дополнительн[а-яё]*|лишн[а-яё]*)\\s*(?:одну|одна|две|дозу|таблетку|капсулу)?\\s*(?:примите|принимайте|выпейте|прими)`,
      "i",
    ),
    // A medication object raised or lowered by imperative with no amount,
    // standing down where a question, a negation or a clinician appears.
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `${med}[^.?!\\d]{0,8}?(?:увеличьте|увеличь|повысьте|повысь|поднимите|подними|снизьте|снизь|уменьшите|уменьши|понизьте|понизь|опустите|опусти|сократите|сократи)`,
        "i",
      ),
    ),
  ],
  // A target dose: the unit sits on the number and a change verb or a
  // recommending lead-in frames it. The permitted restatement ("вы на 7,5 мг
  // на этой неделе") names no change verb and does not trip.
  dose: [
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}\\s*(?:до|вплоть\\s*до)[^.?!]{0,20}(?:увелич|повыс|подним|нараст|начинай|переход|сниз|уменьш|пониз|опуст|сократ)`,
      "i",
    ),
    new RegExp(
      // The lookahead keeps the past tense out: «дозу повысили» is a record,
      // «повысьте дозу» is a prescription.
      `(?:увелич|повыс|подним|нараст|сниз|уменьш|пониз|опуст|сократ)(?!и?л)[а-яё]*[^.?!]{0,40}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `(?:рекоменд|совету|предлаг|стоит|нужно|следует|можно)[^.?!]{0,40}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}[^.?!]{0,40}(?:рекоменд|совету|предлаг|стоит|принимайте|примите|начните|перейдите)`,
      "i",
    ),
    new RegExp(
      `(?:следующ|нов|целев|рабоч)[а-яё]*\\s*(?:доз|этап|титрац)[а-яё]*[^.?!]{0,30}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `(?:доз[а-яё]*|таблетк[а-яё]*|капсул[а-яё]*|инсулин[а-яё]*|препарат[а-яё]*|лекарств[а-яё]*|при[её]м[а-яё]*)[^.?!]{0,25}(?:вдвое|в\\s*два\\s*раза|пополам|пропуст|отмен|прекрат|удво|уполовин)[^.?!]{0,40}(?:недел|дн[а-яё]*|месяц|попробуйте|можно)`,
        "i",
      ),
    ),
  ],
  risk: [
    new RegExp(`${RISK_NOUN_RU}[^.?!]{0,15}${QUAL_NUM_RU}`, "i"),
    new RegExp(`${QUAL_NUM_RU}[^.?!]{0,15}${RISK_NOUN_RU}`, "i"),
    new RegExp(`${HORIZON_RU}[^.?!]{0,40}${QUAL_NUM_RU}`, "i"),
    new RegExp(`${QUAL_NUM_RU}[^.?!]{0,40}${HORIZON_RU}`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_RU}`, "i"),
    new RegExp(`${QUAL_NUM_RU}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_RU})[^.?!]{0,60}${RESULT_VERB_RU}`,
      "i",
    ),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_RU})[^.?!]{0,60}${RISK_BAND_RU}`,
      "i",
    ),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_RU})[^.?!]{0,40}${RISK_VERDICT_RU}`,
      "i",
    ),
  ],
  causal: [
    /потому\s+что/i,
    /из[- ]за/i,
    /причин\w*/i,
    /вызван\w*/i,
    /приводит\s+к/i,
    /привел[оаи]\s+к/i,
    /вследствие/i,
    /обусловлен\w*/i,
    /следстви\w*/i,
    /благодаря/i,
    /явля[а-яё]+\s+(?:причиной|результатом)/i,
  ],
  continuation:
    /(?:продолжайте|продолжайте\s+принимать|продолжить\s+при[её]м|как\s+назначено|по\s+назначению|как\s+обычно|как\s+и\s+раньше|в\s+той\s+же\s+дозе|не\s+меняйте)/i,
  changeStem:
    /(?:увелич|повыс|подним|нараст|сниз|уменьш|пониз|опуст|сократ|удво|уполовин|пропуст|отмен|прекрат|перейд|начнит|измен|титр)/i,
};
