import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { SleepNightPayload } from "@/hooks/use-sleep-night";

/**
 * The sleep page's night timeline (#1419). The chart itself is Recharts and
 * renders client-side only; these pin what the card decides around it: a
 * measured night gets the chart, a synthesised one (stage totals without
 * onsets) gets a note instead of an invented order, a day without a night
 * says so, and a failed read is never shown as an absent night. The night
 * metrics over the timeline: a toggle per series, the chosen ones handed to
 * the chart, single night values as numbers, and every metric in words for
 * a screen reader.
 */

const reads: Record<string, { data?: SleepNightPayload; isError?: boolean }> =
  {};

vi.mock("@/hooks/use-sleep-night", () => ({
  useSleepNight: (date: string | undefined) => {
    const r = reads[date ?? "latest"] ?? {};
    return {
      data: r.data,
      isError: r.isError ?? false,
      error: r.isError ? new Error("boom") : null,
      refetch: () => {},
    };
  },
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function Chart(props: {
      ariaLabel: string;
      overlay?: { lines: Array<{ key: string; color: string }> };
    }) {
      return (
        <div
          data-slot="hypnogram-chart"
          aria-label={props.ariaLabel}
          data-lines={
            props.overlay?.lines.map((l) => `${l.key}:${l.color}`).join(" ") ??
            ""
          }
        />
      );
    },
}));

const overlayPrefs: { overlayLines?: string[] } = {};
vi.mock("@/hooks/use-chart-overlay-prefs", () => ({
  useChartOverlayPrefs: () => ({
    prefs: {
      showTrendIndicator: false,
      showTrendArrow: false,
      showTargetRange: false,
      comparisonBaseline: "none",
      ...overlayPrefs,
    },
    setPrefs: () => {},
    isSaving: false,
  }),
}));

vi.mock("@/hooks/use-unit-display", () => ({
  useUnitDisplay: () => ({
    toDisplay: (_type: string, v: number) => v,
    decimalsFor: () => 1,
    unitFor: (type: string) =>
      ({ PULSE: "bpm", HRV_RMSSD: "ms", RESPIRATORY_RATE: "br/min" })[type] ??
      "",
  }),
}));

import { SleepNightCard } from "../sleep-night-card";
import en from "../../../../../messages/en.json";

function session(reconstructed: boolean) {
  return {
    night: "2026-06-02",
    source: "APPLE_HEALTH",
    start: "2026-06-01T21:10:00.000Z",
    end: "2026-06-02T04:40:00.000Z",
    asleepMinutes: 412,
    inBedMinutes: null,
    awakeMinutes: 18,
    awakenings: 2,
    reconstructed,
    stages: { CORE: 250, DEEP: 80, REM: 82, AWAKE: 18 },
    segments: [
      {
        stage: "CORE",
        start: "2026-06-01T21:10:00.000Z",
        end: "2026-06-01T23:00:00.000Z",
        minutes: 110,
      },
      {
        stage: "DEEP",
        start: "2026-06-01T23:00:00.000Z",
        end: "2026-06-02T00:20:00.000Z",
        minutes: 80,
      },
    ],
  };
}

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SleepNightCard enabled />
    </I18nProvider>,
  );
}

const OVERLAYS = {
  from: "2026-06-01T20:55:00.000Z",
  to: "2026-06-02T04:55:00.000Z",
  bucketMinutes: 5,
  metrics: [
    {
      kind: "pulse" as const,
      type: "PULSE",
      unit: "bpm",
      source: "APPLE_HEALTH",
      points: [
        { at: "2026-06-01T21:10:00.000Z", value: 61, min: 58, max: 64 },
        { at: "2026-06-01T21:15:00.000Z", value: 55, min: 52, max: 57 },
      ],
      nightValue: null,
      summary: { min: 52, max: 64, avg: 58 },
    },
    {
      kind: "respiration" as const,
      type: "RESPIRATORY_RATE",
      unit: "breaths/min",
      source: "APPLE_HEALTH",
      points: [
        { at: "2026-06-01T22:00:00.000Z", value: 14.2, min: 14.2, max: 14.2 },
        { at: "2026-06-02T01:00:00.000Z", value: 13.1, min: 13.1, max: 13.1 },
      ],
      nightValue: null,
      summary: { min: 13.1, max: 14.2, avg: 13.6 },
    },
    {
      kind: "hrv" as const,
      type: "HRV_RMSSD",
      unit: "ms",
      source: "GARMIN",
      points: [],
      nightValue: 42,
      summary: null,
    },
  ],
};

