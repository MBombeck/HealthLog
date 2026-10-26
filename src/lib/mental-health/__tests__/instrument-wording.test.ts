import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import type { InstrumentWording } from "../wording/types";

import { INSTRUMENT_ORDER, isSafetyFlagged } from "../instruments";
import { anchorText, stemText } from "../instrument-wording";
import { WORDING } from "../wording";
import { loadLocaleWording } from "../wording/load";
import {
  isValidatedWording,
  presentedWording,
  wordingFor,
} from "../wording/resolve";

/**
 * How a surface reads questionnaire text, and which wording an
 * administration records. Then spot checks of the validated entries against
 * the published forms named in their `source`: the places a transcription
 * slips (a column header split over lines, an anchor that differs between
 * two forms of one language, a form of address).
 */

describe("reading the wording", () => {
  it("reads the reader's language, and English for a language the app does not ship", () => {
    expect(wordingFor("PHQ9", "nl")).toBe(WORDING.PHQ9.nl);
    expect(wordingFor("PHQ9", "pt-br")).toBe(WORDING.PHQ9["pt-BR"]);
    expect(wordingFor("PHQ9", "de-AT")).toBe(WORDING.PHQ9.de);
    expect(wordingFor("SCI", "ja")).toBe(WORDING.SCI.en);
  });

  it("resolves an answer label through the item's anchor group", () => {
    const sci = WORDING.SCI.en;
    expect(anchorText("SCI", sci, 0, 4)).toBe("0–15 min");
    expect(anchorText("SCI", sci, 2, 0)).toBe("5–7");
    expect(anchorText("SCI", sci, 3, 2)).toBe("Average");
    expect(anchorText("SCI", sci, 6, 1)).toBe("Much");
    expect(anchorText("SCI", sci, 7, 3)).toBe("1–2 months");
    expect(anchorText("PHQ9", WORDING.PHQ9.en, 8, 3)).toBe("Nearly every day");
  });

  it("resolves the stem the form prints above an item", () => {
    expect(stemText("SCI", WORDING.SCI.en, 0)).toBe(
      "Thinking about a typical night in the last month …",
    );
    expect(stemText("SCI", WORDING.SCI.en, 7)).toBe("Finally …");
    expect(stemText("WHO5", WORDING.WHO5.nl, 4)).toBe(
      "Gedurende de laatste twee weken",
    );
  });
});

describe("one language's chunk, as the client loads it", () => {
  it.each(locales)(
    "%s carries that language's file of every instrument",
    async (locale) => {
      const chunk = await loadLocaleWording(locale);
      for (const id of INSTRUMENT_ORDER) {
        expect(chunk[id], `${id} ${locale}`).toBe(WORDING[id][locale]);
      }
      expect(Object.keys(chunk).sort()).toEqual([...INSTRUMENT_ORDER].sort());
    },
  );
});

describe("the wording an administration records", () => {
  it("records a validated language's text as validated", () => {
    expect(presentedWording("PHQ9", "nl", false)).toBe("validated");
    expect(presentedWording("WHO5", "ko", false)).toBe("validated");
    expect(presentedWording("SCI", "pl", false)).toBe("validated");
  });

  it("records HealthLog's own translation as an unvalidated translation", () => {
    expect(presentedWording("SCI", "nl", false)).toBe(
      "unvalidated_translation",
    );
    expect(presentedWording("SCI", "pt-br", false)).toBe(
      "unvalidated_translation",
    );
    expect(presentedWording("WHO5", "pt-BR", false)).toBe(
      "unvalidated_translation",
    );
  });

  it("records the English original when the reader chose it", () => {
    expect(presentedWording("SCI", "nl", true)).toBe("original_en");
    expect(presentedWording("PHQ9", "de", true)).toBe("original_en");
  });

  it("records English for an English reader as validated, whatever the switch says", () => {
    expect(presentedWording("SCI", "en", false)).toBe("validated");
    expect(presentedWording("SCI", "en-GB", true)).toBe("validated");
  });

  it("records the English original for a language the app does not ship", () => {
    expect(presentedWording("PHQ9", "ja", false)).toBe("original_en");
  });

  it("leaves the item-9 crisis flag to the answers alone", () => {
    // The flag reads the ninth answer; no wording or language enters it.
    const answers = [0, 0, 0, 0, 0, 0, 0, 0, 1];
    for (const locale of Object.keys(WORDING.PHQ9) as Locale[]) {
      expect(WORDING.PHQ9[locale].items).toHaveLength(answers.length);
    }
    expect(isSafetyFlagged("PHQ9", answers)).toBe(true);
    expect(isSafetyFlagged("PHQ9", [...answers.slice(0, 8), 0])).toBe(false);
  });
});

