/**
 * SCI, French: not a validated translation.
 *
 * No validated translation of the SCI in this language could be found whose
 * item text is openly published for reuse. This is a translation written for
 * HealthLog, faithful to the English and on the same scale; the surfaces say
 * so beside it and offer the English original.
 *
 * A validated French SCI exists (Bayard et al., J Sleep Res 2017;26:702-708),
 * but its text is published only in the journal (© European Sleep Research
 * Society) and in an accepted manuscript whose repository terms allow one
 * copy for private study, not redistribution in software.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: {
    night: "En pensant à une nuit typique du mois dernier …",
    impact:
      "En pensant au mois dernier, dans quelle mesure votre mauvais sommeil …",
    finally: "Enfin …",
  },
  items: [
    "… combien de temps vous faut-il pour vous endormir ?",
    "… si vous vous réveillez ensuite pendant la nuit … combien de temps restez-vous éveillé(e) au total ? (additionnez tous les réveils)",
    "… combien de nuits par semaine avez-vous un problème de sommeil ?",
    "… comment évalueriez-vous la qualité de votre sommeil ?",
    "… a-t-il affecté votre humeur, votre énergie ou vos relations ?",
    "… a-t-il affecté votre concentration, votre productivité ou votre capacité à rester éveillé(e) ?",
    "… vous a-t-il gêné(e) de manière générale ?",
    "… depuis combien de temps avez-vous un problème de sommeil ?",
  ],
  anchors: {
    duration: {
      0: "≥ 61 min",
      1: "46–60 min",
      2: "31–45 min",
      3: "16–30 min",
      4: "0–15 min",
    },
    nights: { 0: "5–7", 1: "4", 2: "3", 3: "2", 4: "0–1" },
    quality: {
      0: "Très mauvaise",
      1: "Mauvaise",
      2: "Moyenne",
      3: "Bonne",
      4: "Très bonne",
    },
    impact: {
      0: "Énormément",
      1: "Beaucoup",
      2: "Moyennement",
      3: "Un peu",
      4: "Pas du tout",
    },
    problemDuration: {
      0: "> 1 an",
      1: "7–12 mois",
      2: "3–6 mois",
      3: "1–2 mois",
      4: "Je n’ai pas de problème / < 1 mois",
    },
  },
};

export default wording;
