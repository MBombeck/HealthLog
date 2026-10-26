/**
 * WHO-5, Polish: a validated translation, reproduced word for word.
 *
 * The Polish form prints each item in both its feminine and its masculine
 * form, joined by a slash; both are kept.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    "Psychiatric Research Unit (WHO Collaborating Centre in Mental Health, Mental Health Centre North Zealand) translation, republished by WHO beside WHO/UCN/MSD/MHE/2024.1 (licence CC BY-NC-SA 3.0 IGO). Polish version, read from https://cdn.who.int/media/docs/default-source/mental-health/five-well-being-index-(who-5)/who-5_polish.pdf.",
  stems: { period: "W ciągu ostatnich dwóch tygodni" },
  items: [
    "Czułam się wesoła/Czułem się wesoły i w dobrym nastroju",
    "Czułam się spokojna i odprężona/Czułem się spokojny i odprężony",
    "Czułam się aktywna i energiczna/Czułem się aktywny i energiczny",
    "Budziłam się z uczuciem świeżości i wypoczęta/Budziłem się z uczuciem świeżości i wypoczęty",
    "Moje życie codzienne było wypełnione interesującymi mnie sprawami",
  ],
  anchors: {
    all: {
      0: "Nigdy",
      1: "Od czasu do czasu",
      2: "Mniej niż połowę czasu",
      3: "Więcej niż połowę czasu",
      4: "Prawie cały czas",
      5: "Cały czas",
    },
  },
};

export default wording;
