/**
 * WHO-5, Italian: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Psychiatric Research Unit (WHO Collaborating Centre in Mental Health, Mental Health Centre North Zealand) translation, republished by WHO beside WHO/UCN/MSD/MHE/2024.1 (licence CC BY-NC-SA 3.0 IGO). Italian, 1998 version ("Questionario dell’OMS (in 5 domande) sullo stato di benessere"), read from https://cdn.who.int/media/docs/default-source/mental-health/five-well-being-index-(who-5)/who-5_italian.pdf.',
  stems: { period: "Nelle ultime due settimane" },
  items: [
    "Mi sono sentito/a allegro/a e di buon umore",
    "Mi sono sentito/a calmo/a e rilassato/a",
    "Mi sono sentito/a attivo/a ed energico/a",
    "Mi sono svegliato/a sentendomi fresco/a e riposato/a",
    "La mia vita di tutti i giorni è stata piena di cose che mi interessano",
  ],
  anchors: {
    all: {
      0: "Mai",
      1: "A volte",
      2: "Meno della metà del tempo",
      3: "Più della metà del tempo",
      4: "La maggior parte del tempo",
      5: "Sempre",
    },
  },
};

export default wording;
