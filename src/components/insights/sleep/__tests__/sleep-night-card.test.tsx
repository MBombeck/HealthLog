import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { SleepNightPayload } from "@/hooks/use-sleep-night";

/**
 * The sleep page's night timeline (#1419). The chart itself is Recharts and
 * renders client-side only; these pin what the card decides around it: a
 * measured night gets the chart, a synthesised one (stage totals without
 * onsets) gets a note instead of an invented order, a day without a night
 * says so, and a failed read is never shown as an absent night.
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
    function Chart(props: { ariaLabel: string }) {
      return <div data-slot="hypnogram-chart" aria-label={props.ariaLabel} />;
    },
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
});
