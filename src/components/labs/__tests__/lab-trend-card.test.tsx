import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

import { LabTrendCard } from "../lab-trend-card";
import type { BiomarkerTrendDto } from "../types";

primeLocales("de", "ko");

const OK: BiomarkerTrendDto = {
  status: "ok",
  n: 4,
  firstAt: "2023-01-10",
  lastAt: "2026-01-10",
  spanDays: 1096,
  slopePerYear: 12.5,
  slopeCi95: [4.25, 20.75],
  pValue: 0.02,
  fittedNow: 130,
  asOf: "2026-10-21",
  horizonYears: 3,
  horizonCapped: true,
  projection: "exits",
  exitDate: "2027-11-02",
  exitBound: "high",
};

function render(
  trend: BiomarkerTrendDto | undefined,
  locale: "en" | "de" | "ko" = "en",
  unit = "mg/dL",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LabTrendCard trend={trend} unit={unit} />
    </I18nProvider>,
  );
}

describe("<LabTrendCard>", () => {
  it("words the server's slope and labels the exit as a projection", () => {
    const html = render(OK);
    expect(html).toContain("Rising by about 13 mg/dL a year across 4 readings");
    expect(html).toContain('data-projection="exits"');
    expect(html).toContain("upper end of your reference range");
    expect(html).toContain("projection, not a forecast");
    expect(html).toContain("4.25 to 20.75 mg/dL");
  });

  it("leaves no gap where a value without a unit has none, in any language", () => {
    const en = render(OK, "en", "1");
    expect(en).toContain("Rising by about 13 a year across 4 readings");
    expect(en).toContain("4.25 to 20.75.");
    const ko = render(OK, "ko", "1");
    expect(ko).toContain("약 13씩");
    expect(ko).not.toMatch(/ 씩/);
    expect(ko).not.toContain("\u0000");
  });

  it("speaks German with du", () => {
    const html = render(OK, "de");
    expect(html).toContain("deines Referenzbereichs");
    expect(html).toContain("Fortschreibung, keine Vorhersage");
  });

  it("draws no projection sentence without a clear trend, and nothing when insufficient", () => {
    const html = render({
      ...OK,
      projection: "no_clear_trend",
      exitDate: null,
      exitBound: null,
    });
    expect(html).toContain('data-projection="no_clear_trend"');
    expect(html).not.toContain("forecast");
    expect(
      render({
        status: "insufficient",
        reason: "too_few_values",
        n: 2,
        spanDays: 40,
      }),
    ).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("words a stale trend as of its newest reading, and a span-bound horizon", () => {
    const stale = render({
      ...OK,
      asOf: "2026-01-10",
      projection: "stale",
      exitDate: null,
      exitBound: null,
    });
    expect(stale).toContain('data-projection="stale"');
    expect(stale).toContain("more than a year ago");
    expect(stale).not.toContain("forecast");
    const beyond = render({
      ...OK,
      horizonYears: 1.5,
      horizonCapped: false,
      projection: "beyond_horizon",
      exitDate: null,
      exitBound: null,
    });
    expect(beyond).toContain("for more than 1.5 years");
    expect(beyond).toContain("the span your readings cover");
  });

  it("does not call a capped three-year horizon the span of the readings", () => {
    for (const locale of ["en", "de"] as const) {
      const capped = render(
        {
          ...OK,
          horizonYears: 3,
          horizonCapped: true,
          projection: "beyond_horizon",
          exitDate: null,
          exitBound: null,
        },
        locale,
      );
      expect(capped).toContain(
        locale === "en" ? "more than 3 years" : "länger als 3 Jahre",
      );
      expect(capped).not.toContain("the span your readings cover");
      expect(capped).not.toContain("so weit reichen deine Werte zurück");
      expect(capped).toContain(
        locale === "en"
          ? "as far ahead as the projection looks"
          : "so weit schaut die Fortschreibung voraus",
      );
    }
  });
});
