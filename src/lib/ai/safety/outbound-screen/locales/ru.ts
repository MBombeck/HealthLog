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
  "(?:доз[аыуей]|дозу|таблетк\\w*|капсул\\w*|препарат\\w*|лекарств\\w*|инсулин\\w*|инъекц\\w*|укол\\w*|средств\\w*|терапи\\w*|при[её]м\\w*)";

/** Russian dosage-form counters, with the case endings an object takes. */
const RU_COUNT = "(?:таблетк\\w*|капсул\\w*|капл\\w*|доз\\w*|единиц\\w*|ед\\.?|мл)";

const RU_TARGET = `(?:[\\d.,]+(?:\\s*${DRUG_UNIT}${UNIT_END}|\\s*${RU_COUNT})|(?:одну|одна|две|два|три|четыре|половину|полторы|пол)\\s*${RU_COUNT})`;

/**
 * A Russian imperative or recommendation that closes a dose clause. The
 * prohibitive forms ("не увеличивайте", "не снижайте") never reach the verb
 * from a negation-aware lead, and the talking-about forms ("увеличил") carry a
 * different ending.
 */
const RU_IMPERATIVE =
  "(?:(?:увеличьте|увеличь|повысьте|повысь|поднимите|подними|нарастите|снизьте|снизь|уменьшите|уменьши|понизьте|понизь|опустите|опусти|сократите|сократи|удвойте|удвой|уполовиньте|разделите|пропустите|пропусти|отмените|отмени|прекратите|прекрати|примите|принимайте|начните|начинайте|перейдите))";

// Russian writes "12%" with digits; the spelled-out counters ("двенадцать
// процентов") are rare in model prose and collide with the numeral declension,
// so only the digit forms are matched.
const QUAL_NUM_RU = "(?:\\d{1,3}\\s*(?:%|процент\\w*))";

const RISK_NOUN_RU = "(?:риск\\w*|вероятност\\w*|шанс\\w*)";

const HORIZON_RU =
  "(?:(?:10|десяти)[- ]?летн\\w*|пожизненн\\w*)\\s*(?:риск\\w*|сердечно[- ]сосудист\\w*|смертност\\w*)";

const RESULT_VERB_RU =
  "(?:относит\\w*|попада\\w*|классифицир\\w*|перевод\\w*|помеща\\w*|оказыва\\w*\\s*в)";

const RISK_BAND_RU =
  "(?:высок|повышенн|промежуточн|умеренн|низк)\\w*\\s*(?:риск\\w*|категор\\w*|групп\\w*|диапазон\\w*|полос\\w*)";

const RISK_LEVEL_RU = "(?:высок|повышен|умеренн|низк|пограничн|тревожн)";

const RISK_VERDICT_RU = `(?:[—–-]|это|является|находится|означает)\\s*[^.?!]{0,10}${RISK_LEVEL_RU}`;

const RU_MED_CLASS =
  "(?:антикоагулянт\\w*|антиагрегант\\w*|статины|статин\\w*|бета[- ]блокатор\\w*|диуретик\\w*|антидепрессант\\w*|метформин\\w*|инсулин\\w*)";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const RU_DEFERRAL = "\\?|врач\\w*|доктор\\w*|специалист\\w*|эндокринолог\\w*|фармацевт\\w*|обсуди\\w*|посовету\\w*|спроси\\w*|если\\s+только|не\\s+";

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `(?:${RU_MED_NOUN}|(?:${medicationExtras(RU_MED_CLASS, names, false)})\\S{0,3})`,
  doseChangeClass: (med) => [
    // A stated amount closed by an imperative or a recommendation:
    // "2000 мг увеличьте", "принимайте 2 таблетки".
    new RegExp(`${RU_TARGET}[^.?!]{0,25}${RU_IMPERATIVE}`, "i"),
    // A medication object halved, doubled, skipped or stopped by imperative.
    new RegExp(
      `${med}[^.?!]{0,20}(?:(?:вдвое|в\\s*два\\s*раза|пополам|вдвое\\s+меньше|наполовину)\\s*(?:увеличьте|увеличь|снизьте|снизь|уменьшите|уменьши|сократите|разделите|удвойте)|(?:пропустите|пропусти|пропускать|отмените|отмени|прекратите|прекрати|бросьте))`,
    ),
    new RegExp(
      `(?:доз[уа]|при[её]м|инъекци\\w*|укол\\w*)\\s*(?:пропустите|пропусти|пропускать|отмените|отмени|прекратите|прекрати)`,
    ),
    // One more dose of a medication, closed by an imperative:
    // "примите ещё одну таблетку метформина".
    new RegExp(
      `${med}[^.?!]{0,12}(?:ещ[её]|дополнительн\\w*|лишн\\w*)\\s*(?:одну|одна|две|дозу|таблетку|капсулу)?\\s*(?:примите|принимайте|выпейте|прими)`,
    ),
    // A medication object raised or lowered by imperative with no amount,
    // standing down where a question, a negation or a clinician appears.
    unlessDeferred(
      RU_DEFERRAL,
      new RegExp(
        `${med}[^.?!\\d]{0,8}?(?:увеличьте|увеличь|повысьте|повысь|поднимите|подними|снизьте|снизь|уменьшите|уменьши|понизьте|понизь|опустите|опусти|сократите|сократи)`,
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
      `(?:увелич|повыс|подним|нараст|сниз|уменьш|пониз|опуст|сократ)\\w*[^.?!]{0,40}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
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
      `(?:следующ|нов|целев|рабоч)\\w*\\s*(?:доз|этап|титрац)\\w*[^.?!]{0,30}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    unlessDeferred(
      RU_DEFERRAL,
      /(?:доз|таблетк|капсул|инсулин|препарат|лекарств|приём|прием)[^.?!]{0,25}(?:вдвое|в два раза|пополам|пропуст|отмен|прекрат|удво|уполовин)[^.?!]{0,40}(?:недел|дн|месяц|попробуйте|можно)/,
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
    /явля\w+\s+(?:причиной|результатом)/i,
  ],
  continuation:
    /(?:продолжайте|продолжайте\s+принимать|продолжить\s+при[её]м|как\s+назначено|по\s+назначению|как\s+обычно|как\s+и\s+раньше|в\s+той\s+же\s+дозе|не\s+меняйте)/i,
  changeStem:
    /(?:увелич|повыс|подним|нараст|сниз|уменьш|пониз|опуст|сократ|удво|уполовин|пропуст|отмен|прекрат|перейд|начнит|измен|титр)/i,
};
