/**
 * SCI, Dutch: not a validated translation.
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
    night: "Als u denkt aan een gewone nacht in de afgelopen maand …",
    impact:
      "Als u denkt aan de afgelopen maand, in hoeverre heeft slecht slapen …",
    finally: "Tot slot …",
  },
  items: [
    "… hoe lang duurt het voordat u in slaap valt?",
    "… als u daarna ’s nachts wakker wordt … hoe lang bent u dan in totaal wakker? (tel alle keren dat u wakker was bij elkaar op)",
    "… hoeveel nachten per week hebt u een probleem met uw slaap?",
    "… hoe zou u de kwaliteit van uw slaap beoordelen?",
    "… invloed gehad op uw stemming, energie of relaties?",
    "… invloed gehad op uw concentratie, productiviteit of vermogen om wakker te blijven?",
    "… u in het algemeen dwarsgezeten?",
    "… hoe lang hebt u al een probleem met uw slaap?",
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
      0: "Zeer slecht",
      1: "Slecht",
      2: "Gemiddeld",
      3: "Goed",
      4: "Zeer goed",
    },
    impact: {
      0: "Heel veel",
      1: "Veel",
      2: "Enigszins",
      3: "Een beetje",
      4: "Helemaal niet",
    },
    problemDuration: {
      0: "> 1 jaar",
      1: "7–12 maanden",
      2: "3–6 maanden",
      3: "1–2 maanden",
      4: "Ik heb geen probleem / < 1 maand",
    },
  },
};

export default wording;