describe("validated entries carry the published wording", () => {
  // [instrument, locale, path into the entry, published text]
  const PUBLISHED: ReadonlyArray<
    readonly [
      keyof typeof WORDING,
      Locale,
      (w: InstrumentWording) => unknown,
      string,
    ]
  > = [
    [
      "PHQ9",
      "de",
      (w) => w.stems.period,
      "Wie oft fühlten Sie sich im Verlauf der letzten 2 Wochen durch die folgenden Beschwerden beeinträchtigt?",
    ],
    [
      "PHQ9",
      "de",
      (w) => w.items[6],
      "Schwierigkeiten, sich auf etwas zu konzentrieren, z. B. beim Zeitungslesen oder Fernsehen",
    ],
    ["PHQ9", "de", (w) => w.functional?.anchors[2], "Stark erschwert"],
    [
      "GAD7",
      "de",
      (w) => w.items[4],
      "Rastlosigkeit, so dass Stillsitzen schwer fällt",
    ],
    [
      "GAD7",
      "de",
      (w) => w.items[6],
      "Gefühl der Angst, so als würde etwas Schlimmes passieren",
    ],
    ["WHO5", "de", (w) => w.anchors.all[5], "Die ganze Zeit"],
    ["PHQ9", "es", (w) => w.anchors.all[3], "Casi cada día"],
    [
      "PHQ9",
      "es",
      (w) => w.items[8],
      "Pensamientos de que estaría mejor muerto/a o de querer hacerse daño de algún modo",
    ],
    [
      "GAD7",
      "es",
      (w) => w.items[0],
      "Sentirse nervioso/a, angustiado/a o muy tenso/a",
    ],
    ["PHQ9", "it", (w) => w.anchors.all[2], "Per più della metà dei giorni"],
    ["GAD7", "it", (w) => w.anchors.all[2], "Per oltre la metà dei giorni"],
    ["PHQ9", "it", (w) => w.items[1], "Sentirsi giù, triste o disperato/a"],
    ["PHQ9", "pl", (w) => w.anchors.all[0], "Wcale nie dokuczały"],
    [
      "GAD7",
      "pl",
      (w) => w.items[0],
      "Czuł(a) się Pan(i) podenerwowany(a), niespokojny(a), mocno spięty(a)",
    ],
    ["GAD7", "fr", (w) => w.anchors.all[2], "Plus de la moitié du temps"],
    [
      "GAD7",
      "fr",
      (w) => w.items[0],
      "Un sentiment de nervosité, d’anxiété ou de tension",
    ],
    // Pfizer "French for France".
    ["PHQ9", "fr", (w) => w.anchors.all[0], "Jamais"],
    [
      "PHQ9",
      "fr",
      (w) => w.items[8],
      "Penser qu’il vaudrait mieux mourir ou envisager de vous faire du mal d’une manière ou d’une autre",
    ],
    ["PHQ9", "fr", (w) => w.functional?.anchors[3], "Extrêmement difficile(s)"],
    // Pfizer "Dutch for the Netherlands": the header split over two lines.
    ["PHQ9", "nl", (w) => w.anchors.all[1], "Verscheidene dagen"],
    [
      "PHQ9",
      "nl",
      (w) => w.items[8],
      "De gedachte dat u beter dood zou kunnen zijn of de gedachte uzelf op een bepaalde manier pijn te doen",
    ],
    ["GAD7", "nl", (w) => w.anchors.all[0], "Helemaal niet"],
    [
      "GAD7",
      "nl",
      (w) => w.items[1],
      "Niet kunnen stoppen met u zorgen maken of dit niet kunnen beteugelen",
    ],
    // Pfizer "Korean for Korea": headers printed over three or four lines.
    ["PHQ9", "ko", (w) => w.anchors.all[2], "7 일 이상 방해 받았다"],
    [
      "PHQ9",
      "ko",
      (w) => w.items[8],
      "자신이 죽는 것이 더 낫다고 생각하거나 어떤 식으로든 자신을 해칠 것이라고 생각함",
    ],
    ["GAD7", "ko", (w) => w.anchors.all[2], "2 주 중 절반 이상 방해 받았다"],
    [
      "GAD7",
      "ko",
      (w) => w.stems.period,
      "지난 2 주 동안 당신은 다음의 문제들로 인해서 얼마나 자주 방해를 받았습니까?",
    ],
    // Pfizer "Portuguese for Brazil", with its own spelling.
    [
      "PHQ9",
      "pt-BR",
      (w) => w.stems.period,
      "Durante as últimas 2 semanas, com que freqüência você foi incomodado/a por qualquer um dos problemas abaixo?",
    ],
    [
      "PHQ9",
      "pt-BR",
      (w) => w.items[8],
      "Pensar em se ferir de alguma maneira ou que seria melhor estar morto/a",
    ],
    ["GAD7", "pt-BR", (w) => w.anchors.all[3], "Quase todos os dias"],
    // PRU Dutch WHO-5 (1999) and the Korean WHO-5 (Kim et al. 2010).
    ["WHO5", "nl", (w) => w.anchors.all[5], "Constant"],
    ["WHO5", "nl", (w) => w.items[2], "Ik voelde me actief en doelbewust"],
    ["WHO5", "ko", (w) => w.anchors.all[0], "전혀 그렇지 않다"],
    [
      "WHO5",
      "ko",
      (w) => w.items[3],
      "나는 자고 일어나면 상쾌하고 푹 쉬었다는 느낌이 든다",
    ],
    // SCI-PL (Bidzan-Wiącek et al. 2026), its "45-60 min" kept.
    ["SCI", "pl", (w) => w.anchors.duration[1], "45-60 min"],
    ["SCI", "pl", (w) => w.anchors.impact[2], "Lekko"],
  ];

  it.each(
    PUBLISHED.map(([id, locale, read, text]) => ({ id, locale, read, text })),
  )("$id / $locale: $text", ({ id, locale, read, text }) => {
    const wording = WORDING[id][locale];
    expect(wording.validated).toBe(true);
    expect(read(wording)).toBe(text);
  });

  it("keeps the German PHQ-9 follow-up question in the published formal address", () => {
    const title = WORDING.PHQ9.de.functional?.title ?? "";
    expect(title).toMatch(/^Wenn eines oder mehrere der bisher/);
    expect(title).not.toMatch(/\b(?:du|dich|dir|dein\w*)\b/i);
  });

  it("names which cells carry HealthLog's own translation", () => {
    const unvalidated = Object.entries(WORDING).flatMap(([id, byLocale]) =>
      Object.entries(byLocale)
        .filter(([, w]) => !w.validated)
        .map(([locale]) => `${id}.${locale}`),
    );
    expect(unvalidated.sort()).toEqual(
      [
        "SCI.de",
        "SCI.es",
        "SCI.fr",
        "SCI.it",
        "SCI.ko",
        "SCI.nl",
        "SCI.pt-BR",
        "WHO5.pt-BR",
      ].sort(),
    );
    expect(isValidatedWording("SCI", "de")).toBe(false);
    expect(isValidatedWording("PHQ9", "ko")).toBe(true);
  });
});
