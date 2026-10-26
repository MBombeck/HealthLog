/**
 * GAD-7, French: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., GAD-7, official translation "French for France", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_French%20for%20France.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Au cours des 2 dernières semaines, selon quelle fréquence avez-vous été gêné(e) par les problèmes suivants ?",
  },
  items: [
    "Un sentiment de nervosité, d’anxiété ou de tension",
    "Une incapacité à arrêter de s’inquiéter ou à contrôler ses inquiétudes",
    "Une inquiétude excessive à propos de différentes choses",
    "Des difficultés à se détendre",
    "Une agitation telle qu’il est difficile à tenir en place",
    "Une tendance à être facilement contrarié(e) ou irritable",
    "Un sentiment de peur comme si quelque chose de terrible risquait de se produire",
  ],
  anchors: {
    all: {
      0: "Jamais",
      1: "Plusieurs jours",
      2: "Plus de la moitié du temps",
      3: "Presque tous les jours",
    },
  },
};

export default wording;
