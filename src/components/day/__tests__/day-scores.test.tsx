import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import enMessages from "../../../../messages/en.json";
import deMessages from "../../../../messages/de.json";

import {
  DAY_SCORE_HREF,
  DAY_SCORE_KEYS,
  type DayScore,
} from "@/lib/day/contract";

import { cycleRunningLine } from "../day-cycle-line";

/**
 * The day's scores: a tile for each score the day holds and nothing for the
 * rest, every tile opening its score's own page, worded from the bundle with
 * no raw code and no dot separator.
 */

async function render(scores: DayScore[], locale: "en" | "de" = "en") {
  const { I18nProvider } = await import("@/lib/i18n/context");
  const { DayScores } = await import("../day-scores");
  return renderToStaticMarkup(
    <I18nProvider
      initialLocale={locale}
      initialMessages={locale === "en" ? enMessages : deMessages}
    >
      <DayScores scores={scores} />
    </I18nProvider>,
  );
}

const READINESS: DayScore = {
  key: "readiness",
  value: 71,
  max: 100,
  source: "COMPUTED",
  band: { lo: 60, hi: 80, n: 21 },
};
const DEVICE_STRAIN: DayScore = {
  key: "strain",
  value: 12.4,
  max: 21,
  source: "WHOOP",
  band: null,
};

describe("<DayScores>", () => {
  it("renders nothing for a day without scores", async () => {
    expect(await render([])).toBe("");
  });

  it("shows only the scores the day holds, each linking to its page", async () => {
    const html = await render([READINESS, DEVICE_STRAIN]);
    expect(html).toContain('data-slot="day-scores"');
    expect(html).toContain(">Scores<");
    expect(html.match(/data-slot="day-score"/g)).toHaveLength(2);
    expect(html).toContain(`href="${DAY_SCORE_HREF.readiness}"`);
    expect(html).toContain(`href="${DAY_SCORE_HREF.strain}"`);
    for (const key of DAY_SCORE_KEYS) {
      if (key === "readiness" || key === "strain") continue;
      expect(html).not.toContain(`data-score="${key}"`);
    }
    expect(html).toContain("Readiness");
    expect(html).toContain("Strain");
  });

  it("states a device scale, draws the usual range and never prints a code or a dot", async () => {
    const html = await render([READINESS, DEVICE_STRAIN]);
    expect(html).toContain("12.4");
    expect(html).toContain("of 21");
    // The 0 to 100 scores read as a bare number, as on their pages.
    expect(html).not.toContain("of 100");
    expect(html.match(/data-slot="day-number-line"/g)).toHaveLength(1);
    expect(html).toContain("Usually 60 to 80");
    expect(html).not.toContain(" · ");
    expect(html).not.toContain("—");
    for (const raw of ["COMPUTED", "WHOOP", "readiness<", "strain<"]) {
      expect(html).not.toContain(raw);
    }
  });

  it("names every score from the bundle in each locale", async () => {
    const all: DayScore[] = DAY_SCORE_KEYS.map((key) => ({
      key,
      value: 50,
      max: 100,
      source: "COMPUTED",
      band: null,
    }));
    for (const locale of ["en", "de"] as const) {
      const html = await render(all, locale);
      expect(html.match(/data-slot="day-score"/g)).toHaveLength(5);
      expect(html).not.toMatch(/insights\.|day\.groups/);
    }
  });
});

describe("cycle line", () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    const path = key.split(".");
    let node: unknown = enMessages;
    for (const part of path) node = (node as Record<string, unknown>)[part];
    let text = String(node);
    for (const [k, v] of Object.entries(params ?? {})) {
      text = text.replace(`{${k}}`, String(v));
    }
    return text;
  };

  it("words the cycle day and phase without a separator dot", () => {
    const line = cycleRunningLine(
      { kind: "cyclePhase", sub: "FOLLICULAR", dayIndex: 12 },
      t,
    );
    expect(line).toBe("Cycle day 12, follicular phase");
    expect(line).not.toContain("·");
  });

  it("falls back to the cycle day without a phase", () => {
    expect(
      cycleRunningLine({ kind: "cyclePhase", sub: null, dayIndex: 3 }, t),
    ).toBe("Cycle day 3");
  });

  it("leaves every other running item alone", () => {
    expect(
      cycleRunningLine({ kind: "illness", sub: null, dayIndex: 3 }, t),
    ).toBeNull();
    expect(
      cycleRunningLine(
        { kind: "cyclePhase", sub: "LUTEAL", dayIndex: null },
        t,
      ),
    ).toBeNull();
  });
});
