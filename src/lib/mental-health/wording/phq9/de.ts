/**
 * PHQ-9, German: a validated translation, reproduced word for word.
 *
 * The PHQ-D wording of Löwe, Spitzer, Zipfel & Herzog (Pfizer 2002),
 * "Gesundheitsfragebogen für Patienten (PHQ-9)". The published form
 * addresses the reader formally, and so does this text.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "German for Germany", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_German%20for%20Germany.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "Wie oft fühlten Sie sich im Verlauf der letzten 2 Wochen durch die folgenden Beschwerden beeinträchtigt?",
  },
  items: [
    "Wenig Interesse oder Freude an Ihren Tätigkeiten",
    "Niedergeschlagenheit, Schwermut oder Hoffnungslosigkeit",
    "Schwierigkeiten, ein- oder durchzuschlafen, oder vermehrter Schlaf",
    "Müdigkeit oder Gefühl, keine Energie zu haben",
    "Verminderter Appetit oder übermäßiges Bedürfnis zu essen",
    "Schlechte Meinung von sich selbst; Gefühl, ein Versager zu sein oder die Familie enttäuscht zu haben",
    "Schwierigkeiten, sich auf etwas zu konzentrieren, z. B. beim Zeitungslesen oder Fernsehen",
    "Waren Ihre Bewegungen oder Ihre Sprache so verlangsamt, dass es auch anderen auffallen würde? Oder waren Sie im Gegenteil „zappelig“ oder ruhelos und hatten dadurch einen stärkeren Bewegungsdrang als sonst?",
    "Gedanken, dass Sie lieber tot wären oder sich Leid zufügen möchten",
  ],
  anchors: {
    all: {
      0: "Überhaupt nicht",
      1: "An einzelnen Tagen",
      2: "An mehr als der Hälfte der Tage",
      3: "Beinahe jeden Tag",
    },
  },
  functional: {
    title:
      "Wenn eines oder mehrere der bisher in diesem Fragebogen beschriebenen Probleme bei Ihnen vorliegen, geben Sie bitte an, wie sehr diese Probleme es Ihnen erschwert haben, Ihre Arbeit zu tun, Ihren Haushalt zu regeln oder mit anderen Menschen zurecht zu kommen:",
    anchors: {
      0: "Überhaupt nicht erschwert",
      1: "Etwas erschwert",
      2: "Stark erschwert",
      3: "Extrem erschwert",
    },
  },
};

export default wording;
