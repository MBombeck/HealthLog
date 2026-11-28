/**
 * The asks card's one-line rule. Every title and meta line the server words
 * for an ask (`daily.ask.*`, `buildAdminAsk`, `doseMeta`) keeps the shared
 * budget (`ASK_TEXT_BUDGET`, also the iPhone app's: at most 14 characters
 * for a title, 16 for a meta, in every language) and fits one line of the
 * card on the narrowest supported phone (360 css px, with a 15 px scrollbar
 * taking width as in a desktop browser), beside the icon and the widest
 * button pair that language can put in the card.
 *
 * The text column is what the row leaves after its padding, the icon, the
 * two gaps and the button pair (`today-asks.tsx`, `ask-actions.tsx`); the
 * pair is two equal buttons as wide as the widest label any ask can carry in
 * that language, at 12 px medium, plus the compact size's padding. Text is
 * measured with Inter's own advance widths (`fixtures/inter-advances.json`,
 * per weight; a character missing there counts a full em, so Korean, set in
 * the system face, is overestimated rather than under). Times are the
 * widest a reader can be shown: every hour of the day, in the language's
 * own clock and with 12 and 24 hours forced.
 *
 * Names the person typed (a medication, a doctor, a check-up, a plan) are
 * the one thing the card may cut, with an ellipsis; they are not budgeted.
 * The real layout is checked in the browser by `e2e/today-asks.spec.ts`.
 */
import { describe, expect, it } from "vitest";

