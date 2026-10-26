/**
 * GAD-7, Spanish: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., GAD-7, official translation "Spanish for Spain", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Spanish%20for%20Spain.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "En los últimos 14 días, ¿con qué frecuencia le han supuesto una molestia los siguientes problemas?",
  },
  items: [
    "Sentirse nervioso/a, angustiado/a o muy tenso/a",
    "Ser incapaz de dejar de preocuparse o de controlar la preocupación",
    "Preocuparse demasiado por diferentes cuestiones",
    "Tener problemas para relajarse",
    "Estar tan inquieto/a que le resulta difícil permanecer sentado/a",
    "Enfadarse o irritarse con facilidad",
    "Sentir miedo de que algo terrible pueda ocurrir",
  ],
  anchors: {
    all: {
      0: "Nunca",
      1: "Varios días",
      2: "Más de la mitad de los días",
      3: "Casi cada día",
    },
  },
};

export default wording;
