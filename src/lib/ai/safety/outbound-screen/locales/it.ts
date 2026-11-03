/** Outbound-screen banks for Italian, composed by `../../outbound-screen.ts`. */
import {
  DOSE_UNIT,
  UNIT_END,
  objectSlot,
  TARGET,
  ENGINE,
  WORD_END,
  ELIDED,
  medicationExtras,
  unlessDeferred,
  WORD_START,
  LIQUID_UNIT,
  DRUG_UNIT,
  SPELLED_COUNT,
  type LocaleBank,
} from "../shared";

const IT_STOP =
  "non|mai|e|o|ma|se|sodio|sale|caffeina|zucchero|acqua|proteine|fibre";

const IT_SLOT = objectSlot(IT_STOP);

const IT_SHORT = objectSlot(`${IT_STOP}|per|con|prima|dopo|senza|a|al`, 2);

const IT_MED_NOUN =
  "(?:dos[ei]|compress[ae]|pastigli[ae]|farmac[oi]|medicinal[ei]|insulina|iniezion[ei]|capsul[ae]|terapia)";

/**
 * The object of a negated intake. A protective qualifier ends it, so "non
 * prenda una dose doppia" and "non prenda più di 4 compresse" stay warnings.
 */
const IT_HOLD_SLOT = objectSlot(
  `${IT_STOP}|per|con|prima|dopo|senza|a|al|più|doppi[aoe]|mezz[ao]|metà|due|altr[ao]|extra|aggiuntiv\\S*|seconda`,
  3,
);

/** Where a negated intake reads as a hold: the clause closes or a time word follows. */
const IT_HOLD_END = `(?=\\s*(?:[.!;)]|$)|\\s+(?:oggi|stasera|stamattina|domani|questa\\s+settimana|per\\s+ora|per\\s+il\\s+momento|per\\s+qualche|fino|prima)${WORD_END})`;

/** A liquid drug form a measured volume may be a dose of. */
const IT_LIQUID = `(?:sciropp[oi]|soluzion[ei]|sospension[ei]|gocce|elisir)${WORD_END}`;

const SPELLED_IT =
  "(?:zero|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|trenta|quaranta|cinquanta|sessanta)";

const PCT_WORD_IT = `${SPELLED_IT}\\s+per\\s+cento`;

const QUAL_NUM_IT = `(?:\\d{1,3}\\s*%|${PCT_WORD_IT})`;

const RISK_NOUN_IT = "(?:rischio|probabilità)";

const RESULT_VERB_IT =
  "(?:la\\s+(?:colloca|mette|classifica|pone)|rientra\\s+(?:in|nella)|si\\s+trova\\s+(?:in|nella)|ricade\\s+in)";

