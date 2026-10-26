/**
 * GAD-7, Portuguese (Brazil): a validated translation, reproduced word for word.
 *
 * Spelling as printed, including the pre-2009 "freqüência".
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., GAD-7, official translation "Portuguese for Brazil", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Portuguese%20for%20Brazil.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Durante as últimas 2 semanas, com que freqüência você foi incomodado/a pelos problemas abaixo?",
  },
  items: [
    "Sentir-se nervoso/a, ansioso/a ou muito tenso/a",
    "Não ser capaz de impedir ou de controlar as preocupações",
    "Preocupar-se muito com diversas coisas",
    "Dificuldade para relaxar",
    "Ficar tão agitado/a que se torna difícil permanecer sentado/a",
    "Ficar facilmente aborrecido/a ou irritado/a",
    "Sentir medo como se algo horrível fosse acontecer",
  ],
  anchors: {
    all: {
      0: "Nenhuma vez",
      1: "Vários dias",
      2: "Mais da metade dos dias",
      3: "Quase todos os dias",
    },
  },
};

export default wording;