describe("<SleepNightCard>", () => {
  it("draws the timeline of a measured night", () => {
    reads.latest = {
      data: { night: "2026-06-02", main: session(false), naps: [] },
    };
    const html = render();
    expect(html).toContain('data-slot="hypnogram-chart"');
    expect(html).toContain(en.insights.sleep.hypnogram.title);
    expect(html).not.toContain('data-slot="sleep-hypnogram-estimate-note"');
  });

  it("does not invent an order for a night laid out from totals", () => {
    reads.latest = {
      data: { night: "2026-06-02", main: session(true), naps: [] },
    };
    const html = render();
    expect(html).not.toContain('data-slot="hypnogram-chart"');
    expect(html).toContain(en.insights.sleep.hypnogram.estimateNote);
  });

  it("names neither a timeline nor awakenings for a night of stage totals (#1419)", () => {
    // A daily sleep summary (Garmin) stamps every stage total on the wake
    // instant; the server flags the night and the card shows its total only.
    const totals = {
      ...session(true),
      source: "GARMIN",
      awakenings: 0,
      segments: [
        {
          stage: "CORE",
          start: "2026-06-01T23:40:00.000Z",
          end: "2026-06-02T04:40:00.000Z",
          minutes: 300,
        },
        {
          stage: "DEEP",
          start: "2026-06-02T03:20:00.000Z",
          end: "2026-06-02T04:40:00.000Z",
          minutes: 80,
        },
      ],
    };
    reads.latest = {
      data: { night: "2026-06-02", main: totals, naps: [] },
    };
    const html = render();
    expect(html).not.toContain('data-slot="hypnogram-chart"');
    expect(html).toContain('data-slot="sleep-hypnogram-estimate-note"');
    expect(html).toMatch(
      /data-slot="sleep-hypnogram-summary">6h 52m asleep<\/span>/,
    );
    expect(html).not.toContain("awakening");
  });

  it("says a day carried no night", () => {
    reads.latest = { data: { night: null, main: null, naps: [] } };
    const html = render();
    expect(html).toContain(en.insights.sleep.hypnogram.empty);
  });

  it("shows a failed read as a failure, not as an absent night", () => {
    reads.latest = { isError: true };
    const html = render();
    expect(html).toContain('data-slot="sleep-hypnogram-error"');
    expect(html).not.toContain(en.insights.sleep.hypnogram.empty);
  });

  it("cannot step forward past the latest night", () => {
    reads.latest = {
      data: { night: "2026-06-02", main: session(false), naps: [] },
    };
    const html = render();
    expect(html).toMatch(/data-slot="sleep-hypnogram-next"[^>]*disabled/);
  });

  it("offers a toggle per series and lists a single night value as a number", () => {
    delete overlayPrefs.overlayLines;
    reads.latest = {
      data: {
        night: "2026-06-02",
        main: session(false),
        naps: [],
        overlays: OVERLAYS,
      },
    };
    const html = render();
    expect(html).toContain('data-slot="sleep-hypnogram-overlay-chips"');
    expect(html).toMatch(/aria-pressed="false"[^>]*data-kind="pulse"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-kind="respiration"/);
    // A nightly average is a number under the chart, never a toggle.
    expect(html).not.toMatch(/aria-pressed="[a-z]+"[^>]*data-kind="hrv"/);
    expect(html).toContain('data-slot="sleep-hypnogram-night-values"');
    expect(html).toContain("42 ms");
    // No line until one is chosen.
    expect(html).toContain('data-lines=""');
  });

  it("draws the chosen lines in their slot colours, with the range on the toggle", () => {
    overlayPrefs.overlayLines = ["respiration", "pulse"];
    reads.latest = {
      data: {
        night: "2026-06-02",
        main: session(false),
        naps: [],
        overlays: OVERLAYS,
      },
    };
    const html = render();
    expect(html).toContain(
      'data-lines="respiration:var(--foreground) pulse:var(--chart-5)"',
    );
    expect(html).toMatch(/aria-pressed="true"[^>]*data-kind="pulse"/);
    expect(html).toContain("52 to 64 bpm");
  });

  it("skips a chosen metric the night does not hold", () => {
    overlayPrefs.overlayLines = ["spo2", "pulse"];
    reads.latest = {
      data: {
        night: "2026-06-02",
        main: session(false),
        naps: [],
        overlays: OVERLAYS,
      },
    };
    expect(render()).toContain('data-lines="pulse:var(--foreground)"');
  });

  it("reads every metric of the night to a screen reader", () => {
    delete overlayPrefs.overlayLines;
    reads.latest = {
      data: {
        night: "2026-06-02",
        main: session(false),
        naps: [],
        overlays: OVERLAYS,
      },
    };
    const html = render();
    const summary = html.slice(
      html.indexOf('data-slot="sleep-hypnogram-overlay-summary"'),
    );
    expect(summary).toContain(
      "Pulse over the night: lowest 52 bpm, highest 64 bpm, average 58 bpm",
    );
    expect(summary).toContain("HRV for the night: 42 ms");
  });

  it("shows no overlay on a night of stage totals", () => {
    overlayPrefs.overlayLines = ["pulse"];
    reads.latest = {
      data: {
        night: "2026-06-02",
        main: session(true),
        naps: [],
        overlays: OVERLAYS,
      },
    };
    const html = render();
    expect(html).not.toContain('data-slot="sleep-hypnogram-overlay-chips"');
    expect(html).not.toContain('data-slot="sleep-hypnogram-night-values"');
  });
});
