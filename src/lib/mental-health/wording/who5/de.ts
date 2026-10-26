/**
 * WHO-5, German: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Psychiatric Research Unit (WHO Collaborating Centre in Mental Health, Mental Health Centre North Zealand) translation, republished by WHO beside WHO/UCN/MSD/MHE/2024.1 (licence CC BY-NC-SA 3.0 IGO). German, 1998 version ("WHO (Fünf) - Fragebogen zum Wohlbefinden"), read from https://cdn.who.int/media/docs/default-source/mental-health/five-well-being-index-(who-5)/who-5_german.pdf.',
  stems: { period: "In den letzten zwei Wochen …" },
  items: [
    "… war ich froh und guter Laune",
    "… habe ich mich ruhig und entspannt gefühlt",
    "… habe ich mich energisch und aktiv gefühlt",
    "… habe ich mich beim Aufwachen frisch und ausgeruht gefühlt",
    "… war mein Alltag voller Dinge, die mich interessieren",
  ],
  anchors: {
    all: {
      0: "Zu keinem Zeitpunkt",
      1: "Ab und zu",
      2: "Etwas weniger als die Hälfte der Zeit",
      3: "Etwas mehr als die Hälfte der Zeit",
      4: "Meistens",
      5: "Die ganze Zeit",
    },
  },
};

export default wording;
