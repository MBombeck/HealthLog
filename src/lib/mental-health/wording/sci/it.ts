/**
 * SCI, Italian: not a validated translation.
 *
 * No validated translation of the SCI in this language could be found whose
 * item text is openly published for reuse. This is a translation written for
 * HealthLog, faithful to the English and on the same scale; the surfaces say
 * so beside it and offer the English original.
 *
 * A validated Italian SCI exists (Palagini et al., Int J Psychophysiol
 * 2015;98:435-440); its item text is not openly published.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: {
    night: "Pensando a una notte tipica dell’ultimo mese …",
    impact: "Pensando all’ultimo mese, in che misura il sonno scarso …",
    finally: "Infine …",
  },
  items: [
    "… quanto tempo impiega ad addormentarsi?",
    "… se poi si sveglia durante la notte … per quanto tempo resta sveglio/a in totale? (sommi tutti i risvegli)",
    "… quante notti alla settimana ha un problema con il sonno?",
    "… come valuterebbe la qualità del suo sonno?",
    "… ha influito sul suo umore, sulla sua energia o sulle sue relazioni?",
    "… ha influito sulla sua concentrazione, sulla sua produttività o sulla sua capacità di restare sveglio/a?",
    "… le ha dato fastidio in generale?",
    "… da quanto tempo ha un problema con il sonno?",
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
      0: "Molto scarsa",
      1: "Scarsa",
      2: "Nella media",
      3: "Buona",
      4: "Molto buona",
    },
    impact: {
      0: "Moltissimo",
      1: "Molto",
      2: "Abbastanza",
      3: "Un poco",
      4: "Per niente",
    },
    problemDuration: {
      0: "> 1 anno",
      1: "7–12 mesi",
      2: "3–6 mesi",
      3: "1–2 mesi",
      4: "Non ho problemi / < 1 mese",
    },
  },
};

export default wording;
