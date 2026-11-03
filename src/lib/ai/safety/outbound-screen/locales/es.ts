/** Outbound-screen banks for Spanish, composed by `../../outbound-screen.ts`. */
import {
  DOSE_UNIT,
  UNIT_END,
  objectSlot,
  TARGET,
  LETTER,
  ENGINE,
  medicationExtras,
  unlessDeferred,
  WORD_START,
  WORD_END,
  DRUG_UNIT,
  LIQUID_UNIT,
  SPELLED_COUNT,
  type LocaleBank,
} from "../shared";

const ES_STOP =
  "no|nunca|y|o|pero|si|sodio|sal|cafeína|azúcar|agua|proteínas?|fibra";

const ES_SLOT = objectSlot(ES_STOP);

const ES_SHORT = objectSlot(`${ES_STOP}|para|con|antes|después|sin|a|al`, 2);

const ES_MED_NOUN =
  "(?:dosis|pastillas?|comprimidos?|medicamentos?|medicaci[óo]n|insulina|inyecci[óo]n|inyecciones|c[áa]psulas?|tratamiento)";

/**
 * The object of a negated intake. A protective qualifier ends it, so "no tome
 * una dosis doble" and "no tome más de 4 pastillas" stay warnings.
 */
const ES_HOLD_SLOT = objectSlot(
  `${ES_STOP}|para|con|antes|después|sin|a|al|más|dobles?|media|medio|mitad|dos|otra|otro|extra|adicional|segunda`,
  3,
);

/** Where a negated intake reads as a hold: the clause closes or a time word follows. */
const ES_HOLD_END = `(?=\\s*(?:[.!;)]|$)|\\s+(?:hoy|esta\\s+(?:noche|mañana|tarde|semana)|mañana|por\\s+(?:ahora|el\\s+momento|unos\\s+días)|durante|hasta|antes)${WORD_END})`;

/** A liquid drug form a measured volume may be a dose of. */
const ES_LIQUID = `(?:jarabes?|soluci[óo]n|soluciones|suspensi[óo]n|gotas|elixir|tintura)${WORD_END}`;

const SPELLED_ES =
  "(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|diecisiete|dieciocho|diecinueve|veinte|treinta|cuarenta|cincuenta|sesenta)";

const PCT_WORD_ES = `${SPELLED_ES}\\s+por\\s+ciento`;

const QUAL_NUM_ES = `(?:\\d{1,3}\\s*%|${PCT_WORD_ES})`;

const RISK_NOUN_ES = "(?:riesgo|probabilidad)";

const RESULT_VERB_ES =
  "(?:lo\\s+(?:coloca|sitúa|clasifica|pone)|le\\s+(?:coloca|sitúa|clasifica)|se\\s+encuentra\\s+en|está\\s+en\\s+(?:la\\s+)?categor|cae\\s+en)";

