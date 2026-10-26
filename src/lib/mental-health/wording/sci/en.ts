/**
 * SCI, English: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    "Espie CA, Kyle SD, Hames P, et al. The Sleep Condition Indicator: a clinical screening tool to evaluate insomnia disorder. BMJ Open 2014;4:e004183, https://bmjopen.bmj.com/content/4/3/e004183. © Sleepio Limited; free for non-commercial use (CC BY-NC).",
  stems: {
    night: "Thinking about a typical night in the last month …",
    impact: "Thinking about the past month, to what extent has poor sleep …",
    finally: "Finally …",
  },
  items: [
    "… how long does it take you to fall asleep?",
    "… if you then wake up during the night … how long are you awake for in total? (add all the wakenings up)",
    "… how many nights a week do you have a problem with your sleep?",
    "… how would you rate your sleep quality?",
    "… affected your mood, energy, or relationships?",
    "… affected your concentration, productivity, or ability to stay awake?",
    "… troubled you in general?",
    "… how long have you had a problem with your sleep?",
  ],
  anchors: {
    duration: {
      0: "≥ 61 min",
      1: "46–60 min",
      2: "31–45 min",
      3: "16–30 min",
      4: "0–15 min",
    },
    nights: { 0: "5–7", 1: "4", 2: "3", 3: "2", 4: "0–1" },
    quality: {
      0: "Very poor",
      1: "Poor",
      2: "Average",
      3: "Good",
      4: "Very good",
    },
    impact: {
      0: "Very much",
      1: "Much",
      2: "Somewhat",
      3: "A little",
      4: "Not at all",
    },
    problemDuration: {
      0: "> 1 year",
      1: "7–12 months",
      2: "3–6 months",
      3: "1–2 months",
      4: "I don't have a problem / < 1 month",
    },
  },
};

export default wording;
