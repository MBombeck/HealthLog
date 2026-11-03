/** Outbound-screen banks for Polish, composed by `../../outbound-screen.ts`. */
import {
  DOSE_UNIT,
  UNIT_END,
  objectSlot,
  TARGET,
  ENGINE,
  medicationExtras,
  unlessDeferred,
  WORD_START,
  WORD_END,
  LIQUID_UNIT,
  DRUG_UNIT,
  SPELLED_COUNT,
  type LocaleBank,
} from "../shared";

const PL_STOP =
  "nie|i|lub|albo|ale|jeśli|czy|sód|sodu|sól|soli|kofein\\S*|cukr\\S*|wod\\S*|białk\\S*|błonnik\\S*";

const PL_SLOT = objectSlot(PL_STOP);

const PL_SHORT = objectSlot(`${PL_STOP}|z|ze|do|na|po|przed|bez|dla`, 2);

const PL_MED_NOUN =
  "(?:dawk[aęiy]|dawek|tabletk[aęiy]|tabletek|lek|leki|leku|leków|insulin[aęy]|zastrzyk[ia]?|zastrzyków|kapsułk[aęiy]|pigułk[aęiy])(?=[\\s.,;:!?]|$)";

/**
 * The object of a negated intake. A protective qualifier ends it, so "nie
 * bierz podwójnej dawki" and "nie bierz więcej niż 4 tabletki" stay warnings.
 */
const PL_HOLD_SLOT = objectSlot(
  `${PL_STOP}|z|ze|do|na|po|przed|bez|dla|więcej|niż|podwójn\\S*|pół|połow\\S*|dwie|dwa|dodatkow\\S*|kolejn\\S*|drug\\S*`,
  3,
);

/** Where a negated intake reads as a hold: the clause closes or a time word follows. */
const PL_HOLD_END = `(?=\\s*(?:[.!;)]|$)|\\s+(?:dziś|dzisiaj|jutro|wieczorem|rano|teraz|na\\s+razie|przez|przed|aż)${WORD_END})`;

/** A liquid drug form a measured volume may be a dose of. */
const PL_LIQUID = "(?:syrop|roztw[oó]r|zawiesin|kropl|eliksir)[a-ząćęłńóśźż]*";

const SPELLED_PL =
  "(?:zero|jeden|dwa|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|dziesięć|jedenaście|dwanaście|trzynaście|czternaście|piętnaście|szesnaście|siedemnaście|osiemnaście|dziewiętnaście|dwadzieścia|trzydzieści|czterdzieści|pięćdziesiąt|sześćdziesiąt)";

const PCT_WORD_PL = `${SPELLED_PL}\\s+procent`;

const QUAL_NUM_PL = `(?:\\d{1,3}\\s*%|${PCT_WORD_PL})`;

const RISK_NOUN_PL = "(?:ryzyk\\w*|prawdopodobieństw\\w*)";

const RESULT_VERB_PL =
  "(?:umieszcza\\s+(?:cię|pana|panią)|klasyfikuje\\s+(?:cię|pana|panią)|znajdujesz\\s+się\\s+w|wpadasz\\s+w|kwalifikuje\\s+(?:cię|pana|panią))";

