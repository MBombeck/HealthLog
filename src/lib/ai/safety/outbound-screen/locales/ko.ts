/** Outbound-screen banks for Korean, composed by `../../outbound-screen.ts`. */
import {
  DRUG_UNIT,
  DOSE_UNIT,
  UNIT_END,
  ENGINE,
  medicationExtras,
  unlessDeferred,
  LIQUID_UNIT,
  INN_STEM_HANGUL,
  type LocaleBank,
} from "../shared";

const KO_MED_NOUN =
  "(?:약을|약은|약\\s|알약|정제|인슐린|주사|용량|복용량|투약)";

/**
 * Korean dosage-form counters. They attach to the digit with no space ("2정",
 * "10단위"); `정` is guarded against "정상" (normal) and `알` against "알레르기".
 */
const KO_COUNT = "(?:단위|유닛|캡슐|정(?!상|도|확|말)|알(?!레))";

const KO_TARGET = `(?:[\\d.,]+(?:\\s*${DRUG_UNIT}${UNIT_END}|${KO_COUNT})|(?:한|두|세|네|반)\\s*(?:알(?!레)|정(?!상|도|확|말)|캡슐))`;

/**
 * A Korean imperative or recommendation that closes a dose clause. The stem
 * must meet the polite-imperative ending directly, so the prohibitive
 * "건너뛰지 마세요" (don't skip) and "줄이지 마세요" (don't lower) never match.
 */
const KO_IMPERATIVE =
  "(?:(?:늘리|올리|높이|줄이|내리|낮추|증량하|감량하|중단하|끊으|건너뛰|멈추|복용하|드시|드|투여하|맞으|주사하|바꾸|변경하)(?:세요|십시오|시기\\s*바랍니다|셔야|는\\s*(?:것이|게)\\s*좋)|(?:늘려|올려|높여|줄여|내려|낮춰|끊어|멈춰|바꿔|드셔|복용해|투여해|증량해|감량해|중단해)\\s*(?:보세요|주세요|보십시오|야\\s*(?:해요|합니다)))";

// Korean carries no `\\b` next to a Hangul token: `\\b` is an ASCII \\w boundary
// and Hangul is not \\w, so /\\b위험/ matches nothing. Spelled-out percentages are
// omitted deliberately — Korean writes "12%", and the Sino-Korean numerals
// ("이", "삼") collide with common particles.
const QUAL_NUM_KO = "(?:\\d{1,3}\\s*(?:%|퍼센트|프로))";

const RISK_NOUN_KO = "(?:위험(?:도|률|성)?|확률|가능성)";

const HORIZON_KO = "(?:10년|십\\s?년|평생)\\s*(?:위험(?:도|률)?|리스크)";

const RESULT_VERB_KO =
  "(?:(?:에|으로|로)\\s*(?:분류|해당|속하|들어가)|군에\\s*(?:속하|해당))";

const RISK_BAND_KO =
  "(?:고|중간|중등도|저|높은|낮은)\\s*위험\\s*(?:군|범위|등급|구간)";

const RISK_LEVEL_KO = "(?:높|상승|증가|중등도|경계|우려)";

const RISK_VERDICT_KO = `(?:은|는|이|가)\\s*[^.?!]{0,10}${RISK_LEVEL_KO}`;

const KO_MED_CLASS = `(?:혈액\\s*희석제|항응고제|항혈소판제|스타틴|베타\\s*차단제|이뇨제|항우울제|${INN_STEM_HANGUL})`;

/**
 * A liquid drug form a measured volume may be a dose of. "물을 500ml 드세요"
 * (drink 500 ml of water) names none.
 */
const KO_LIQUID = "(?:시럽|물약|현탁액|내복액|액제|용액)";

