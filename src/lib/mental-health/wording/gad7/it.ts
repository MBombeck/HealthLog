/**
 * GAD-7, Italian: a validated translation, reproduced word for word.
 *
 * Option 2 reads "Per oltre la metà dei giorni" here and "Per più della
 * metà dei giorni" on the Italian PHQ-9: the two forms differ, and each
 * keeps its own.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., GAD-7, official translation "Italian for Italy", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Italian%20for%20Italy.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Nelle ultime 2 settimane, con quale frequenza le ha dato fastidio ciascuno dei seguenti problemi?",
  },
  items: [
    "Sentirsi nervoso/a, ansioso/a o teso/a",
    "Non riuscire a smettere di preoccuparsi o a tenere sotto controllo le preoccupazioni",
    "Preoccuparsi troppo per varie cose",
    "Avere difficoltà a rilassarsi",
    "Essere talmente irrequieto/a da far fatica a stare seduto/a fermo/a",
    "Infastidirsi o irritarsi facilmente",
    "Avere paura che possa succedere qualcosa di terribile",
  ],
  anchors: {
    all: {
      0: "Mai",
      1: "Alcuni giorni",
      2: "Per oltre la metà dei giorni",
      3: "Quasi ogni giorno",
    },
  },
};

export default wording;
