/** Outbound-screen banks for English, composed by `../../outbound-screen.ts`. */
import {
  DOSE_UNIT,
  DRUG_UNIT,
  LIQUID_UNIT,
  SPELLED_COUNT,
  UNIT_END,
  objectSlot,
  TARGET,
  ENGINE,
  medicationExtras,
  unlessDeferred,
  type LocaleBank,
} from "../shared";

/**
 * Words the English object slot may not cross. The other languages'
 * negations are here because the English bank runs on every reader's text:
 * the Dutch warning "Stop niet met ramipril zonder overleg" otherwise read as
 * "stop" + two slot words + a generic name.
 */
const EN_STOP =
  "not|never|no|niet|nicht|nie|non|não|nao|nunca|nooit|jamais|and|or|but|if|whether|when|sodium|salt|caffeine|sugars?|fib(?:er|re)|protein|carbs?|carbohydrates?|cholesterol|water|fluids?|coffee|alcohol|steps";

const EN_SLOT = objectSlot(EN_STOP);

const EN_SHORT = objectSlot(
  `${EN_STOP}|to|for|with|at|in|on|of|from|before|after|about|into|than|while|during|like`,
  2,
);

/**
 * The object of a negated intake verb. A protective count or qualifier ends
 * it, so "don't take a double dose", "do not take more than 4 tablets" and
 * "don't take half a tablet" stay warnings.
 */
const EN_HOLD_SLOT = objectSlot(
  `${EN_STOP}|to|for|with|at|in|on|of|from|into|than|while|during|like|half|double|more|extra|additional|another|second|two|both|multiple|any|other|same`,
  3,
);

/**
 * Where a negated intake ends to read as a hold: the clause closes, or a time
 * word follows ("don't take your metoprolol tonight"). "Don't take your pills
 * with grapefruit" meets neither and passes.
 */
const EN_HOLD_END =
  "(?=\\s*(?:[.!;)]|$)|\\s+(?:today|tonight|tomorrow|this\\s+(?:morning|evening|afternoon|week|weekend)|for\\s+(?:now|a\\s+(?:few|couple|while|week|day)|the\\s+(?:next|rest)|\\d+|two|three|several)|any\\s*more|until|before|in\\s+the\\s+(?:morning|evening))\\b)";

/** A liquid drug form a measured volume may be a dose of. */
const EN_LIQUID =
  "(?:syrups?|solutions?|suspensions?|elixirs?|tinctures?|linctus|mixtures?|liquid\\s+medicine)\\b";

/**
 * Where an English imperative can start: the sentence head (or a list bullet),
 * after a colon / dash, or after a recommending lead-in. A negated imperative
 * ("don't skip your dose") never reaches the verb from any of these.
 */
const EN_LEAD =
  "(?:^\\s*(?:[-*•]\\s*|\\d+[.)]\\s*)?|[:;—–]\\s*|(?<!\\b(?:whether|if)\\s)\\b(?:please|just|then|now|instead|so|you\\s+(?:should|need\\s+to|must|ought\\s+to)|try\\s+to|go\\s+ahead\\s+and|i'?d|i\\s+would|time\\s+to)\\s+)";

/** A recommending cue that may sit in front of a gerund / infinitive change. */
const EN_CUE =
  "\\b(?:consider|try|recommend|suggest|worth|might\\s+want\\s+to|may\\s+want\\s+to|need\\s+to|time\\s+to|i'?d|i\\s+would|should|could)\\b";

const EN_MED_NOUN =
  "(?:dose|doses|dosage|pill|pills|tablet|tablets|capsule|capsules|medication|medications|medicine|meds|insulin|injection|injections|shot|jab|inhaler)\\b";

// Spelled-out cardinal numbers (0–99) so a digit-less "twelve percent" still
// counts as a fabricated figure, not an educational aside.
const SPELLED_EN =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?";

const PCT_WORD_EN = `${SPELLED_EN}\\s+(?:percent|per\\s+cent)`;

const QUAL_NUM_EN = `(?:\\d{1,3}\\s*%|${PCT_WORD_EN}|score\\s+of\\s+\\d)`;

const RISK_NOUN_EN = "(?:risk|chance|probability|likelihood)";

const HORIZON_EN =
  "(?:10[- ]year|ten[- ]year|lifetime)\\s+(?:cardiovascular|cardiac|heart|stroke|mortality|cvd|ascvd)\\s+risk";

const RESULT_VERB_EN =
  "(?:puts?\\s+you|would\\s+put\\s+you|placing\\s+you|places?\\s+you|you\\s+fall|you'?d\\s+fall|classif\\w*\\s+you)";

