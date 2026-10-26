/**
 * PHQ-9, Portuguese (Brazil): a validated translation, reproduced word for word.
 *
 * Spelling as printed, including the pre-2009 "freqüência" and the
 * question marks closing item 8's first sentence and the follow-up.
 * Item 9 names self-harm first and death second, as the form does; the
 * item is the same ninth item and is scored and flagged the same way.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "Portuguese for Brazil", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Portuguese%20for%20Brazil.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Durante as últimas 2 semanas, com que freqüência você foi incomodado/a por qualquer um dos problemas abaixo?",
  },
  items: [
    "Pouco interesse ou pouco prazer em fazer as coisas",
    "Se sentir “para baixo”, deprimido/a ou sem perspectiva",
    "Dificuldade para pegar no sono ou permanecer dormindo, ou dormir mais do que de costume",
    "Se sentir cansado/a ou com pouca energia",
    "Falta de apetite ou comendo demais",
    "Se sentir mal consigo mesmo/a — ou achar que você é um fracasso ou que decepcionou sua família ou você mesmo/a",
    "Dificuldade para se concentrar nas coisas, como ler o jornal ou ver televisão",
    "Lentidão para se movimentar ou falar, a ponto das outras pessoas perceberem? Ou o oposto – estar tão agitado/a ou irrequieto/a que você fica andando de um lado para o outro muito mais do que de costume",
    "Pensar em se ferir de alguma maneira ou que seria melhor estar morto/a",
  ],
  anchors: {
    all: {
      0: "Nenhuma vez",
      1: "Vários dias",
      2: "Mais da metade dos dias",
      3: "Quase todos os dias",
    },
  },
  functional: {
    title:
      "Se você assinalou qualquer um dos problemas, indique o grau de dificuldade que os mesmos lhe causaram para realizar seu trabalho, tomar conta das coisas em casa ou para se relacionar com as pessoas?",
    anchors: {
      0: "Nenhuma dificuldade",
      1: "Alguma dificuldade",
      2: "Muita dificuldade",
      3: "Extrema dificuldade",
    },
  },
};

export default wording;
