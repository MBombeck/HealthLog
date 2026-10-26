/**
 * GAD-7, Dutch: a validated translation, reproduced word for word.
 *
 * The GAD-7 sheet sets its headers as "Helemaal / Niet" and
 * "Verschei- / Dene dagen": line-break artefacts of the same words the
 * PHQ-9 sheet prints as "Helemaal niet" and "Verscheidene dagen".
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., GAD-7, official translation "Dutch for the Netherlands", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Dutch%20for%20the%20Netherlands.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Hoe vaak hebt u in de afgelopen 2 weken last gehad van één of meer van de volgende problemen?",
  },
  items: [
    "U nerveus, angstig of gespannen voelen",
    "Niet kunnen stoppen met u zorgen maken of dit niet kunnen beteugelen",
    "U te veel zorgen maken om verschillende dingen",
    "Moeite hebben u te ontspannen",
    "Zo rusteloos zijn dat het moeilijk is om stil te zitten",
    "Snel geërgerd of geïrriteerd zijn",
    "Bang zijn dat er iets vreselijks zou kunnen gebeuren",
  ],
  anchors: {
    all: {
      0: "Helemaal niet",
      1: "Verscheidene dagen",
      2: "Meer dan de helft van de dagen",
      3: "Bijna elke dag",
    },
  },
};

export default wording;