const RISK_BAND_EN =
  "(?:high|higher|intermediate|elevated|moderate|low|borderline)[- ]?risk\\s+(?:band|category|group|range)";

// A categorical VERDICT on the engine / horizon itself ("your 10-year risk IS
// elevated") — a fabricated result with no digits. The horizon phrase and a
// named engine are inherently about-this-user, so an attached risk-level
// adjective is an assertion, not education. A model-perfect refusal names the
// horizon but attaches no such adjective, so it still passes.
const RISK_LEVEL_EN =
  "(?:elevated|high|higher|intermediate|moderate|borderline|raised|concerning|significant)";

const RISK_VERDICT_EN = `(?:is|are|looks?|appears?|seems?|sits?|remains?|comes?\\s+back|runs?|suggests?|indicat\\w*|shows?|reflects?|points?\\s+to)\\s+(?:\\w+\\s+){0,2}${RISK_LEVEL_EN}`;

const EN_MED_CLASS =
  "(?:blood[- ]?thinners?|anti-?coagulants?|anti-?platelets?|statins?|beta[- ]?blockers?|diuretics?|water\\s+pills?|ace\\s+inhibitors?|steroids?|antidepressants?|sleeping\\s+pills?)\\b";

/** Signals that the number-free change shapes stand down for (`unlessDeferred`). */
const EN_DEFERRAL = `\\?|\\b(?:not|never|don'?t|doesn'?t|no|unless|only\\s+(?:if|when|after)|without|ask|discuss|talk\\s+to|check\\s+with|doctor|physician|gp|pharmacist|prescriber|clinician|nurse|specialist|care\\s+team|diabetes\\s+team)\\b`;

