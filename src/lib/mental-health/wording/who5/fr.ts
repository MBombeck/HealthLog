/**
 * WHO-5, French: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Psychiatric Research Unit (WHO Collaborating Centre in Mental Health, Mental Health Centre North Zealand) translation, republished by WHO beside WHO/UCN/MSD/MHE/2024.1 (licence CC BY-NC-SA 3.0 IGO). French, 1999 version ("Indice (en cinq points) de bien-être de l’OMS"), read from https://cdn.who.int/media/docs/default-source/mental-health/indice-(en-cinq-points)-de-bien--tre-de-l-oms.pdf.',
  stems: { period: "Au cours des deux dernières semaines" },
  items: [
    "Je me suis senti(e) bien et de bonne humeur",
    "Je me suis senti(e) calme et tranquille",
    "Je me suis senti(e) plein(e) d'énergie et vigoureux(se)",
    "Je me suis réveillé(e) en me sentant frais(che) et dispos(e)",
    "Ma vie quotidienne a été remplie de choses intéressantes",
  ],
  anchors: {
    all: {
      0: "Jamais",
      1: "De temps en temps",
      2: "Moins de la moitié du temps",
      3: "Plus de la moitié du temps",
      4: "La plupart du temps",
      5: "Tout le temps",
    },
  },
};

export default wording;