const PL_MED_CLASS =
  "(?:lek\\S*\\s+przeciwzakrzepow\\S*|antykoagulant\\S*|statyn\\S*|beta-?bloker\\S*|diuretyk\\S*|lek\\S*\\s+moczopędn\\S*|antydepresant\\S*)";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const PL_DEFERRAL = `\\?|${WORD_START}(?:nie|bez|tylko\\s+(?:jeśli|gdy|jeżeli)|zapytaj|skonsultuj|porozmawiaj|lekarz\\w*|farmaceut\\w*|aptek\\w*|specjalist\\w*)${WORD_END}`;

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `(?:${PL_MED_NOUN}|${medicationExtras(PL_MED_CLASS, names)})`,
  doseChangeClass: (med) => [
    new RegExp(
      `(?<!\\bnie\\s)\\b(?:zwi[ęe]ksz(?:y[ćc]|cie)?|podnie[śs](?:[ćc]|cie)?|podwy[żz]sz(?:y[ćc])?|zmniejsz(?:y[ćc]|cie)?|obni[żz](?:y[ćc]|cie)?|zredukuj(?:cie)?|zredukowa[ćc]|przejd[źz](?:cie)?|przej[śs][ćc]|zmie[ńn]|zmieni[ćc])(?=\\s)\\s+${PL_SLOT}(?:z\\s+${TARGET}\\s+)?(?:do|o|na)\\s+${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?:(?<!\\bnie\\s)\\b(?:przyjmij|przyjmuj|we[źz]|bierz|wstrzyknij|wstrzykuj|zacznij\\s+od)|\\b(?:proszę|należy|warto)\\s+(?:przyj[ąa][ćc]|wzi[ąa][ćc]|bra[ćc]|przyjmowa[ćc]|wstrzykiwa[ćc]|wstrzykn[ąa][ćc]|zacz[ąa][ćc]\\s+od))(?=\\s)\\s+${PL_SLOT}${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?:(?<!\\bnie\\s)\\b(?:pomi[ńn](?:cie)?|opu[śs][ćc]|odstaw(?:cie)?|wstrzymaj|podziel|podwój)|\\b(?:proszę|należy|warto)\\s+(?:pomin[ąa][ćc]|odstawi[ćc]|wstrzyma[ćc]|przerwa[ćc]|podzieli[ćc]|podwoi[ćc]))(?=\\s)\\s+${PL_SLOT}${med}`,
      "i",
    ),
    new RegExp(
      `(?:(?<!\\bnie\\s)\\bprzesta[ńn](?:cie)?|\\b(?:proszę|należy)\\s+przesta[ćc])\\s+(?:brać|przyjmować|stosować)(?=[\\s.,;:!?]|$)`,
      "i",
    ),
    // "dodatkową tabletkę", "jeszcze jedną dawkę", "jedną tabletkę więcej".
    new RegExp(
      `(?:(?<!\\bnie\\s)\\b(?:we[źz]|bierz|przyjmij|wstrzyknij|dodaj)|\\b(?:proszę|należy|warto)\\s+(?:wzi[ąa][ćc]|przyj[ąa][ćc]|wstrzykn[ąa][ćc]|doda[ćc]))(?=\\s)\\s+${PL_SHORT}(?:(?:dodatkow\\S*|kolejn\\S*|jeszcze\\s+jedn\\S*)\\s+${PL_SHORT}${med}|(?:jedn\\S*|dwie|dwa|trzy|\\d+)\\s+${PL_SHORT}${med}\\s+więcej(?=[\\s.,;:!?]|$))`,
      "i",
    ),
    // Halving or a fraction with no number: "zmniejsz dawkę o połowę",
    // "weź połowę dawki", "przyjmij pół dawki".
    unlessDeferred(
      PL_DEFERRAL,
      new RegExp(
        `(?<!\\bnie\\s)\\b(?:zmniejsz|obni[żz]|zredukuj|podziel|przetnij|przełam)(?:cie)?\\s+${PL_SLOT}${med}\\s+(?:o\\s+połowę|na\\s+pół|na\\s+połowę|na\\s+dwie\\s+części)`,
        "i",
      ),
    ),
    unlessDeferred(
      PL_DEFERRAL,
      new RegExp(
        `(?:(?<!\\bnie\\s)\\b(?:we[źz]|bierz|przyjmij|przyjmuj|wstrzyknij)|\\b(?:proszę|należy)\\s+(?:wzi[ąa][ćc]|przyj[ąa][ćc]|przyjmowa[ćc]))\\s+(?:tylko\\s+)?(?:pół|połowę|połowy)\\s+${PL_SHORT}${med}`,
        "i",
      ),
    ),
    // A bare change imperative on a medication, no target: "zmniejsz
    // dawkę.", "zwiększ dawkę insuliny.". The noun closes the clause, or one
    // genitive word does ("dawkę insuliny"), or a time or degree word follows.
    unlessDeferred(
      PL_DEFERRAL,
      new RegExp(
        `(?<!\\bnie\\s)\\b(?:zwi[ęe]ksz|zmniejsz|obni[żz]|podnie[śs]|podwy[żz]sz|zredukuj)(?:cie)?\\s+${PL_SHORT}${med}(?=\\s*(?:[.!?;:)]|$)|\\s+(?!(?:kofein|cukr|cukier|ruch|sol|sól|alkohol|kalori|białk|wod|kaw|herbat|tłuszcz|węglowodan|aktywnoś|ćwicze|snu|sen|błonnik)[^\\s]*\\s*(?:[.!?;:)]|$))[^\\s\\d.?!,;:]+\\s*(?:[.!?;:)]|$)|\\s+(?:teraz|dziś|dzisiaj|jutro|trochę|nieco|stopniowo|od\\s+jutra|przez)(?=[\\s.,;:!?]|$))`,
        "i",
      ),
    ),
    // A negated intake is a hold: "Nie bierz dziś atorwastatyny", "proszę nie
    // przyjmować metoprololu".
    new RegExp(
      `${WORD_START}(?:proszę\\s+|lepiej\\s+)?nie\\s+(?:bierz|bierzcie|brać|przyjmuj|przyjmujcie|przyjmować|zażywaj|zażywać|stosuj|stosować|wstrzykuj|wstrzykiwać)${WORD_END}\\s+${PL_HOLD_SLOT}${med}${PL_HOLD_END}`,
      "i",
    ),
    // A pause: "Zrób przerwę w przyjmowaniu enalaprylu", "zrób sobie przerwę
    // od ramiprylu". A break from screens names no medication.
    new RegExp(
      `${WORD_START}(?:zrób|zróbcie|zrobić|proszę\\s+zrobić)\\s+(?:sobie\\s+)?(?:[^\\s\\d.?!,;:]+\\s+)?przerw[ęe]${WORD_END}\\s+(?:od|w|z)\\s+(?:(?:przyjmowani|brani|zażywani|stosowani)[a-ząćęłńóśźż]*\\s+)?${PL_SHORT}${med}`,
      "i",
    ),
    // A measured volume of a liquid drug form: "Weź 10 ml syropu". "Wypij
    // 500 ml wody" passes.
    new RegExp(
      `${WORD_START}(?:weź|weźcie|przyjmij|przyjmuj|wypij|zażyj|proszę\\s+(?:przyjąć|wziąć|przyjmować|wypić))\\s+${PL_SHORT}(?:po\\s+)?[\\d.,]+\\s*${LIQUID_UNIT}${UNIT_END}\\s+${PL_SHORT}(?:${PL_LIQUID}|${med})`,
      "i",
    ),
    // An increment: "Dodaj 2 jednostki do wieczornej dawki", "podaj sobie 2
    // jednostki więcej". The amount carries a drug unit, so "dodaj 2 spacery"
    // passes.
    new RegExp(
      `${WORD_START}(?:dodaj|dodajcie|podaj(?:\\s+sobie)?|proszę\\s+(?:dodać|podać))\\s+(?:jeszcze\\s+|dodatkowo\\s+)?(?:[\\d.,]+|${SPELLED_COUNT})\\s*${DRUG_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  dose: [
    // zwiększ / podnieś / przejdź do|o N unit
    new RegExp(
      `\\b(?:zwi[ęe]ksz\\S*|podnie[śs]\\S*|przejd[źz]\\S*|podwy[żz]sz\\S*)\\s+(?:dawk\\S*\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // zmniejsz / obniż / zredukuj do|o N unit
    new RegExp(
      `\\b(?:zmniejsz\\S*|obni[żz]\\S*|zreduk\\S*|reduk\\S*)\\s+(?:dawk\\S*\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:rozwa[żz]\\S*|spr[óo]buj\\S*|powinien|powinna|zalecam|sugeruj[ęe])[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:nast[ęe]pna|kolejna|nowa)\\s+dawka\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  risk: [
    /\bryzyko\s+(?:wynosi\s+|około\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:ryzyka|prawdopodobie[ńn]stwa)/i,
    /\bryzyk\w*\s+(?:sercowo[- ]naczyniow\w*|zawału|udaru|zgonu)\s+w\s+(?:ci[ąa]gu\s+)?(?:10|dziesi[ęe]ciu)\s+lat\b/i,
    new RegExp(`\\b${RISK_NOUN_PL}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_PL}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_PL}\\b[^.?!]{0,40}\\b${PCT_WORD_PL}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_PL}\\b[^.?!]{0,40}\\b${RISK_NOUN_PL}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_PL}`, "i"),
    new RegExp(`${QUAL_NUM_PL}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_PL}`, "i"),
  ],
  causal: [
    /\bponiewa[żz]/i,
    /\bz\s+powodu\b/i,
    /\bpowoduj\w*/i,
    /\bspowodowa\w*/i,
    /\bprzyczyn\w*/i,
    /\bdoprowadzi[\w\u00C0-\u024F]*\s+do\b/i,
    /\bwskutek\b/i,
    /\bdzi[ęe]ki\b/i,
    /\bodpowiedzialn[\w\u00C0-\u024F]*\s+za\b/i,
  ],
  continuation:
    /\b(?:kontynuuj|przyjmuj\s+dalej|zgodnie\s+z\s+zaleceniem|pozosta[ńn]\s+przy)\b/i,
  changeStem:
    /\b(?:zwiększ|zmniejsz|obniż|podnie[śs]|podwyższ|zreduk|pomi[ńn]|opu[śs][ćc])\w*/i,
};