const IT_MED_CLASS =
  "(?:anticoagulant[ei]|antiaggregant[ei]|statin[ae]|betabloccant[ei]|diuretic[oi]|antidepressiv[oi])";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const IT_DEFERRAL = `\\?|${WORD_START}(?:non|mai|senza|solo\\s+se|chieda|chiedi|parli|parla|consult\\w*|medic[oi]|dottor\\w*|farmacist\\w*|specialist\\w*)${WORD_END}`;

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `${ELIDED}(?:${IT_MED_NOUN}|${medicationExtras(IT_MED_CLASS, names)})`,
  doseChangeClass: (med) => [
    new RegExp(
      `(?<!\\b(?:non|mai)\\s)\\b(?:aumenti|aumentare|incrementi|incrementare|porti|portare|passi|passare|salga|salire|riduca|ridurre|abbassi|abbassare|diminuisca|diminuire|dimezzi|dimezzare|raddoppi|raddoppiare)\\s+${IT_SLOT}(?:da\\s+${TARGET}\\s+)?(?:a|di|fino\\s+a)\\s+${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:non|mai)\\s)\\b(?:prenda|assuma|inietti|si\\s+inietti|inizi\\s+con|cominci\\s+con)\\s+${IT_SLOT}${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:non|mai)\\s)\\b(?:salti|sospenda|interrompa|dimezzi|raddoppi|divida|ometta|tralasci|smetta)\\s+${IT_SLOT}${med}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:non|mai)\\s)\\bsmett(?:a|i|ere)\\s+di\\s+(?:prendere|assumere|usare)\\b`,
      "i",
    ),
    // "una compressa in più", "un'altra compressa", "una dose extra".
    new RegExp(
      `(?<!\\b(?:non|mai)\\s)\\b(?:prenda|assuma|inietti|aggiunga)\\s+${IT_SHORT}(?:(?:un|una|uno|due|tre|\\d+)\\s+${IT_SHORT}${med}[^.?!]{0,30}?(?:\\bin\\s+più|\\bextra\\b|\\baggiuntiv[aoei]\\b|\\bin\\s+aggiunta\\b)|(?:un['’]altra|un\\s+altro|altr[eio])\\s*${IT_SHORT}${med})`,
      "i",
    ),
    // Halving or a fraction with no number: "riduca la dose della metà",
    // "prenda mezza dose", "prenda metà della dose".
    unlessDeferred(
      IT_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\b(?:riduca|ridurre|diminuisca|abbassi|tagli|divida)\\s+${IT_SLOT}${med}\\s+(?:della|alla|a|per)\\s+met[àa]`,
        "i",
      ),
    ),
    unlessDeferred(
      IT_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\b(?:prenda|assuma|inietti)\\s+(?:solo\\s+|soltanto\\s+)?(?:mezz[ao]\\s+|(?:la\\s+)?met[àa]\\s+(?:della|del|dell['’]|di)\\s*)${IT_SHORT}${med}`,
        "i",
      ),
    ),
    // A bare change imperative on a medication, no target: "riduca la
    // dose.", "aumenti l'insulina un po'".
    unlessDeferred(
      IT_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\b(?:aumenti|incrementi|riduca|abbassi|diminuisca)\\s+${IT_SHORT}${med}(?=\\s*(?:[.!?;:)]|$)|\\s+(?:ora|oggi|domani|stasera|un\\s+po|leggermente|gradualmente|per|da\\s+subito)(?![\\w\\u00C0-\\u024F]))`,
        "i",
      ),
    ),
    // A negated intake is a hold: "Non prenda l'atorvastatina stasera", "non
    // prendere il tuo metoprololo".
    new RegExp(
      `${WORD_START}non\\s+(?:prend(?:a|ere|ete|ano|i)|assum(?:a|ere|ete|i)|inietti|iniettare|usi|usare|utilizzi)${WORD_END}\\s+${IT_HOLD_SLOT}${med}${IT_HOLD_END}`,
      "i",
    ),
    // A pause: "Faccia una pausa dall'enalapril", "prenditi una pausa dal
    // ramipril". A pause from screens names no medication.
    new RegExp(
      `${WORD_START}(?:faccia|fai|prenda|prendi|prenditi|si\\s+prenda)\\s+(?:una\\s+)?(?:[^\\s\\d.?!,;:]+\\s+)?pausa\\s+(?:(?:dal|dalla|dallo|da|con\\s+il|con\\s+la|con|col|nel|nella|sul|sulla)\\s+)?${IT_SHORT}${med}`,
      "i",
    ),
    // A measured volume of a liquid drug form: "Prenda 10 ml di sciroppo".
    // "Beva 500 ml d'acqua" passes.
    new RegExp(
      `${WORD_START}(?:prenda|prendi|assuma|assumi)\\s+${IT_SHORT}[\\d.,]+\\s*${LIQUID_UNIT}${UNIT_END}\\s+(?:di\\s+|del(?:la|lo)?\\s+|dell['’])?${IT_SHORT}(?:${IT_LIQUID}|${med})`,
      "i",
    ),
    // An increment: "Aggiunga 2 unità alla dose della sera", "faccia 2 unità
    // in più". The amount carries a drug unit, so "aggiunga 2 passeggiate"
    // passes.
    new RegExp(
      `${WORD_START}(?:aggiunga|aggiungi|faccia|fai|si\\s+faccia|inietti|si\\s+inietti)\\s+(?:altr[ei]\\s+|ancora\\s+)?(?:[\\d.,]+|${SPELLED_COUNT})\\s*${DRUG_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  dose: [
    // aumenti / salga / passi a|di N unit
    new RegExp(
      `\\b(?:aument\\w*|sal\\w*|pass\\w*|increment\\w*)\\s+(?:la\\s+sua\\s+dose\\s+)?(?:a|di|fino\\s+a)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // riduca / abbassi / diminuisca a|di N unit
    new RegExp(
      `\\b(?:riduc\\w*|ridur\\w*|abbass\\w*|diminu\\w*|cal\\w*)\\s+(?:la\\s+sua\\s+dose\\s+)?(?:a|di|fino\\s+a)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:consideri|provi|dovrebbe|raccomando|suggerisco)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:prossima|nuova)\\s+dose\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  risk: [
    /\brischio\s+(?:del?|dell'|[èe]\s+del?|di\s+circa)\s+(?:circa\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:di\s+)?(?:rischio|probabilit[àa])/i,
    /\brischio\s+(?:cardiovascolare|cardiaco|di\s+ictus|di\s+mortalit[àa])\s+a\s+(?:10|dieci)\s+anni\b/i,
    new RegExp(`\\b${RISK_NOUN_IT}${WORD_END}[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_IT}${WORD_END}`, "i"),
    new RegExp(
      `\\b${RISK_NOUN_IT}${WORD_END}[^.?!]{0,40}\\b${PCT_WORD_IT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b${PCT_WORD_IT}\\b[^.?!]{0,40}\\b${RISK_NOUN_IT}${WORD_END}`,
      "i",
    ),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_IT}`, "i"),
    new RegExp(`${QUAL_NUM_IT}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_IT}`, "i"),
  ],
  causal: [
    /\bperch[ée]/i,
    /\ba\s+causa\s+di\b/i,
    /\bcaus(?:a|ano|ato|ata)\b/i,
    /\bprovoc\w*/i,
    /\bha\s+portato\s+a\b/i,
    /\bdovuto\s+a\b/i,
    /\bresponsabile\s+di\b/i,
    /\bgrazie\s+a\b/i,
    /\bguid\w*\s+da\b/i,
  ],
  continuation: /\b(?:continui\s+(?:a|con|il)|mantenga|come\s+prescritto)\b/i,
  changeStem: /\b(?:aument|riduc|ridur|abbass|diminu|raddoppi|salt|dimezz)\w*/i,
};