const ES_MED_CLASS =
  "(?:anticoagulantes?|antiagregantes?|estatinas?|betabloqueantes?|diuréticos?|antidepresivos?)";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const ES_DEFERRAL = `\\?|¿|${WORD_START}(?:no|nunca|sin|solo\\s+si|sólo\\s+si|(?:antes\\s+de|hasta|después\\s+de|conviene|si)\\s+que|consult\\w*|pregunt\\w*|hable\\s+con|médic[oa]s?|doctor[a]?|farmac[ée]utic[oa]|enfermer[oa])${WORD_END}`;

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `(?:${ES_MED_NOUN}|${medicationExtras(ES_MED_CLASS, names)})`,
  doseChangeClass: (med) => [
    new RegExp(
      `(?<!\\b(?:no|nunca)\\s)\\b(?:aumente|aumenta|aumentar|suba|sube|subir|pase|pasar|incremente|incrementar|reduzca|reduce|reducir|baje|bajar|disminuya|disminuir|duplique|duplicar|lleve|llevar|ajuste|ajustar)\\s+${ES_SLOT}(?:de\\s+${TARGET}\\s+)?(?:a|en|hasta)\\s+${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:no|nunca)\\s)\\b(?:tome|tómese|inyecte|inyéctese|administre|empiece\\s+con|comience\\s+con)\\s+${ES_SLOT}${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:no|nunca)\\s)\\b(?:omita|sáltese|salte|suspenda|interrumpa|duplique|divida|parta)\\s+${ES_SLOT}${med}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:no|nunca)\\s)\\b(?:deje|deja|dejar)\\s+de\\s+(?:tomar|usar|inyectarse)\\b`,
      "i",
    ),
    // "una pastilla de más", "otra pastilla", "una dosis extra".
    new RegExp(
      `(?<!\\b(?:no|nunca)\\s)\\b(?:tome|tómese|inyecte|inyéctese|añada|agregue)\\s+${ES_SHORT}(?:(?:un|una|dos|tres|\\d+)\\s+${ES_SHORT}${med}[^.?!]{0,20}?(?:\\bm[áa]s(?![${LETTER}])|\\bextra\\b|\\badicional(?:es)?\\b)|otr[oa]s?\\s+${ES_SHORT}${med})`,
      "i",
    ),
    // Stop a named medication or a drug class: "deje el anticoagulante".
    new RegExp(
      `(?<!\\b(?:no|nunca)\\s)\\b(?:deje|pare|abandone)\\s+${ES_SHORT}${med}`,
      "i",
    ),
    // Halving or a fraction with no number: "reduzca la dosis a la mitad",
    // "tome media dosis", "tome la mitad de la dosis".
    unlessDeferred(
      ES_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:reduzca|reduce|baje|disminuya|corte|parta|divida)\\s+${ES_SLOT}${med}\\s+(?:a|en|por)\\s+la\\s+mitad`,
        "i",
      ),
    ),
    unlessDeferred(
      ES_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:tome|tómese|inyecte|inyéctese|use)\\s+(?:s[óo]lo\\s+|solamente\\s+)?(?:media\\s+|la\\s+mitad\\s+de\\s+)${ES_SHORT}${med}`,
        "i",
      ),
    ),
    // A bare change imperative on a medication, no target: "reduzca la
    // dosis.", "aumente la insulina un poco".
    unlessDeferred(
      ES_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:aumente|suba|incremente|reduzca|baje|disminuya)\\s+${ES_SHORT}${med}(?=\\s*(?:[.!?;:)]|$)|\\s+(?:ahora|hoy|mañana|esta\\s+noche|un\\s+poco|ligeramente|gradualmente|durante|desde)(?![\\w\\u00C0-\\u024F]))`,
        "i",
      ),
    ),
    // A negated intake is a hold: "No tome atorvastatina esta noche", "no
    // tomes tu metoprolol".
    new RegExp(
      `${WORD_START}no\\s+(?:se\\s+)?(?:tome|tomes|tomen|tomar|use|uses|usen|inyecte|inyectes|aplique|apliques|ponga)(?:se)?${WORD_END}\\s+${ES_HOLD_SLOT}${med}${ES_HOLD_END}`,
      "i",
    ),
    // A pause: "Tome un descanso del enalapril", "haga una pausa con el
    // ramipril". A break from screens names no medication.
    new RegExp(
      `${WORD_START}(?:tome|toma|tómese|tómate|haga|haz|hágase)\\s+(?:un|una)\\s+(?:[^\\s\\d.?!,;:]+\\s+)?(?:descanso|pausa)\\s+(?:(?:del|de\\s+la|de\\s+los|de\\s+las|de|con\\s+el|con\\s+la|con|en\\s+el|en\\s+la|en)\\s+)?${ES_SHORT}${med}`,
      "i",
    ),
    // An increment: "Añada 4 unidades más de insulina", "póngase 2 unidades".
    new RegExp(
      `${WORD_START}(?:añada|añade|agregue|agrega|póngase|ponte|inyecte|inyéctese|aplique|aplíquese)\\s+(?:otr[ao]s?\\s+)?(?:[\\d.,]+|${SPELLED_COUNT})\\s*${DRUG_UNIT}${UNIT_END}`,
      "i",
    ),
    // A measured volume of a liquid drug form: "Tome 10 ml del jarabe".
    // "Beba 500 ml de agua" passes.
    new RegExp(
      `${WORD_START}(?:tome|toma|tómese|tómate|administre)\\s+${ES_SHORT}[\\d.,]+\\s*${LIQUID_UNIT}${UNIT_END}\\s+(?:de\\s+la\\s+|de\\s+los\\s+|del\\s+|de\\s+)?${ES_SHORT}(?:${ES_LIQUID}|${med})`,
      "i",
    ),
  ],
  dose: [
    // aumente / suba / pase a|en N unit
    new RegExp(
      `\\b(?:aument\\w*|sub\\w*|pas\\w*|increment\\w*)\\s+(?:su\\s+dosis\\s+)?(?:a|en|hasta)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // reduzca / baje / disminuya a|en N unit
    new RegExp(
      `\\b(?:reduzc\\w*|reduc\\w*|baj\\w*|disminu\\w*)\\s+(?:su\\s+dosis\\s+)?(?:a|en|hasta)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:considere|pruebe|deber[íi]a|recomiendo|sugiero)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:pr[óo]xima|siguiente|nueva)\\s+dosis\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  risk: [
    /\briesgo\s+(?:del?|es\s+del?|de\s+aproximadamente)\s+(?:aproximadamente\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:riesgo|probabilidad)/i,
    /\briesgo\s+(?:cardiovascular|card[íi]aco|de\s+ictus|de\s+mortalidad)\s+a\s+(?:10|diez)\s+a[ñn]os\b/i,
    new RegExp(`\\b${RISK_NOUN_ES}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_ES}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_ES}\\b[^.?!]{0,40}\\b${PCT_WORD_ES}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_ES}\\b[^.?!]{0,40}\\b${RISK_NOUN_ES}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_ES}`, "i"),
    new RegExp(`${QUAL_NUM_ES}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_ES}`, "i"),
  ],
  causal: [
    /\bporque\b/i,
    /\bdebido\s+a\b/i,
    /\ba\s+causa\s+de\b/i,
    /\bcaus(?:a|an|ó|ado)/i,
    /\bprovoc\w*/i,
    /\bllev[óo]\s+a\b/i,
    /\bresponsable\s+de\b/i,
    /\bgracias\s+a\b/i,
    /\bimpuls\w*\s+(?:por|el|la)\b/i,
  ],
  continuation:
    /\b(?:siga\s+(?:tomando|con)|continúe|mantenga|según\s+lo\s+prescrito)\b/i,
  changeStem: /\b(?:aument|reduzc|reduc|baj|disminu|dobl|omit|salt)\w*/i,
};
