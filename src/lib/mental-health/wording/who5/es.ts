/**
 * WHO-5, Spanish: a validated translation, reproduced word for word.
 *
 * The sheet misprints item 4 as "descandado"; this text keeps the word it
 * means, "descansado". Nothing else differs from the sheet.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Psychiatric Research Unit (WHO Collaborating Centre in Mental Health, Mental Health Centre North Zealand) translation, republished by WHO beside WHO/UCN/MSD/MHE/2024.1 (licence CC BY-NC-SA 3.0 IGO). Spanish, 1998 version ("OMS (cinco) Indice de Bienestar"), read from https://cdn.who.int/media/docs/default-source/mental-health/oms-(cinco)-indice-de-bienestar-(oms-5).pdf.',
  stems: { period: "Durante las últimas dos semanas:" },
  items: [
    "Me he sentido alegre y de buen humor",
    "Me he sentido tranquilo y relajado",
    "Me he sentido activo y enérgico",
    "Me he despertado fresco y descansado",
    "Mi vida cotidiana ha estado llena de cosas que me interesan",
  ],
  anchors: {
    all: {
      0: "Nunca",
      1: "De vez en cuando",
      2: "Menos de la mitad del tiempo",
      3: "Más de la mitad del tiempo",
      4: "La mayor parte del tiempo",
      5: "Todo el tiempo",
    },
  },
};

export default wording;
