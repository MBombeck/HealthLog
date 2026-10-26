/**
 * WHO-5, Portuguese (Brazil): not a validated translation.
 *
 * Neither WHO nor the Psychiatric Research Unit publishes a translation of
 * the WHO-5 in this language. This is a translation written for HealthLog,
 * faithful to the WHO 2024 English text and on the same scale; the surfaces
 * say so beside it and offer the English original.
 *
 * A Brazilian Portuguese WHO-5 was validated by de Souza & Hidalgo (Eur
 * Arch Psychiatry Clin Neurosci 2012); its item text is not
 * openly published. WHO distributes a European Portuguese version only.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: { period: "Nas últimas duas semanas …" },
  items: [
    "Eu me senti alegre e de bom humor",
    "Eu me senti calmo/a e relaxado/a",
    "Eu me senti ativo/a e cheio/a de energia",
    "Eu acordei me sentindo disposto/a e descansado/a",
    "Meu dia a dia foi preenchido com coisas que me interessam",
  ],
  anchors: {
    all: {
      0: "Em nenhum momento",
      1: "Algumas vezes",
      2: "Menos da metade do tempo",
      3: "Mais da metade do tempo",
      4: "A maior parte do tempo",
      5: "O tempo todo",
    },
  },
};

export default wording;
