import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity, Heart, Smile, Percent, TrendingUp } from "lucide-react";

import { TrendCard } from "../trend-card";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.4.25 W20a — regression coverage for the dashboard top-tile polish.
 *
 * Marc-direktive 2026-05-14 named three issues with the 5-tile top row:
 *
 *   1. Headings wrapped to two lines at narrow viewports (e.g. "Blood
 *      Pressure" on Pixel 5 / 393 px / 2-col grid). Locked the heading
 *      row to a deterministic `h-5` with `whitespace-nowrap` so even an
 *      unexpectedly long string never breaks the baseline of the value
 *      row below.
 *   2. Trend arrow rendered as a wrapping flex child after the unit —
 *      sometimes wrapped to its own line, sometimes missing entirely
 *      when slope30 was null. Now sits in a fixed `h-4 w-4` slot with
 *      `items-baseline` alignment; when there's no slope yet a muted
 *      "—" placeholder keeps the slot reserved.
 *   3. Value rows of two adjacent tiles (e.g. "Weight 80 kg" vs.
 *      "Blood Pressure 122 mmHg") landed at different y-coordinates
 *      because heading-row height was variable. The fixed heading
 *      height plus `text-3xl leading-none` on the value forces every
 *      tile in the strip to share the same baseline.
 *
 * These tests pin the load-bearing class names so a future refactor
 * that drops `h-5` / `items-baseline` / `whitespace-nowrap` triggers a
 * red CI before it reaches the dashboard.
 */

const RISING = { slope: 0.5, direction: "up" as const, confidence: 0.8 };

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<TrendCard> W20a baseline alignment", () => {
  it("locks the heading row to a deterministic height", () => {
    const html = render(
      <TrendCard
        label="Weight"
        latest={80}
        unit="kg"
        avg7={80}
        avg30={80}
        slope30={RISING}
        icon={Activity}
      />,
    );

    // h-5 is the load-bearing class — keeps the value row below at the
    // same y-coordinate regardless of the label string's actual width.
    expect(html).toContain("h-5");
    expect(html).toContain('data-slot="trend-card-label"');
  });

  it("forbids wrapping on the heading row even with a long label", () => {
    const html = render(
      <TrendCard
        // Stress test — the live tile uses dashboard.*Short keys but
        // we want the layout to survive an i18n regression that wires
        // a long form by accident.
        label="A really long blood pressure metric name"
        latest={122}
        unit="mmHg"
        avg7={120}
        avg30={119}
        slope30={RISING}
        icon={Heart}
      />,
    );

    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("truncate");
  });

  it("renders the value row with baseline alignment", () => {
    const html = render(
      <TrendCard
        label="Weight"
        latest={80}
        unit="kg"
        avg7={80}
        avg30={80}
        slope30={RISING}
        icon={Activity}
      />,
    );

    expect(html).toContain('data-slot="trend-card-value-row"');
    expect(html).toContain("items-baseline");
    // Headline font-size + zero line-height — across-tile baseline.
    expect(html).toContain("text-3xl");
    expect(html).toContain("leading-none");
  });

  it("places the trend arrow inline at the end of the value row", () => {
    const html = render(
      <TrendCard
        label="Weight"
        latest={80}
        unit="kg"
        avg7={80}
        avg30={80}
        slope30={RISING}
        icon={Activity}
        directionSentiment="up-bad"
      />,
    );

    expect(html).toContain('data-slot="trend-card-arrow"');
    // The arrow slot sits inside the value row, so the value-row data
    // slot precedes it in the rendered HTML.
    const valueRowIdx = html.indexOf('data-slot="trend-card-value-row"');
    const arrowIdx = html.indexOf('data-slot="trend-card-arrow"');
    expect(valueRowIdx).toBeGreaterThan(-1);
    expect(arrowIdx).toBeGreaterThan(valueRowIdx);
  });

  it("keeps the arrow slot reserved when slope is missing", () => {
    const html = render(
      <TrendCard
        label="Pulse"
        latest={68}
        unit="bpm"
        avg7={null}
        avg30={null}
        slope30={null}
        icon={TrendingUp}
      />,
    );

    // Slot still rendered (deterministic width across the strip).
    expect(html).toContain('data-slot="trend-card-arrow"');
    // Placeholder dash + muted opacity so the slot reads as "no data".
    expect(html).toMatch(/opacity-30[^"]*"[^>]*>—/);
  });

  it("renders consistent layout across the five top-row tile metrics", () => {
    // Snapshot-style smoke check — every tile in the top row should
    // share the same heading-row height + value-row baseline class
    // contract so the strip aligns visually on Pixel 5.
    const tiles = [
      { label: "Weight", value: 80, unit: "kg", icon: Activity },
      { label: "BP (Sys)", value: 122, unit: "mmHg", icon: Heart },
      { label: "Pulse", value: 68, unit: "bpm", icon: TrendingUp },
      { label: "Body Fat", value: 18.5, unit: "%", icon: Percent },
      { label: "Mood", value: 4, unit: "/ 5", icon: Smile },
    ];

    for (const tile of tiles) {
      const html = render(
        <TrendCard
          label={tile.label}
          latest={tile.value}
          unit={tile.unit}
          avg7={tile.value}
          avg30={tile.value}
          slope30={RISING}
          icon={tile.icon}
        />,
      );

      // Same heading-row height contract — `h-5` + `whitespace-nowrap`.
      expect(html).toContain("h-5");
      expect(html).toContain("whitespace-nowrap");
      // Same value-row baseline contract — `items-baseline` + `text-3xl`
      // + `leading-none`. Identical font geometry across all five tiles
      // means the digits land at the same y-coordinate inside the grid.
      expect(html).toContain("items-baseline");
      expect(html).toContain("text-3xl");
      expect(html).toContain("leading-none");
      // Same arrow slot contract — fixed width, end-anchored via `ml-auto`.
      expect(html).toContain('data-slot="trend-card-arrow"');
      expect(html).toContain("ml-auto");
    }
  });
});

describe("dashboard.*Short keys exist across all six locales", () => {
  // Defensive integrity check — the i18n-locale-integrity test guards
  // top-level parity across messages/*.json, but a hand-rolled list of
  // the exact short keys the dashboard tile strip pulls makes a missing
  // key fail with a precise diagnostic rather than a generic "key X is
  // missing in locale Y" surface.
  const REQUIRED_KEYS = [
    "weightShort",
    "bloodPressureSysShort",
    "bloodPressureDiaShort",
    "pulseShort",
    "bodyFatShort",
    "moodShort",
    "sleepShort",
    "stepsShort",
    "vo2MaxShort",
    "bpInTargetShort",
  ];

  // Resolved at test time so the assertion runs against the current
  // bundle, not a stale cached snapshot.
  const locales = ["en", "de", "fr", "es", "it", "pl"] as const;

  it.each(locales)("%s carries every dashboard.*Short key", async (locale) => {
    const messages = (await import(`../../../../messages/${locale}.json`))
      .default;
    const dashboard = messages.dashboard ?? {};
    for (const key of REQUIRED_KEYS) {
      expect(dashboard[key], `dashboard.${key} missing in ${locale}.json`)
        .toBeTypeOf("string");
      expect(
        (dashboard[key] as string).length,
        `dashboard.${key} empty in ${locale}.json`,
      ).toBeGreaterThan(0);
    }
  });
});
