/**
 * PHQ-9, Dutch: a validated translation, reproduced word for word.
 *
 * The column header printed as "Verschei- / dene dagen" over two lines
 * is the one word "Verscheidene". Item 8 keeps the question mark the
 * form prints after its first sentence.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "Dutch for the Netherlands", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Dutch%20for%20the%20Netherlands.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Hoe vaak hebt u in de afgelopen 2 weken last gehad van één of meer van de volgende problemen?",
  },
  items: [
    "Weinig interesse of plezier in activiteiten",
    "Zich neerslachtig, depressief of hopeloos voelen",
    "Moeilijk inslapen, moeilijk doorslapen of te veel slapen",
    "Zich moe voelen of gebrek aan energie hebben",
    "Weinig eetlust of overmatig eten",
    "Een slecht gevoel hebben over uzelf — of het gevoel hebben dat u een mislukkeling bent of het gevoel dat u zichzelf of uw familie teleurgesteld hebt",
    "Problemen om u te concentreren, bijvoorbeeld om de krant te lezen of om tv te kijken",
    "Zo traag bewegen of zo langzaam spreken dat andere mensen dit opgemerkt kunnen hebben? Of het tegenovergestelde, zo zenuwachtig of rusteloos zijn dat u veel meer bewoog dan gebruikelijk",
    "De gedachte dat u beter dood zou kunnen zijn of de gedachte uzelf op een bepaalde manier pijn te doen",
  ],
  anchors: {
    all: {
      0: "Helemaal niet",
      1: "Verscheidene dagen",
      2: "Meer dan de helft van de dagen",
      3: "Bijna elke dag",
    },
  },
  functional: {
    title:
      "Als u enig probleem hebt aangekruist, hoe moeilijk maakten deze problemen het dan voor u om uw werk of uw taken in en om het huis te doen, of om met andere mensen om te gaan?",
    anchors: {
      0: "Helemaal niet moeilijk",
      1: "Enigszins moeilijk",
      2: "Erg moeilijk",
      3: "Extreem moeilijk",
    },
  },
};

export default wording;
