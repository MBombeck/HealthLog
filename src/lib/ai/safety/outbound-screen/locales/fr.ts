/** Outbound-screen banks for French, composed by `../../outbound-screen.ts`. */
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
  DRUG_UNIT,
  LIQUID_UNIT,
  SPELLED_COUNT,
  type LocaleBank,
} from "../shared";

const FR_STOP =
  "pas|jamais|ne|et|ou|mais|si|sodium|sel|caféine|sucres?|eau|protéines?|fibres?";

const FR_SLOT = objectSlot(FR_STOP);

const FR_SHORT = objectSlot(
  `${FR_STOP}|pour|avec|avant|après|sans|à|au|aux`,
  2,
);

const FR_MED_NOUN =
  "(?:doses?|comprimés?|médicaments?|traitement|insuline|injections?|piqûres?|pilules?|gélules?|cachets?)";

/**
 * The object of a negated intake. A protective qualifier ends it, so "ne
 * prenez pas de double dose" and "ne prenez pas plus de 4 comprimés" stay
 * warnings.
 */
const FR_HOLD_SLOT = objectSlot(
  `${FR_STOP}|pour|avec|avant|après|sans|à|au|aux|double|plus|moitié|demi\\S*|deux|autres?|suppl[ée]mentaires?|en`,
  3,
);

/** Where a negated intake reads as a hold: the clause closes or a time word follows. */
const FR_HOLD_END = `(?=\\s*(?:[.!;)]|$)|\\s+(?:ce\\s+soir|ce\\s+matin|aujourd|demain|cette\\s+semaine|pour\\s+l['’]instant|pour\\s+le\\s+moment|pendant|jusqu|avant)${WORD_END})`;

/** A liquid drug form a measured volume may be a dose of. */
const FR_LIQUID = `(?:sirops?|solutions?|suspensions?|gouttes|élixirs?|teintures?)${WORD_END}`;

const SPELLED_FR =
  "(?:zéro|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante)";

const PCT_WORD_FR = `${SPELLED_FR}\\s+(?:pour\\s+cent|pour-cent)`;

const QUAL_NUM_FR = `(?:\\d{1,3}\\s*%|${PCT_WORD_FR})`;

const RISK_NOUN_FR = "(?:risque|probabilité|chance)";

const RESULT_VERB_FR =
  "(?:vous\\s+(?:met|place|situe|classe|met\\s+dans)|vous\\s+êtes\\s+(?:dans|classé)|vous\\s+tombez\\s+dans)";

