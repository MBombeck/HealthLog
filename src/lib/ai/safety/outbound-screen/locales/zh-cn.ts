/**
 * Outbound-screen banks for Simplified Chinese, composed by
 * `../../outbound-screen.ts`.
 *
 * Two things are different from the Latin banks and decide most of the shapes
 * below:
 *
 * 1. `\b` does not exist here. It is an ASCII word boundary, and a Chinese
 *    character is not `\w`, so `/\b剂量/` matches nothing and `/\d+\b/` would
 *    fire in the middle of a number followed by a counter. Every edge is
 *    spelled out with explicit character classes instead.
 * 2. Chinese is verb-final in the sense that matters least and verb-first in
 *    the sense that matters most: the change verb ("加到", "减量") usually
 *    PRECEDES its target ("加到 2000 mg"), and the dosage counter attaches to
 *    the digit with no space ("2片", "1粒"). Both orders are covered.
 */
import {
  DRUG_UNIT,
  UNIT_END,
  ENGINE,
  medicationExtras,
  unlessDeferred,
  LIQUID_UNIT,
  type LocaleBank,
} from "../shared";

/** Han characters, for the explicit edges `\b` cannot provide. */
const HAN = "\\u4e00-\\u9fff";

/**
 * Chinese dosage counters. They follow the digit directly ("2片", "10毫升"),
 * so they are their own alternation rather than a `COUNT_UNIT` addition: the
 * shared list is Latin-script and expects a space.
 */
const ZH_COUNT = "(?:片|粒|袋|支|瓶|滴|喷|贴|剂|枚|颗|毫升)";

/** A target dose's unit: the shared Latin ones plus the Chinese spellings. */
const ZH_DOSE_UNIT = `(?:${DRUG_UNIT}|毫克|微克|毫升|单位|${ZH_COUNT})`;

/**
 * The medication nouns a dose change can be about, including the drug-class
 * words: "停用抗凝药" (stop the blood thinner) names no product and is the
 * most dangerous stop of all.
 */
const ZH_MED_NOUN =
  "(?:药物|药品|药|处方药|剂量|用量|片剂|胶囊|注射液|注射剂|口服药|胰岛素|降糖药|降压药|降脂药|抗凝药|抗凝剂|血液稀释剂|抗血小板药|甲状腺药|抗抑郁药|抗癫痫药|激素|止痛药|退烧药|抗生素|维生素|补充剂|营养补充剂|他汀|普利|洛尔|沙坦|地平|拉唑|沙班)";

/**
 * The generic-name stems as Chinese writes them ("二甲双胍", "阿托伐他汀",
 * "美托洛尔", "氯沙坦", "奥美拉唑", "利伐沙班", "司美格鲁肽"). Two Han
 * characters are required before the stem so an everyday word that happens to
 * end in one of these syllables is not read as a drug.
 */
const ZH_INN_STEM =
  `[${HAN}]{2,}(?:普利|胍|洛尔|沙坦|他汀|地平|拉唑|沙班|格列汀|格列净|格列酮|肽|西林|霉素)`;

/** Things a number may be a dose of only when a medication noun is beside it. */
const ZH_DIETARY = "(?:钠|盐|食盐|水|饮水|咖啡因|热量|碳水|蛋白质|脂肪|糖|纤维|钾|钙)";

/** Dose-change verbs. Shared by the class, the `dose` shapes and `changeStem`. */
const ZH_CHANGE =
  "(?:加量|减量|加大|减小|增加|减少|提高|降低|上调|下调|加倍|翻倍|减半|停用|停掉|停服|改用|换成|改为|改成|调到|加到|降到|升至|提到|调至|加至)";

/** The particle that marks a target: the Chinese "to" / "by" / "auf". */
const ZH_TO = "(?:到|至|为|成)";

/** An imperative or a recommendation that closes a dose clause. */
const ZH_CLOSE =
  "(?:吧|请|建议|需要|应该|应当|可以|就要|就得|即可|就行|为宜|比较好)";

