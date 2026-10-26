/**
 * PHQ-9, French: a validated translation, reproduced word for word.
 *
 * The France version, which v1.45 could not obtain, read from the Pfizer
 * distribution itself. Its own heading and column headers, unchanged.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "French for France", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_French%20for%20France.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Au cours des 2 dernières semaines, selon quelle fréquence avez-vous été gêné(e) par les problèmes suivants ?",
  },
  items: [
    "Peu d’intérêt ou de plaisir à faire les choses",
    "Être triste, déprimé(e) ou désespéré(e)",
    "Difficultés à s’endormir ou à rester endormi(e), ou dormir trop",
    "Se sentir fatigué(e) ou manquer d’énergie",
    "Avoir peu d’appétit ou manger trop",
    "Avoir une mauvaise opinion de soi-même, ou avoir le sentiment d’être nul(le), ou d’avoir déçu sa famille ou s’être déçu(e) soi-même",
    "Avoir du mal à se concentrer, par exemple, pour lire le journal ou regarder la télévision",
    "Bouger ou parler si lentement que les autres auraient pu le remarquer. Ou au contraire, être si agité(e) que vous avez eu du mal à tenir en place par rapport à d’habitude",
    "Penser qu’il vaudrait mieux mourir ou envisager de vous faire du mal d’une manière ou d’une autre",
  ],
  anchors: {
    all: {
      0: "Jamais",
      1: "Plusieurs jours",
      2: "Plus de la moitié du temps",
      3: "Presque tous les jours",
    },
  },
  functional: {
    title:
      "Si vous avez coché au moins un des problèmes évoqués, à quel point ce(s) problème(s) a-t-il (ont-ils) rendu votre travail, vos tâches à la maison ou votre capacité à vous entendre avec les autres difficile(s) ?",
    anchors: {
      0: "Pas du tout difficile(s)",
      1: "Assez difficile(s)",
      2: "Très difficile(s)",
      3: "Extrêmement difficile(s)",
    },
  },
};

export default wording;
