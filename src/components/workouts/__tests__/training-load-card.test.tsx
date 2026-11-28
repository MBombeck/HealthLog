import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { primeLocales } from "@/__tests__/helpers/prime-locales";
import type { TrainingLoad } from "@/lib/insights/training-load";

import { TrainingLoadCard } from "../training-load-card";

primeLocales("de");

const OK: TrainingLoad = {
  status: "ok",
  asOf: "2026-10-20",
  ctl: 54.2,
  atl: 61.8,
  tsb: -7.6,
  daysCovered: 30,
  trainingDays: 18,
  recentRatedDays: 30,
  recentDays: 30,
  warmingUp: true,
  series: [],
};

const render = (load: TrainingLoad | undefined, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <TrainingLoadCard trainingLoad={load} />
    </I18nProvider>,
  );

describe("<TrainingLoadCard>", () => {
  it("shows the server's fitness, fatigue and form", () => {
    const html = render(OK);
    expect(html).toContain("Training load");
    expect(html).toMatch(/training-load-fitness[^]*?>54</);
    expect(html).toMatch(/training-load-fatigue[^]*?>62</);
    expect(html).toContain("-8");
    expect(html).toContain("Based on 30 days so far");
    expect(html).not.toContain('data-slot="training-load-coverage"');
  });

  it("says how many recent days were rated when some were not", () => {
    const html = render({ ...OK, recentRatedDays: 25, recentDays: 42 });
    expect(html).toContain('data-slot="training-load-coverage"');
    expect(html).toContain("25 of the last 42 days could be rated");
  });

  it("names the last rated day when it lies behind the series end", () => {
    const series = [
      { day: "2026-10-19", ctl: 54, atl: 61, tsb: -7, rated: false },
      { day: "2026-10-20", ctl: 54, atl: 61, tsb: -7, rated: false },
    ];
    const stale = render({ ...OK, asOf: "2026-09-02", series });
    expect(stale).toContain('data-slot="training-load-as-of"');
    expect(stale).toMatch(/As of 0?9\/0?2|As of 02\/09|As of Sep/);
    const fresh = render({ ...OK, asOf: "2026-10-19", series });
    expect(fresh).not.toContain('data-slot="training-load-as-of"');
  });

  it("signs a positive form and drops the warm-up note once covered", () => {
    const html = render({ ...OK, tsb: 4.4, warmingUp: false }, "de");
    expect(html).toContain("+");
    expect(html).toContain("Trainingslast");
    expect(html).not.toContain("bisher");
  });

  it("renders nothing while insufficient", () => {
    expect(
      render({
        status: "insufficient",
        reason: "too_little_history",
        daysCovered: 12,
        trainingDays: 2,
      }),
    ).toBe("");
    expect(render(undefined)).toBe("");
  });
});
