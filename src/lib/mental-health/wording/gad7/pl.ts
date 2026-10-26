/**
 * GAD-7, Polish: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., GAD-7, official translation "Polish for Poland", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Polish%20for%20Poland.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Jak często w ciągu ostatnich 2 tygodni dokuczały Panu(i) następujące problemy?",
  },
  items: [
    "Czuł(a) się Pan(i) podenerwowany(a), niespokojny(a), mocno spięty(a)",
    "Nie mógł(a) Pan(i) przestać się martwić albo zapanować nad tym",
    "Za bardzo się Pan(i) martwił(a) różnymi rzeczami",
    "Miał(a) Pan(i) trudności z relaksowaniem się",
    "Był(a) Pan(i) tak niespokojny(a), że nie mógł(a) usiedzieć na miejscu",
    "Łatwo stawał(a) się Pan(i) rozdrażniony(a) lub poirytowany(a)",
    "Obawiał(a) się Pan(i), tak jakby miało się stać coś strasznego",
  ],
  anchors: {
    all: {
      0: "Wcale nie dokuczały",
      1: "Kilka dni",
      2: "Więcej niż połowę dni",
      3: "Niemal codziennie",
    },
  },
};

export default wording;