import advances from "./fixtures/inter-advances.json";
import { readSource } from "@/__tests__/helpers/source-files";
import {
  ASK_TEXT_BUDGET,
  askTextLength,
  buildAdminAsk,
  doseMeta,
} from "@/lib/daily/asks";
import { makeFormatters, type TimeFormatPreference } from "@/lib/format-locale";
import { locales, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";

/** The narrowest phone less the page's 16 px gutters and a scrollbar. */
const CARD = ASK_TEXT_BUDGET.phoneCssPx - 2 * 16 - 15;
/**
 * Card border, row padding (`px-3`), icon (`size-4`), two `gap-x-1.5`, and
 * 2 px of headroom for a rasteriser that sets Inter a hair wider than the
 * advances say (Linux CI does).
 */
const ROW_CHROME = 2 + 2 * 12 + 16 + 2 * 6 + 2;
/** The compact button's padding (`px-1.5`) and the pair's `gap-2`. */
const BUTTON_PAD = 2 * 6;
const PAIR_GAP = 8;

type Weight = "400" | "500" | "600";
const TABLE = advances.weights as Record<Weight, Record<string, number>>;

function width(text: string, px: number, weight: Weight): number {
  let em = 0;
  for (const ch of text) em += TABLE[weight][ch] ?? 1;
  return em * px;
}

/** Every label key an ask can put on a button, read from the policy. */
const ASKS_SOURCE = readSource("src/lib/daily/asks.ts", [
  "PRIMARY_BY_KIND",
  "buildAdminAsk",
]);
const LABEL_KEYS = [
  ...new Set(
    [...ASKS_SOURCE.matchAll(/labelKey: "([^"]+)"/g)].map((m) => m[1]),
  ),
];

/** Every time a reader of this language can see, over the day. */
function allTimes(locale: Locale): string[] {
  const out = new Set<string>();
  for (const pref of ["AUTO", "H12", "H24"] as TimeFormatPreference[]) {
    const time = makeFormatters(locale, "UTC", pref, "AUTO").time;
    for (let hour = 0; hour < 24; hour++) {
      out.add(time(new Date(Date.UTC(2026, 10, 27, hour, 38))));
    }
  }
  return [...out];
}

function column(locale: Locale): { px: number; widestLabel: string } {
  const { t } = getServerTranslator(locale);
  const labels = LABEL_KEYS.map((key) => t(key));
  const widestLabel = labels.reduce((a, b) =>
    width(b, 12, "500") > width(a, 12, "500") ? b : a,
  );
  const button = width(widestLabel, 12, "500") + BUTTON_PAD;
  return { px: CARD - ROW_CHROME - (2 * button + PAIR_GAP), widestLabel };
}

describe(`asks text budget at ${ASK_TEXT_BUDGET.phoneCssPx} px`, () => {
  it("reads the button labels from the policy", () => {
    expect(LABEL_KEYS).toEqual(
      expect.arrayContaining([
        "daily.action.logDose",
        "daily.action.later",
        "daily.action.setUp",
        "admin.pushRelay.question.yes",
      ]),
    );
  });

  it("every button label fits the compact face in every language", () => {
    const over: string[] = [];
    for (const locale of locales) {
      const { t } = getServerTranslator(locale);
      for (const key of LABEL_KEYS) {
        const w = width(t(key), 12, "500");
        if (w > ASK_TEXT_BUDGET.labelPx) {
          over.push(`${locale} ${key} "${t(key)}" ${w.toFixed(1)} px`);
        }
      }
    }
    expect(over).toEqual([]);
  });

  it("the width table matches Inter (a known label)", () => {
    // "Einnehmen" at 12 px medium measured 63.9 px in Chromium.
    expect(width("Einnehmen", 12, "500")).toBeCloseTo(63.9, 0);
  });

  for (const locale of locales) {
    it(`${locale}: every title and meta line fits one line`, () => {
      const { t } = getServerTranslator(locale);
      const { px, widestLabel } = column(locale);
      const times = allTimes(locale);
      const relay = buildAdminAsk("push_relay", t);
      const setup = buildAdminAsk("server_setup", t);
      const metas: Record<string, string> = {
        overdueNow: t("daily.ask.overdueNow"),
        dueNow: t("daily.ask.dueNow"),
        checkupDue: t("daily.ask.checkupDue"),
        visitToday: t("daily.ask.visitToday"),
        visitTomorrow: t("daily.ask.visitTomorrow"),
        signedOut: t("daily.ask.signedOut"),
        planReview: t("daily.ask.planReview"),
        setup: setup.body ?? "",
        relay: relay.body ?? "",
      };
      // A dose's meta as the server sends it, at every time of day and
      // hour cycle: with the time when it fits, else the state alone.
      for (const time of times) {
        metas[`overdue ${time}`] = doseMeta(true, time, t);
        metas[`due ${time}`] = doseMeta(false, time, t);
      }
      // The usual clock keeps its time: the fallback is for the rare reader
      // who forced the other hour cycle, not the language's own.
      const own = makeFormatters(locale, "UTC", "AUTO", "AUTO").time(
        new Date(Date.UTC(2026, 10, 27, 7, 0)),
      );
      // (Russian says "overdue" without the time: with it, the line ran
      // past its column in the CI browser.)
      if (t("daily.ask.overdue", { time: "\u0001" }).includes("\u0001")) {
        expect(doseMeta(true, own, t)).toContain(own);
      }
      const titles: Record<string, string> = {
        medication: t("daily.ask.medication"),
        planFallback: t("daily.ask.planFallback"),
        setup: setup.title,
        relay: relay.title,
      };
      const over: string[] = [];
      for (const [key, text] of Object.entries(metas)) {
        const w = width(text, 12, "500");
        if (w > px) over.push(`meta ${key} "${text}" ${w.toFixed(1)} px`);
        if (askTextLength(text) > ASK_TEXT_BUDGET.metaChars) {
          over.push(`meta ${key} "${text}" ${askTextLength(text)} chars`);
        }
      }
      // No row carries a link: it would need room the line does not have.
      expect([relay.learnMore, setup.learnMore]).toEqual([null, null]);
      for (const [key, text] of Object.entries(titles)) {
        const w = width(text, 14, "600");
        if (w > px) over.push(`title ${key} "${text}" ${w.toFixed(1)} px`);
        if (askTextLength(text) > ASK_TEXT_BUDGET.titleChars) {
          over.push(`title ${key} "${text}" ${askTextLength(text)} chars`);
        }
      }
      expect(
        over,
        `${locale}: column ${px.toFixed(1)} px (widest button "${widestLabel}")`,
      ).toEqual([]);
    });
  }
});