/** A number that a model must never present as a dose or a risk. */
const ZH_QUAL_NUM = "(?:\\d{1,3}(?:\\.\\d+)?\\s*(?:%|％|级|分))";

const ZH_RISK_NOUN =
  "(?:风险|危险性|风险评分|风险等级|心血管风险|发病风险|卒中风险|心梗风险|心脏病风险|糖尿病风险)";

const ZH_HORIZON =
  "(?:10\\s*年|十年|5\\s*年|五年|未来\\s*\\d+\\s*年)";

const ZH_RISK_BAND = "(?:低危|中危|高危|极高危)\\s*(?:组|级别|区间)?";

const ZH_RISK_VERDICT = `(?:属于|处于|位于)\\s*[^。？！]{0,6}${ZH_RISK_BAND}`;

/**
 * Signals that the number-free shapes stand down for (`unlessDeferred`). A
 * bare 不 would be far too broad — it is a prefix of 不超过 and 不低于, both
 * ordinary reference-range words — so only the prohibitive and interrogative
 * forms are listed.
 */
const ZH_DEFERRAL =
  "\\?|？|吗|是否|(?:不要|不能|不必|无需|不需要|别)|(?:问问|咨询|请教|听)\\s*(?:医生|药师|药剂师)|(?:如果|若)\\s*(?:医生|药师)";

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `(?:${ZH_MED_NOUN}|(?:${medicationExtras(ZH_INN_STEM, names, false)})[${HAN}]{0,4})`,

  doseChangeClass: (med) => [
    // Verb-first with a stated target: "把二甲双胍加到 2000 mg" has the verb
    // before the amount, so the amount alone cannot carry the clause.
    new RegExp(
      `(?:${ZH_CHANGE}|把|将)[^。？！]{0,12}?[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // Amount-first, the mirror image: "2000 mg 加量", "2.4 mg 起步".
    new RegExp(
      `[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}[^。？！]{0,12}?(?:${ZH_CHANGE})`,
      "i",
    ),
    // A medication object moved to a target by a change verb.
    new RegExp(
      `${med}[^。？！\\d]{0,12}?${ZH_CHANGE}\\s*${ZH_TO}\\s*[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // A halved, doubled or stopped medication, which names no amount at all.
    unlessDeferred(
      ZH_DEFERRAL,
      new RegExp(
        `${med}[^。？！\\d]{0,10}?(?:(?:加倍|翻倍|减半|停用|停掉|停服|减量|加量))`,
      ),
    ),
    // One more dose, closed by an imperative: "再加一片吧".
    new RegExp(
      `(?:再|额外|多)\\s*(?:服用?|吃|打|注射)?\\s*(?:一|两|2|三|3)\\s*${ZH_COUNT}?[^。？！]{0,8}?${ZH_CLOSE}`,
      "i",
    ),
    // A measured volume of a liquid form, the same shape the Latin banks use.
    new RegExp(
      `(?:糖浆|口服液|混悬液|溶液|滴剂)[^。？！]{0,8}?[\\d.,]+\\s*(?:${LIQUID_UNIT}|毫升)${UNIT_END}`,
      "i",
    ),
    // A prohibitive in front of the intake ("今晚不要服用阿托伐他汀"). The
    // English bank withholds a negated intake rather than reading it as a
    // warning, because the sentence still names a medication and a time.
    new RegExp(
      `(?:不要|别|禁止|不建议)[^。？！\\d]{0,10}?(?:服用?|吃|打|注射|使用)[^。？！\\d]{0,10}?${med}`,
    ),
    // A change verb BEFORE its medication object ("停用依那普利", "把你的他汀
    // 停两周", "加倍二甲双胍"). The object slot allows no digit, so a date
    // between the verb and the drug keeps the sentence out.
    unlessDeferred(
      ZH_DEFERRAL,
      new RegExp(`(?:${ZH_CHANGE})[^。？！\\d]{0,10}?${med}`),
    ),
    // A medication object followed by a bare stop ("他汀停两周", "二甲双胍停一停").
    unlessDeferred(
      ZH_DEFERRAL,
      new RegExp(
        `${med}[^。？！\\d]{0,8}?(?:停一停|停|停掉|停用|暂停|减半|加倍)`,
      ),
    ),
    // An increment of any size: "再加 4 单位", "今晚再服 2 片".
    new RegExp(
      `(?:再|额外|多)\\s*(?:加|加服|服用?|吃|打|注射)?\\s*[\\d一两二三四五六七八九十]+\\s*(?:${ZH_COUNT}|单位|毫克|毫升|mg|iu)`,
      "i",
    ),
    // A measured volume stated before its form: "服用 10 毫升糖浆".
    new RegExp(
      `[\\d.,]+\\s*(?:${LIQUID_UNIT}|毫升)\\s*(?:的)?\\s*(?:糖浆|口服液|混悬液|溶液|滴剂)`,
      "i",
    ),
    // Half a dosage form, with no target to compare against: "服用半片".
    new RegExp(
      `(?:服用?|吃|注射)\\s*(?:半|一)?\\s*(?:${ZH_COUNT})`,
    ),
    // A target dose the model states as advice, with a change verb closing it.
    new RegExp(
      `[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}[^。？！]{0,20}?(?:${ZH_CHANGE}|${ZH_CLOSE})`,
      "i",
    ),
  ],

  dose: [
    // Verb-first target: "建议加到 2000 mg".
    new RegExp(
      `(?:${ZH_CHANGE})\\s*${ZH_TO}?\\s*[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // Amount with a unit, then a recommendation or an imperative.
    new RegExp(
      `[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}[^。？！]{0,20}?(?:${ZH_CLOSE}|${ZH_CHANGE})`,
      "i",
    ),
    // A medication noun, then an amount: "胰岛素 20 单位".
    new RegExp(
      `${ZH_MED_NOUN}[^。？！]{0,20}?[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // An amount, then a medication noun, both orders the language uses.
    new RegExp(
      `[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}[^。？！]{0,20}?${ZH_MED_NOUN}`,
      "i",
    ),
    // A dose the model frames as a trial, which needs both a medication noun
    // and a trial cue so a lab value never trips it.
    unlessDeferred(
      ZH_DEFERRAL,
      new RegExp(
        `(?:试试|试一下|试用|先用|改成试试)[^。？！]{0,30}[\\d.,]+\\s*${ZH_DOSE_UNIT}${UNIT_END}`,
      ),
    ),
  ],

  risk: [
    new RegExp(`${ZH_RISK_NOUN}[^。？！]{0,15}${ZH_QUAL_NUM}`, "i"),
    new RegExp(`${ZH_QUAL_NUM}[^。？！]{0,15}${ZH_RISK_NOUN}`, "i"),
    new RegExp(`${ZH_HORIZON}[^。？！]{0,40}${ZH_QUAL_NUM}`, "i"),
    new RegExp(`${ZH_QUAL_NUM}[^。？！]{0,40}${ZH_HORIZON}`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^。？！]{0,50}${ZH_QUAL_NUM}`, "i"),
    new RegExp(`${ZH_QUAL_NUM}[^。？！]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${ZH_HORIZON})[^。？！]{0,60}${ZH_RISK_VERDICT}`,
      "i",
    ),
  ],

  causal: [
    /导致/,
    /(?:引起|造成|引发)/,
    /所以/,
    /(?:这说明|说明你|表明你|意味着你)/,
    /(?:原因|根源)(?:是|在于)/,
    /由此可知/,
    /使得/,
    /(?:正是|就是因为)[^。？！]{0,12}(?:导致|造成|引起)/,
    /(?:因为)[^。？！]{0,30}(?:所以|因此)/,
  ],

  continuation:
    /(?:继续|维持|保持)\s*(?:当前|现有|原有)?\s*(?:剂量|用量|方案|剂量不变)|(?:剂量|用量)\s*(?:不变|照旧)/,

  changeStem: new RegExp(ZH_CHANGE),
};
