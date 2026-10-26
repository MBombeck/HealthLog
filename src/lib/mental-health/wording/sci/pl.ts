/**
 * SCI, Polish: a validated translation, reproduced word for word.
 *
 * Validated psychometrically in an online panel (n = 1,282); the paper
 * reports no diagnostic interview. As printed, with three changes of
 * typography only: the items that open with three full stops open with
 * the ellipsis the others use, the stray "<" left at the end of the first
 * answer to item 8 (a remnant of the English "< 1 month" with no number
 * after it) is dropped, and the slash in that answer is spaced. The
 * fourth duration answer reads "45-60 min" in the published version
 * (the English form has 46–60) and is kept. Item 6 renders "ability to
 * stay awake" as excessive sleepiness, as the validated version does.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Bidzan-Wiącek M, Cieślak M, Łockiewicz M, et al. Polish validation of the Sleep Condition Indicator (SCI-PL) for screening insomnia disorder based on DSM-5 criteria. Sci Rep 2026, doi:10.1038/s41598-026-71789-4, Supplementary Material 1, Appendix 1 ("Wskaźnik jakości snu (SCI)"), https://www.nature.com/articles/s41598-026-71789-4. Article licensed CC BY 4.0; the SCI itself © Sleepio Limited, free for non-commercial use (CC BY-NC), Espie et al., BMJ Open 2014;4:e004183.',
  stems: {
    night: "Biorąc pod uwagę typową noc w ciągu ostatniego miesiąca…",
    impact:
      "Biorąc pod uwagę tylko ostatni miesiąc, w jakim stopniu problemy ze snem…",
    finally: "Ostatnie pytanie…",
  },
  items: [
    "…ile czasu zajmuje Panu(-i) zaśnięcie?",
    "…jeśli po zaśnięciu wybudza się Pan(i) w nocy, jak długo łącznie Pan(i) nie śpi? (prosimy zsumować czas wszystkich wybudzeń)",
    "…przez ile nocy w tygodniu ma Pan(i) problemy ze snem?",
    "…jak ocenił(a)by Pan(i) jakość swojego snu?",
    "…wpłynęły na Pana(-i) nastrój, poziom energii lub relacje z innymi?",
    "…wpłynęły na Pana(-i) koncentrację, produktywność lub spowodowały nadmierną senność?",
    "…ogólnie Panu(-i) przeszkadzał?",
    "…od jak dawna ma Pan(i) problemy ze snem?",
  ],
  anchors: {
    duration: {
      0: "≥ 61 min",
      1: "45-60 min",
      2: "31-45 min",
      3: "16-30 min",
      4: "0-15 min",
    },
    nights: { 0: "5-7", 1: "4", 2: "3", 3: "2", 4: "0-1" },
    quality: {
      0: "Bardzo źle",
      1: "Źle",
      2: "Średnio",
      3: "Dobrze",
      4: "Bardzo dobrze",
    },
    impact: {
      0: "Bardzo mocno",
      1: "Mocno",
      2: "Lekko",
      3: "Trochę",
      4: "Wcale",
    },
    problemDuration: {
      0: "Ponad rok",
      1: "7-12 miesięcy",
      2: "3-6 miesięcy",
      3: "1-2 miesiące",
      4: "Nie mam problemów / krócej niż miesiąc",
    },
  },
};

export default wording;
