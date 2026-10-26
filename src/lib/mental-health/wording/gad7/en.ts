/**
 * GAD-7, English: a validated translation, reproduced word for word.
 *
 * Spitzer, Kroenke, Williams & Löwe, Arch Intern Med 2006;166:1092-1097.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    "Pfizer Inc., Generalized Anxiety Disorder 7-item scale (GAD-7), the English original, read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD-7_English.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.",
  stems: {
    period:
      "Over the last 2 weeks, how often have you been bothered by the following problems?",
  },
  items: [
    "Feeling nervous, anxious, or on edge",
    "Not being able to stop or control worrying",
    "Worrying too much about different things",
    "Trouble relaxing",
    "Being so restless that it is hard to sit still",
    "Becoming easily annoyed or irritable",
    "Feeling afraid as if something awful might happen",
  ],
  anchors: {
    all: {
      0: "Not at all",
      1: "Several days",
      2: "More than half the days",
      3: "Nearly every day",
    },
  },
};

export default wording;
