/**
 * WHO-5, Dutch: a validated translation, reproduced word for word.
 *
 * The stem is the form's column header; items and answers as printed.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Psychiatric Research Unit (WHO Collaborating Centre in Mental Health, Mental Health Centre North Zealand) translation, republished by WHO beside WHO/UCN/MSD/MHE/2024.1 (licence CC BY-NC-SA 3.0 IGO). Dutch, 1999 version ("WHO (vijf) Welzijnsindex"), read from https://cdn.who.int/media/docs/default-source/mental-health/five-well-being-index-(who-5)/who-5_dutch.pdf.',
  stems: { period: "Gedurende de laatste twee weken" },
  items: [
    "Ik voelde me vrolijk en in een opperbeste stemming",
    "Ik voelde me rustig en ontspannen",
    "Ik voelde me actief en doelbewust",
    "Ik voelde me fris en uitgerust wanneer ik wakker werd",
    "Mijn dagelijkse leven was gevuld met dingen die me interesseren",
  ],
  anchors: {
    all: {
      0: "Helemaal niet",
      1: "Soms",
      2: "Minder dan de helft van de tijd",
      3: "Meer dan de helft van de tijd",
      4: "Meestal",
      5: "Constant",
    },
  },
};

export default wording;
