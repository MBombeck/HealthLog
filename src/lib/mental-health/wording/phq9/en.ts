/**
 * PHQ-9, English: a validated translation, reproduced word for word.
 *
 * Kroenke, Spitzer & Williams, J Gen Intern Med 2001;16:606-613.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    "Pfizer Inc., Patient Health Questionnaire-9 (PHQ-9), the English original, read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ-9_English.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.",
  stems: {
    period:
      "Over the last 2 weeks, how often have you been bothered by any of the following problems?",
  },
  items: [
    "Little interest or pleasure in doing things",
    "Feeling down, depressed, or hopeless",
    "Trouble falling or staying asleep, or sleeping too much",
    "Feeling tired or having little energy",
    "Poor appetite or overeating",
    "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
    "Trouble concentrating on things, such as reading the newspaper or watching television",
    "Moving or speaking so slowly that other people could have noticed. Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual",
    "Thoughts that you would be better off dead, or of hurting yourself in some way",
  ],
  anchors: {
    all: {
      0: "Not at all",
      1: "Several days",
      2: "More than half the days",
      3: "Nearly every day",
    },
  },
  functional: {
    title:
      "If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?",
    anchors: {
      0: "Not difficult at all",
      1: "Somewhat difficult",
      2: "Very difficult",
      3: "Extremely difficult",
    },
  },
};

export default wording;