const FR_MED_CLASS =
  "(?:anticoagulants?|antiagrégants?|statines?|bêta-?bloquants?|diurétiques?|antidépresseurs?|somnifères?)";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const FR_DEFERRAL = `\\?|(?:^|\\s)n['’]|${WORD_START}(?:ne|pas|jamais|sauf|seulement\\s+si|sans|demandez|parlez|médecin\\w*|pharmacien\\w*|docteur|soignant\\w*|spécialiste)${WORD_END}`;

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `${ELIDED}(?:${FR_MED_NOUN}|${medicationExtras(FR_MED_CLASS, names)})`,
  doseChangeClass: (med) => [
    new RegExp(
      `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)(?<!n['’])\\b(?:(?:augment|mont|pass|port|major|diminu|baiss|abaiss|doubl|ramen)(?:ez|e|er)|r[ée]dui(?:sez|s|re))\\s+${FR_SLOT}(?:de\\s+${TARGET}\\s+)?(?:[àa]|de|jusqu'[àa])\\s+${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)\\b(?:prenez|prends|injectez|injecte|commencez\\s+(?:par|à|avec))\\s+${FR_SLOT}${TARGET}`,
      "i",
    ),
    new RegExp(
      `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)(?<!n['’])\\b(?:divisez|doublez|sautez|suspendez|interrompez|oubliez|arrêtez|cessez|stoppez|supprimez)\\s+${FR_SLOT}${med}`,
      "i",
    ),
    new RegExp(
      `(?<!n['’])\\b(?:arrêtez|cessez|stoppez)\\s+de\\s+(?:prendre|vous\\s+injecter)\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:vous\\s+devriez|je\\s+recommande\\s+de|je\\s+sugg[èe]re\\s+de|envisagez\\s+de|essayez\\s+de)\\s+(?:sauter|suspendre|arrêter|interrompre|diviser|doubler)\\s+${FR_SLOT}(?:de\\s+prendre\\s+\\S|${med})`,
      "i",
    ),
    // "un comprimé en plus", "un ramipril supplémentaire", "un autre
    // comprimé", "encore une dose".
    new RegExp(
      `(?<!\\bne\\s)(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)\\b(?:prenez|prends|injectez|ajoutez)\\s+${FR_SHORT}(?:(?:encore\\s+)?(?:un|une|deux|trois|\\d+)\\s+${FR_SHORT}${med}[^.?!]{0,30}?(?:\\ben\\s+plus\\b|\\bde\\s+plus\\b|\\bsuppl[ée]mentaires?)|(?:un|une)\\s+autres?\\s+${FR_SHORT}${med}|encore\\s+(?:un|une)\\s+${FR_SHORT}${med})`,
      "i",
    ),
    // Halving or a fraction with no number: "réduisez la dose de moitié",
    // "prenez une demi-dose", "coupez le comprimé en deux".
    unlessDeferred(
      FR_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)(?<!n['’])\\b(?:r[ée]duisez|r[ée]duis|diminuez|diminue|baissez|baisse|coupez|coupe|divisez|divise)\\s+${FR_SLOT}${med}\\s+(?:de\\s+moiti[ée]|par\\s+deux|en\\s+deux)`,
        "i",
      ),
    ),
    unlessDeferred(
      FR_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)\\b(?:prenez|prends|injectez|injecte)\\s+(?:seulement\\s+|uniquement\\s+)?(?:une\\s+demi-?\\s?|la\\s+moiti[ée]\\s+d(?:e\\s+|u\\s+|es\\s+|['’]))${FR_SHORT}${med}`,
        "i",
      ),
    ),
    // A bare change imperative on a medication, no target: "diminuez votre
    // dose.", "augmentez votre insuline un peu".
    unlessDeferred(
      FR_DEFERRAL,
      new RegExp(
        `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)(?<!n['’])\\b(?:augmentez|augmente|diminuez|diminue|r[ée]duisez|r[ée]duis|baissez|baisse)\\s+${FR_SHORT}${med}(?=\\s*(?:[.!?;:)]|$)|\\s+(?:maintenant|aujourd|demain|ce\\s+soir|un\\s+peu|progressivement|pendant)(?![\\w\\u00C0-\\u024F]))`,
        "i",
      ),
    ),
    // A negated intake is a hold: "Ne prenez pas votre atorvastatine ce
    // soir", "ne prends pas ton métoprolol", "ne prenez plus le ramipril".
    new RegExp(
      `${WORD_START}(?:ne\\s+|n['’])(?:prenez|prends|injectez|injecte|utilisez|utilise)\\s+(?:pas|plus)\\s+${FR_HOLD_SLOT}${med}${FR_HOLD_END}`,
      "i",
    ),
    // A pause: "Faites une pause avec l'énalapril", "mettez le ramipril en
    // pause". A pause from screens or after a meal names no medication.
    new RegExp(
      `${WORD_START}(?:faites|fais|prenez|prends|observez)\\s+(?:une\\s+)?(?:petite\\s+|courte\\s+)?(?:pause|interruption|fenêtre\\s+thérapeutique)\\s+(?:(?:avec|dans|de|du|des|sur)\\s+)?${FR_SHORT}${med}`,
      "i",
    ),
    new RegExp(
      `${WORD_START}(?:mettez|mets)\\s+${FR_SHORT}${med}\\s+en\\s+pause`,
      "i",
    ),
    // An increment: "Ajoutez 2 unités à votre dose du soir".
    new RegExp(
      `${WORD_START}(?:ajoutez|ajoute|rajoutez|rajoute)\\s+${FR_SHORT}(?:encore\\s+)?(?:[\\d.,]+|${SPELLED_COUNT})\\s*${DRUG_UNIT}${UNIT_END}`,
      "i",
    ),
    // A measured volume of a liquid drug form: "Prenez 10 ml de sirop".
    // "Buvez 500 ml d'eau" passes.
    new RegExp(
      `${WORD_START}(?:prenez|prends|administrez)\\s+${FR_SHORT}[\\d.,]+\\s*${LIQUID_UNIT}${UNIT_END}\\s+(?:d[eu]s?\\s+|d['’])?${FR_SHORT}(?:${ELIDED}${FR_LIQUID}|${med})`,
      "i",
    ),
  ],
  dose: [
    // augmentez / montez / passez / portez à|de N unit
    new RegExp(
      `\\b(?:augment\\w*|mont\\w*|pass\\w*|port\\w*|majo\\w*)\\s+(?:votre\\s+dose\\s+)?(?:[àa]|de|jusqu'[àa])\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // réduisez / diminuez / baissez à|de N unit
    new RegExp(
      `\\b(?:r[ée]duis\\w*|r[ée]duire|diminu\\w*|baiss\\w*|abaiss\\w*)\\s+(?:votre\\s+dose\\s+)?(?:[àa]|de|jusqu'[àa])\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:envisagez|essayez|vous\\s+devriez|je\\s+recommande|je\\s+sugg[èe]re)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:prochaine|nouvelle)\\s+dose\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  risk: [
    /\brisque\s+(?:est\s+)?(?:de\s+|d['’])?(?:environ\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:risque|probabilit[ée]|chance)/i,
    /\brisque\s+(?:cardiovasculaire|cardiaque|d'avc|de\s+mortalit[ée])\s+[àa]\s+(?:10|dix)\s+ans\b/i,
    // digit percent as a risk figure, either order (the noun need not be adjacent)
    new RegExp(`\\b${RISK_NOUN_FR}${WORD_END}[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_FR}${WORD_END}`, "i"),
    // spelled-out percent as a risk figure, either order
    new RegExp(
      `\\b${RISK_NOUN_FR}${WORD_END}[^.?!]{0,40}\\b${PCT_WORD_FR}\\b`,
      "i",
    ),
    new RegExp(
      `\\b${PCT_WORD_FR}\\b[^.?!]{0,40}\\b${RISK_NOUN_FR}${WORD_END}`,
      "i",
    ),
    // named engine + qualifying number, either order
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_FR}`, "i"),
    new RegExp(`${QUAL_NUM_FR}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    // engine + categorical result assertion, numberless
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_FR}`, "i"),
  ],
  causal: [
    /\bparce\s+qu\w*/i,
    /(?<![\w\u00C0-\u024F])[àa]\s+cause\s+de\b/i,
    /\bcaus(?:e|es|ent|é|ée)(?![\w\u00C0-\u024F])/i,
    /\ben\s+raison\s+de\b/i,
    /\bentra[îi]n\w*/i,
    /\ba\s+conduit\s+[àa]/i,
    /\bd[ûu]\s+[àa]/i,
    /\bresponsable\s+de\b/i,
    /\bgr[âa]ce\s+[àa]/i,
    /\bprovoqu\w*/i,
  ],
  continuation:
    /\b(?:continuez?\s+(?:à|de|le)|gardez|comme\s+prescrit|tel\s+que\s+prescrit)(?![\w\u00C0-\u024F])/i,
  changeStem:
    /\b(?:augment|réduis|réduir|diminu|baiss|abaiss|doubl|arrêt|saut)\w*/i,
};
