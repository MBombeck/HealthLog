/**
 * The blood-pressure time-of-day card in a real browser (#1331): the server's
 * numbers rendered as given, the narrowing control as a keyboard radiogroup,
 * and the narrowed part in the address bar, so it survives a reload and a
 * shared link while the whole day keeps a bare URL.
 */
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { stubFetch } from "../../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../../tests/browser/render";
import {
  currentSearch,
  recordHistory,
  setSearch,
} from "../../../../../tests/browser/url";
import { BpTimeOfDayCard } from "../bp-time-of-day-card";
import { useBpTimeOfDayState } from "../use-bp-time-of-day-state";

const SUMMARY = {
  days: 90,
  from: "2026-08-05T22:00:00.000Z",
  to: "2026-11-03T22:59:59.999Z",
  timeZone: "Europe/Berlin",
  minReadings: 3,
  readingCount: 15,
  parts: [
    {
      part: "morning",
      startHour: 4,
      endHour: 12,
      readingCount: 6,
      systolic: 140,
      diastolic: 90,
      pulseReadingCount: 6,
      pulse: 72,
    },
    {
      part: "midday",
      startHour: 12,
      endHour: 18,
      readingCount: 2,
      systolic: null,
      diastolic: null,
      pulseReadingCount: 0,
      pulse: null,
    },
    {
      part: "evening",
      startHour: 18,
      endHour: 4,
      readingCount: 7,
      systolic: 131,
      diastolic: 82,
      pulseReadingCount: 6,
      pulse: 66,
    },
  ],
  morningEveningDifference: { systolic: 9, diastolic: 8 },
};

/** The page's wiring: the state hook feeding the card, the chart's part shown. */
function Probe() {
  const state = useBpTimeOfDayState();
  return (
    <>
      <p data-testid="chart-part">{state.partOfDay ?? "all"}</p>
      <BpTimeOfDayCard
        days={state.days}
        chartPart={state.partOfDay ?? "all"}
        onChartPartChange={state.setChartPart}
      />
    </>
  );
}

function network() {
  return stubFetch()
    .on("GET", "/api/dashboard/widgets", {
      data: { chartOverlayPrefs: { bp: { rangePoints: 90 } } },
    })
    .on("GET", "/api/measurements/blood-pressure/time-of-day", {
      data: SUMMARY,
    });
}

async function mount(search = "") {
  setSearch(search);
  const net = network();
  const history = recordHistory();
  const { screen } = await renderWithApp(<Probe />);
  const radio = (name: string) => screen.getByRole("radio", { name });
  return { screen, net, history, radio };
}

describe("BpTimeOfDayCard", () => {
  it("renders the server's figures for the chart's range", async () => {
    const { screen, net } = await mount();
    await expect.element(screen.getByText("140/90")).toBeVisible();
    await expect.element(screen.getByText("131/82")).toBeVisible();
    await expect.element(screen.getByText("Too few readings")).toBeVisible();
    await expect.element(screen.getByText("Pulse 72 bpm")).toBeVisible();
    await expect
      .element(screen.getByText("Morning minus evening: +9/+8 mmHg."))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Morning 04:00–11:59, midday 12:00–17:59, evening 18:00–03:59, in your time zone.",
        ),
      )
      .toBeVisible();
    // The chart's persisted 90-day tab decides the window.
    await expect
      .poll(() =>
        net
          .calls("GET", "/api/measurements/blood-pressure/time-of-day")
          .map((r) => r.path),
      )
      .toContain("/api/measurements/blood-pressure/time-of-day?days=90");
  });

  it("opens on the part the address names", async () => {
    const { screen, radio } = await mount("?partOfDay=evening");
    await expect
      .element(radio("Evening"))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(screen.getByTestId("chart-part"))
      .toHaveTextContent("evening");
  });

  it("treats an unknown part as the whole day", async () => {
    const { radio } = await mount("?partOfDay=night");
    await expect
      .element(radio("All day"))
      .toHaveAttribute("aria-checked", "true");
  });

  it("narrows the chart into the URL as a new history entry and back to a bare URL", async () => {
    const { screen, radio, history } = await mount();
    await expect
      .element(radio("All day"))
      .toHaveAttribute("aria-checked", "true");
    await radio("Morning").click();
    await expect.poll(currentSearch).toBe("?partOfDay=morning");
    expect(history.pushes()).toContain("?partOfDay=morning");
    await expect
      .element(screen.getByTestId("chart-part"))
      .toHaveTextContent("morning");
    await radio("All day").click();
    await expect.poll(currentSearch).toBe("");
    await expect
      .element(screen.getByTestId("chart-part"))
      .toHaveTextContent("all");
  });

  it("moves through the parts with the arrow keys", async () => {
    const { radio } = await mount("?partOfDay=morning");
    await expect
      .element(radio("Morning"))
      .toHaveAttribute("aria-checked", "true");
    (radio("Morning").element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(currentSearch).toBe("?partOfDay=midday");
    await userEvent.keyboard("{ArrowRight}");
    await expect.poll(currentSearch).toBe("?partOfDay=evening");
  });

  it("names the control for assistive technology", async () => {
    const { screen } = await mount();
    await expect
      .element(screen.getByRole("radiogroup", { name: "Show in the chart" }))
      .toBeVisible();
  });
});