/** The polite intake imperative a liquid dose closes on. */
const KO_INTAKE =
  "(?:드세요|드십시오|복용하세요|복용하십시오|드시고|먹으세요|드셔\\s*보세요)";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const KO_DEFERRAL = `\\?|의사|약사|전문의|주치의|상의|라고|지\\s*마`;

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `(?:${KO_MED_NOUN}|(?:${medicationExtras(KO_MED_CLASS, names, false)})\\S{0,3})`,
  doseChangeClass: (med) => [
    // A stated amount closed by an imperative or a recommendation, with or
    // without a target particle: "2000mg으로 증량하세요", "하루 2정 드세요".
    new RegExp(`${KO_TARGET}[^.?!]{0,25}${KO_IMPERATIVE}`, "i"),
    // A medication object halved, doubled, skipped or stopped by imperative.
    new RegExp(
      `${med}[^.?!]{0,20}(?:(?:절반|반)\\s*으로\\s*(?:줄이|나누)(?:세요|십시오)|(?:절반|반)\\s*으로\\s*(?:줄여|나눠)\\s*(?:보세요|주세요)|두\\s?배로\\s*(?:늘리|올리)(?:세요|십시오)|두\\s?배로\\s*(?:늘려|올려)\\s*(?:보세요|주세요)|(?:건너뛰|중단하|끊으|멈추|그만\\s*드시|그만\\s*복용하)(?:세요|십시오))`,
    ),
    new RegExp(
      `(?:복용|투약|투여|주사)(?:을|를)?\\s*(?:중단하|멈추|그만하|끊으)(?:세요|십시오)`,
    ),
    // One more or an additional dose of a medication, closed by an
    // imperative: "라미프릴을 한 알 더 드세요", "인슐린을 추가로 맞으세요".
    // The prohibitive "더 드시지 마세요" never meets an imperative ending.
    new RegExp(
      `${med}[^.?!]{0,12}(?:(?:(?:한|두|세|\\d+)\\s*(?:알|정|캡슐|번|단위)?\\s*)?더|추가로)\\s*(?:드세요|드십시오|복용하세요|복용하십시오|투여하세요|맞으세요|맞으십시오|주사하세요)`,
    ),
    // A medication object raised or lowered by imperative with no amount:
    // "복용량을 늘리세요", "인슐린 용량을 낮추세요". No digit may sit between,
    // so "약 2주 동안 걷는 시간을 늘리세요" ("약" = about) passes, and the
    // prohibitive "줄이지 마세요" never meets an imperative ending.
    unlessDeferred(
      KO_DEFERRAL,
      new RegExp(
        `${med}[^.?!\\d]{0,8}?(?:(?:늘리|올리|높이|줄이|내리|낮추|증량하|감량하)(?:세요|십시오)|(?:늘려|올려|높여|줄여|내려|낮춰)\\s*(?:보세요|주세요|보십시오))`,
      ),
    ),
    // A negated intake is a hold: "아토르바스타틴을 복용하지 마세요", "오늘은
    // 약을 먹지 마세요". A protective qualifier between the medication and the
    // verb, or in front of it ("두 배로", "한꺼번에", "더", "공복에", "함께"),
    // keeps it a warning ("자몽 주스와 함께 약을 드시지 마세요"), and no
    // digit may sit between, so "약 2주" ("about two weeks") is not a medication.
    new RegExp(
      `(?<!(?:함께|같이|동시에|공복에|한꺼번에|두\\s*배로?)\\s*)${med}\\s*(?:(?!두\\s*배|한꺼번에|동시에|추가|더\\s|이상|많이|반\\s*알|절반|함께|같이|공복)[^.?!\\d]){0,12}?(?:복용하지|드시지|먹지|맞지|투여하지|주사하지|사용하지)\\s*(?:마세요|마십시오|말아\\s*주세요|마(?![가-힣]))`,
    ),
    // A pause: "에날라프릴 복용을 잠시 쉬세요", "라미프릴을 일주일 동안 쉬어
    // 보세요". Resting the eyes from a screen names no medication.
    new RegExp(
      `${med}[^.?!\\d]{0,15}?(?:쉬세요|쉬십시오|쉬어\\s*(?:보세요|주세요)|휴약하세요|휴약해\\s*보세요)`,
    ),
    // A measured volume of a liquid drug form, in either order: "시럽 10ml를
    // 드세요", "10ml의 시럽을 드세요".
    new RegExp(
      `(?:${KO_LIQUID}[^.?!]{0,8}?[\\d.,]+\\s*${LIQUID_UNIT}${UNIT_END}|[\\d.,]+\\s*${LIQUID_UNIT}${UNIT_END}\\s*(?:의\\s*)?${KO_LIQUID})[^.?!]{0,10}?${KO_INTAKE}`,
      "i",
    ),
    // An increment closed by "add" or "put in": "저녁 인슐린에 2단위를
    // 추가하세요", "2단위 더 놓으세요". "산책을 2번 더 하세요" carries no dose
    // counter and passes.
    new RegExp(
      `${KO_TARGET}[^.?!]{0,12}?(?:(?:추가하|놓으|주입하)(?:세요|십시오)|(?:추가해|놓아)\\s*(?:보세요|주세요))`,
      "i",
    ),
  ],
  // Korean is verb-final: the dose comes first and the change verb closes the
  // clause ("2.4mg으로 늘려 보세요"), the mirror image of the Latin banks. A
  // target-marking particle on the dose is required, the same demand the Latin
  // banks make of "to" / "by" / "auf" — without it the permitted restatement
  // "7.5mg을 복용 중이고, 체중은 내려가고 있어요" matched the lowering pattern.
  dose: [
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}\\s*(?:으로|로|까지)[^.?!]{0,20}(?:올리|올려|늘리|늘려|증량|높이|높여|인상)`,
      "i",
    ),
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}\\s*(?:으로|로|까지)[^.?!]{0,20}(?:내리|내려|줄이|줄여|감량|낮추|낮춰|감축)`,
      "i",
    ),
    new RegExp(
      `(?:권해|권장|권고|추천|제안)[^.?!]{0,40}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}[^.?!]{0,40}(?:권해|권장|권고|추천|제안|드심|드셔|복용하세요|시도해)`,
      "i",
    ),
    new RegExp(
      `(?:다음|새)\\s*(?:용량|단계|복용량)[^.?!]{0,30}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // Both a medication object AND a trial cue are required, as in the EN bank,
    // so "걸음 수를 두 배로 늘려 2주간 해보세요" never trips.
    // Number-free too, so it stands down where a pharmacist or doctor is
    // asked ("약사에게 … 물어보세요" ends on the same "보세요").
    unlessDeferred(
      KO_DEFERRAL,
      /(?:약|알|정|인슐린|주사|복용|용량)[^.?!]{0,25}(?:절반|반으로|두\s?배|건너뛰|중단|끊)[^.?!]{0,40}(?:주간|주 동안|일 동안|달 동안|보세요|보십시오|보자|해 ?보)/,
    ),
  ],
  risk: [
    new RegExp(`${RISK_NOUN_KO}[^.?!]{0,15}${QUAL_NUM_KO}`, "i"),
    new RegExp(`${QUAL_NUM_KO}[^.?!]{0,15}${RISK_NOUN_KO}`, "i"),
    new RegExp(`${HORIZON_KO}[^.?!]{0,40}${QUAL_NUM_KO}`, "i"),
    new RegExp(`${QUAL_NUM_KO}[^.?!]{0,40}${HORIZON_KO}`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_KO}`, "i"),
    new RegExp(`${QUAL_NUM_KO}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_KO})[^.?!]{0,60}${RESULT_VERB_KO}`,
      "i",
    ),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_KO})[^.?!]{0,60}${RISK_BAND_KO}`,
      "i",
    ),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_KO})[^.?!]{0,40}${RISK_VERDICT_KO}`,
      "i",
    ),
  ],
  causal: [
    /때문(?:에|이)/,
    /(?:으로|로)\s*인(?:해|하여|한)/,
    /탓(?:에|이|으로)/,
    /(?:이|가)\s*원인/,
    /원인(?:은|이에요|입니다|이라|으로)/,
    /유발/,
    /초래/,
    /야기/,
    /덕분(?:에|이)/,
    /(?:영향을|결과로)\s*(?:줘서|줬|나타났|이어졌)/,
  ],
  continuation:
    /(?:그대로\s*(?:유지|복용)|계속\s*(?:복용|드시|유지)|처방(?:대로|받은\s*대로)|지시(?:대로|받은\s*대로)|유지하세요)/,
  changeStem:
    /(?:올리|올려|늘리|늘려|증량|높이|높여|인상|내리|내려|줄이|줄여|감량|낮추|낮춰|감축|절반|반으로|두\s?배|건너뛰|중단|끊)/,
};
