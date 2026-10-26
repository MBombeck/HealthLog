/**
 * GAD-7, German: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Löwe B et al., "Gesundheitsfragebogen für Patienten (GAD-7)", German version © Bernd Löwe 2015, Universitätsklinikum Hamburg-Eppendorf; validation: Löwe et al., Med Care 2008;46:266-274. Read from the copy distributed by LMU München, https://cms-cdn.lmu.de/media/lmu/downloads/diversity/wecare/gad-7_deutsch.pdf (the UKE distributes the same form). Pfizer distributes no "German for Germany" GAD-7; this is the German form the validation used. Reproduction free, as for the PHQ family.',
  stems: {
    period:
      "Wie oft fühlten Sie sich im Verlauf der letzten 2 Wochen durch die folgenden Beschwerden beeinträchtigt?",
  },
  items: [
    "Nervosität, Ängstlichkeit oder Anspannung",
    "Nicht in der Lage sein, Sorgen zu stoppen oder zu kontrollieren",
    "Übermäßige Sorgen bezüglich verschiedener Angelegenheiten",
    "Schwierigkeiten zu entspannen",
    "Rastlosigkeit, so dass Stillsitzen schwer fällt",
    "Schnelle Verärgerung oder Gereiztheit",
    "Gefühl der Angst, so als würde etwas Schlimmes passieren",
  ],
  anchors: {
    all: {
      0: "Überhaupt nicht",
      1: "An einzelnen Tagen",
      2: "An mehr als der Hälfte der Tage",
      3: "Beinahe jeden Tag",
    },
  },
};

export default wording;
