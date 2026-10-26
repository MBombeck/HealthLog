/**
 * PHQ-9, Polish: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "Polish for Poland", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Polish%20for%20Poland.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Jak często w ciągu ostatnich 2 tygodni dokuczały Panu/Pani następujące problemy?",
  },
  items: [
    "Niewielkie zainteresowanie lub odczuwanie przyjemności z wykonywania czynności",
    "Uczucie smutku, przygnębienia lub beznadziejności",
    "Kłopoty z zaśnięciem lub przerywany sen, albo zbyt długi sen",
    "Uczucie zmęczenia lub brak energii",
    "Brak apetytu lub przejadanie się",
    "Poczucie niezadowolenia z siebie — lub uczucie, że jest się do niczego, albo że zawiódł/zawiodła Pan/Pani siebie lub rodzinę",
    "Problemy ze skupieniem się na przykład przy czytaniu gazety lub oglądaniu telewizji",
    "Poruszanie się lub mówienie tak wolno, że inni mogliby to zauważyć? Albo wręcz przeciwnie — niemożność usiedzenia w miejscu lub podenerwowanie powodujące ruchliwość znacznie większą niż zwykle",
    "Myśli, że lepiej byłoby umrzeć, albo chęć zrobienia sobie jakiejś krzywdy",
  ],
  anchors: {
    all: {
      0: "Wcale nie dokuczały",
      1: "Kilka dni",
      2: "Więcej niż połowę dni",
      3: "Niemal codziennie",
    },
  },
  functional: {
    title:
      "Jeżeli zaznaczył/-a Pan/Pani którekolwiek z problemów, jak bardzo utrudniły one Panu/Pani wykonywanie pracy, zajmowanie się domem lub relacje z innymi ludźmi?",
    anchors: {
      0: "W ogóle nie utrudniły",
      1: "Trochę utrudniły",
      2: "Bardzo utrudniły",
      3: "Niezmiernie utrudniły",
    },
  },
};

export default wording;