export const bank: LocaleBank = {
  vocabulary: (names) =>
    `(?:${EN_MED_NOUN}|${medicationExtras(EN_MED_CLASS, names)})`,
  doseChangeClass: (med) => [
    new RegExp(
      `\\b(?:increase|raise|up|bump|boost|titrate|step|move|go|ramp|push|switch|change|adjust|lower|reduce|cut|drop|decrease|taper|halve|double|trim|bring)\\s+${EN_SLOT}(?:from\\s+${TARGET}\\s+)?(?:up\\s+|down\\s+|back\\s+)?(?:to|by)\\s+${TARGET}`,
      "i",
    ),
    new RegExp(
      `${EN_CUE}[^.?!]{0,20}?\\b(?:increas(?:e|ing)|rais(?:e|ing)|bump(?:ing)?|boost(?:ing)?|titrat(?:e|ing)|lower(?:ing)?|reduc(?:e|ing)|cut(?:ting)?|drop(?:ping)?|decreas(?:e|ing)|taper(?:ing)?|halv(?:e|ing)|doubl(?:e|ing)|switch(?:ing)?|adjust(?:ing)?|go(?:ing)?\\s+up|step(?:ping)?\\s+up)\\s+${EN_SLOT}(?:from\\s+${TARGET}\\s+)?(?:up\\s+|down\\s+)?(?:to|by)\\s+${TARGET}`,
      "i",
    ),
    new RegExp(
      `${EN_LEAD}(?:take|start\\s+(?:taking|on|with|at)|begin\\s+(?:taking|with|at)|inject|use|give\\s+yourself)\\s+${EN_SLOT}${TARGET}`,
      "im",
    ),
    new RegExp(
      `${EN_LEAD}(?:halve|double|skip|pause|hold|drop|miss|split|cut)\\s+${EN_SLOT}${med}`,
      "im",
    ),
    new RegExp(
      `${EN_LEAD}(?:(?:(?:stop|quit)\\s+(?:taking|injecting)|discontinue)\\s+\\S|(?:come|wean\\s+(?:yourself\\s+)?)\\s*off\\s+${EN_SLOT}${med})`,
      "im",
    ),
    new RegExp(
      `${EN_CUE}[^.?!]{0,20}?\\b(?:(?:halv|doubl|skipp|paus|hold|dropp|miss|splitt|cutt)ing\\s+${EN_SLOT}${med}|(?:stopping|quitting)\\s+(?:taking|injecting)\\s+\\S|discontinuing\\s+\\S|coming\\s+off\\s+${EN_SLOT}${med})`,
      "i",
    ),
    // An extra, another or one more of a medication: "take an extra
    // ramipril", "take one more tablet of ramipril". The short slot ends at a
    // preposition, so "take an extra minute to log your medication" passes.
    new RegExp(
      `${EN_LEAD}(?:take|use|inject|add|give\\s+yourself|pop)\\s+(?:another|(?:(?:an?|one|two|three|\\d+)\\s+)?(?:extra|additional|more|further|second))\\s+${EN_SHORT}${med}`,
      "im",
    ),
    // Stop, leave out or go without a named medication or a drug class:
    // "stop your blood thinner", "leave out the Eliquis".
    new RegExp(
      `${EN_LEAD}(?:stop|quit|discontinue|omit|leave\\s+out|hold\\s+off\\s+on|go\\s+without)\\s+${EN_SHORT}${med}`,
      "im",
    ),
    new RegExp(`${EN_LEAD}leave\\s+${EN_SHORT}${med}\\s+out\\b`, "im"),
    // The same behind a recommending cue. A referral ("before", "ask",
    // "whether") or a negation between the cue and the verb ends it.
    new RegExp(
      `${EN_CUE}(?:(?!\\b(?:not|never|before|without|until|unless|ask|asking|whether|if)\\b)[^.?!]){0,20}?\\b(?:(?:stopping|omitting|leaving\\s+out)\\s+${EN_SHORT}${med}|taking\\s+(?:another|(?:(?:an?|one|two|\\d+)\\s+)?(?:extra|additional|more))\\s+${EN_SHORT}${med})`,
      "i",
    ),
    // Halving or a fraction with no number: "reduce your dose by half",
    // "take half a dose". A half hour or half your sugar names no medication.
    unlessDeferred(
      EN_DEFERRAL,
      new RegExp(
        `${EN_LEAD}(?:reduce|cut|lower|decrease|drop|split|break|divide)\\s+${EN_SHORT}${med}\\s+(?:by|in)\\s+(?:a\\s+)?half\\b`,
        "im",
      ),
    ),
    unlessDeferred(
      EN_DEFERRAL,
      new RegExp(
        `${EN_LEAD}(?:take|use|inject|give\\s+yourself)\\s+(?:only\\s+|just\\s+)?half\\s+(?:of\\s+)?(?:(?:a|an|the|your)\\s+)?${EN_SHORT}${med}`,
        "im",
      ),
    ),
    // A bare change imperative on a medication, no target: "reduce your
    // dose.", "increase your insulin slightly". The medication noun has to
    // close the clause or meet a time or degree word, so "reduce your dose of
    // stress" and "cut your medication costs" are not read as one.
    unlessDeferred(
      EN_DEFERRAL,
      new RegExp(
        `${EN_LEAD}(?:increase|raise|up|boost|bump|reduce|lower|decrease|cut|drop)\\s+${EN_SHORT}${med}(?=\\s*(?:[.!?;:)]|$)|\\s+(?:now|today|tonight|tomorrow|a\\s+(?:bit|little)|slightly|gradually|somewhat|this\\s+week|for|until|from\\s+now)\\b)`,
        "im",
      ),
    ),
    // A negated intake is a hold: "Don't take atorvastatin tonight", "Do not
    // take your metoprolol." A description ("if you don't take", "you
    // don't take") and the "why don't you take" nudge sit outside it.
    new RegExp(
      `(?<!\\b(?:why|if|you|they|we|i|when|that|who)\\s)\\b(?:(?:don['’]?t|do\\s+not|you\\s+should(?:n['’]t|\\s+not))\\s+(?:take|use|inject|give\\s+yourself)|avoid\\s+(?:taking|using|injecting))\\s+${EN_HOLD_SLOT}${med}${EN_HOLD_END}`,
      "i",
    ),
    // A pause: "Take a break from enalapril", "give yourself a break from
    // the metformin". A break from screens or sitting names no medication.
    new RegExp(
      `${EN_LEAD}(?:take|have|give\\s+(?:yourself|your\\s+body))\\s+(?:an?\\s+)?(?:[^\\s\\d.?!,;:]+\\s+){0,2}?(?:break|pause|holiday|rest|vacation)\\s+from\\s+(?:taking\\s+)?${EN_SHORT}${med}`,
      "im",
    ),
    // An increment with no target: "Add 4 more units of insulin", "inject 3
    // extra units". The amount has to carry a drug unit, so "add 2 more
    // walks" and "take 10 more minutes" pass.
    new RegExp(
      `${EN_LEAD}(?:add|take|inject|use|give\\s+yourself|pop)\\s+(?:another\\s+|an?\\s+(?:extra|additional)\\s+)?(?:[\\d.,]+|${SPELLED_COUNT})\\s*(?:(?:more|extra|additional|further)\\s+)?${DRUG_UNIT}${UNIT_END}`,
      "im",
    ),
    // A measured volume of a liquid drug form: "Take 10 ml of the syrup".
    // "Drink 500 ml of water" names no drug form and passes.
    new RegExp(
      `${EN_LEAD}(?:take|use|give\\s+yourself|swallow|measure\\s+out)\\s+(?:[\\d.,]+|${SPELLED_COUNT}|half\\s+a)\\s*(?:${LIQUID_UNIT}|teaspoons?|tsp|tablespoons?|tbsp)${UNIT_END}\\s+(?:of\\s+)?${EN_SHORT}(?:${EN_LIQUID}|${med})`,
      "im",
    ),
  ],
  dose: [
    // step/move/increase/raise/bump/titrate/go up to|by N unit
    new RegExp(
      `\\b(?:step|move|increase|raise|bump|titrat\\w*|go|ramp|push|up)\\s+(?:it\\s+)?(?:up\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // lower/reduce/cut/drop/decrease/back off/taper(ing) to|by N unit
    new RegExp(
      `\\b(?:lower|reduce|cut|drop|decrease|back\\s+off|taper\\w*)\\s+(?:it\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // consider/try/should/recommend ... N unit
    new RegExp(
      `\\b(?:consider|try|you\\s+should|i'?d?\\s+recommend|i\\s+suggest)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // Experiment-shaped dose changes the "to/by N unit" patterns miss. BOTH a
    // medication object AND a trial cue are required, so a benign behavioural
    // experiment ("double your steps for two weeks") never trips.
    /\b(?:halv\w*|doubl\w*|skip\w*|stop\s+taking|quit\s+taking|come\s+off)\b[^.?!]{0,25}\b(?:dose|doses|pill|pills|tablet|tablets|medication|meds?|insulin|injection)\b[^.?!]{0,40}\b(?:for\s+\w+\s+(?:day|days|week|weeks|month|months)|to\s+(?:see|test|try|check)|next\s+(?:week|month))\b/i,
  ],
  risk: [
    // (1) digit percent adjacent to a risk noun, either order
    new RegExp(`\\b\\d{1,3}\\s*%\\s+${RISK_NOUN_EN}\\b`, "i"),
    new RegExp(
      `\\b${RISK_NOUN_EN}\\s+(?:of|is|at|around|about|near|sits?\\s+at|would\\s+be)\\s+(?:about\\s+|roughly\\s+|approximately\\s+|around\\s+|~)?\\d{1,3}\\s*%`,
      "i",
    ),
    // (2) spelled-out percent as a risk figure, either order (D4b)
    new RegExp(`\\b${RISK_NOUN_EN}\\b[^.?!]{0,40}\\b${PCT_WORD_EN}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_EN}\\b[^.?!]{0,40}\\b${RISK_NOUN_EN}\\b`, "i"),
    // (3) 10-year horizon phrase + a qualifying number, either order (M4)
    new RegExp(`\\b${HORIZON_EN}\\b[^.?!]{0,40}${QUAL_NUM_EN}`, "i"),
    new RegExp(`${QUAL_NUM_EN}[^.?!]{0,40}\\b${HORIZON_EN}\\b`, "i"),
    // (4) named engine + a qualifying number, either order
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_EN}`, "i"),
    new RegExp(`${QUAL_NUM_EN}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    // (5) engine / horizon + a categorical RESULT assertion, numberless (D4)
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,60}${RESULT_VERB_EN}`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,60}${RISK_BAND_EN}`,
      "i",
    ),
    // (6) engine / horizon + a categorical risk-level verdict, numberless
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,40}${RISK_VERDICT_EN}`,
      "i",
    ),
  ],
  causal: [
    /\bbecause\b/i,
    /\bcaused?\s+by\b/i,
    /\bcaus(?:e|es|ed|ing)\b/i,
    /\bdue\s+to\b/i,
    /\bled\s+to\b/i,
    /\bresulted\s+in\b/i,
    /\bresult\s+of\b/i,
    /\bculprit\b/i,
    /\bdriven\s+by\b/i,
    /\bthanks\s+to\b/i,
    /\bowing\s+to\b/i,
    /\bresponsible\s+for\b/i,
  ],
  continuation:
    /\b(?:keep\s+taking|keep\s+on\s+taking|continue\s+(?:taking|with|on)|stay(?:ing)?\s+(?:on|at)|remain(?:ing)?\s+on|as\s+prescribed|as\s+directed|as\s+usual|as\s+before|as\s+you\s+have\s+been)\b/i,
  changeStem:
    /\b(?:increas|reduc|taper|titrat|step\s+(?:up|down)|lower|raise|halv|doubl|skip|bump|ramp)\w*/i,
};
