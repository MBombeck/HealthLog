/**
 * PHQ-9, Italian: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "Italian for Italy", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Italian%20for%20Italy.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Nelle ultime 2 settimane, con quale frequenza le ha dato fastidio ciascuno dei seguenti problemi?",
  },
  items: [
    "Scarso interesse o piacere nel fare le cose",
    "Sentirsi giù, triste o disperato/a",
    "Problemi ad addormentarsi o a dormire tutta la notte senza svegliarsi, o a dormire troppo",
    "Sentirsi stanco/a o avere poca energia",
    "Scarso appetito o mangiare troppo",
    "Avere una scarsa opinione di sé, o sentirsi un/una fallito/a o aver deluso se stesso/a o i propri familiari",
    "Difficoltà a concentrarsi su qualcosa, per esempio leggere il giornale o guardare la televisione",
    "Muoversi o parlare così lentamente da poter essere notato/a da altre persone. O, al contrario, essere così irrequieto/a da muoversi molto più del solito",
    "Pensare che sarebbe meglio morire o farsi del male in un modo o nell’altro",
  ],
  anchors: {
    all: {
      0: "Mai",
      1: "Alcuni giorni",
      2: "Per più della metà dei giorni",
      3: "Quasi ogni giorno",
    },
  },
  functional: {
    title:
      "Se ha fatto una crocetta su uno qualsiasi di questi problemi, quanto questi problemi le hanno reso difficile fare il suo lavoro, occuparsi delle sue cose a casa o avere buoni rapporti con gli altri?",
    anchors: {
      0: "Per niente difficile",
      1: "Abbastanza difficile",
      2: "Molto difficile",
      3: "Estremamente difficile",
    },
  },
};

export default wording;
