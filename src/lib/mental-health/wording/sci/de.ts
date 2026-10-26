/**
 * SCI, German: not a validated translation.
 *
 * No validated translation of the SCI in this language could be found whose
 * item text is openly published for reuse. This is a translation written for
 * HealthLog, faithful to the English and on the same scale; the surfaces say
 * so beside it and offer the English original.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: {
    night: "Wenn Sie an eine typische Nacht im letzten Monat denken …",
    impact:
      "Wenn Sie an den letzten Monat denken: In welchem Ausmaß hat schlechter Schlaf …",
    finally: "Zum Schluss …",
  },
  items: [
    "… wie lange brauchen Sie, um einzuschlafen?",
    "… wenn Sie dann in der Nacht aufwachen … wie lange sind Sie insgesamt wach? (Zählen Sie alle Wachphasen zusammen.)",
    "… in wie vielen Nächten pro Woche haben Sie ein Problem mit Ihrem Schlaf?",
    "… wie würden Sie Ihre Schlafqualität bewerten?",
    "… Ihre Stimmung, Ihre Energie oder Ihre Beziehungen beeinträchtigt?",
    "… Ihre Konzentration, Ihre Leistungsfähigkeit oder Ihre Fähigkeit, wach zu bleiben, beeinträchtigt?",
    "… Sie insgesamt belastet?",
    "… wie lange haben Sie schon ein Problem mit Ihrem Schlaf?",
  ],
  anchors: {
    duration: {
      0: "≥ 61 Min.",
      1: "46–60 Min.",
      2: "31–45 Min.",
      3: "16–30 Min.",
      4: "0–15 Min.",
    },
    nights: { 0: "5–7", 1: "4", 2: "3", 3: "2", 4: "0–1" },
    quality: {
      0: "Sehr schlecht",
      1: "Schlecht",
      2: "Mittelmäßig",
      3: "Gut",
      4: "Sehr gut",
    },
    impact: {
      0: "Sehr stark",
      1: "Stark",
      2: "Mäßig",
      3: "Ein wenig",
      4: "Überhaupt nicht",
    },
    problemDuration: {
      0: "> 1 Jahr",
      1: "7–12 Monate",
      2: "3–6 Monate",
      3: "1–2 Monate",
      4: "Ich habe kein Problem / < 1 Monat",
    },
  },
};

export default wording;
