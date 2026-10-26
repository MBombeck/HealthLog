/**
 * WHO-5, English: a validated translation, reproduced word for word.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    "World Health Organization. The World Health Organization-Five Well-Being Index (WHO-5). Geneva: World Health Organization; 2024 (WHO/UCN/MSD/MHE/2024.1), https://www.who.int/publications/m/item/WHO-UCN-MSD-MHE-2024.01. Licence: CC BY-NC-SA 3.0 IGO.",
  stems: { period: "Over the last two weeks …" },
  items: [
    "I have felt cheerful and in good spirits",
    "I have felt calm and relaxed",
    "I have felt active and vigorous",
    "I woke up feeling fresh and rested",
    "My daily life has been filled with things that interest me",
  ],
  anchors: {
    all: {
      0: "At no time",
      1: "Some of the time",
      2: "Less than half of the time",
      3: "More than half of the time",
      4: "Most of the time",
      5: "All of the time",
    },
  },
};

export default wording;
