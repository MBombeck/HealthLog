/**
 * The person's own symptoms on the timeline page (#981), in a real browser:
 * the page as mounted, its reads answered by a stubbed network.
 *
 *   - A stored choice that names a symptom reaches the request, and the
 *     symptom is drawn as a value line on the fixed 0 to 10 scale, a point
 *     resting on fewer than three days drawn hollow.
 *   - The values menu offers the record's logged symptoms, a hidden one
 *     marked as such; choosing one adds it to the stored list and to the
 *     next request.
 *   - With the illness module off, no symptom is offered or requested.
 *   - A point reads on its own by keyboard: the bucket, the value out of 10
 *     and the days behind it.
 *
 * All data invented.
 */
import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import type { TimelineResponse } from "@/lib/day/contract";

import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { setSearch } from "../../../../tests/browser/url";
import { TimelineView } from "../timeline-view";

const VALUES_KEY = "healthlog.timeline.values";

const HEADACHE = "symptom:sd-headache";
const NAUSEA = "symptom:sd-nausea";

function timeline(values: readonly string[]): TimelineResponse {
  const line = (
    key: string,
    label: string,
    isActive: boolean,
    points: Array<{ t: string; mean: number; count: number }>,
  ) => ({
    key,
    definitionId: key.slice("symptom:".length),
    label,
    icon: null,
    isActive,
    scale: { min: 0 as const, max: 10 as const },
    points,
  });
  const lines = [
    line(HEADACHE, "Headache", true, [
      { t: "2025-10-01", mean: 6.5, count: 4 },
      { t: "2026-01-01", mean: 3, count: 1 },
    ]),
    line(NAUSEA, "Nausea", false, [{ t: "2025-04-01", mean: 2, count: 2 }]),
  ];
  return {
    zoom: "all",
    range: { from: "2024-01-01", to: "2026-06-30", dataFrom: "2024-01-01" },
    bucket: "quarter",
    lanes: [
      {
        key: "illness",
        items: [
          {
            id: "episode-1",
            kind: "episode",
            start: "2025-10-12",
            end: "2025-10-20",
            open: false,
            precision: "DAY",
            startKnown: true,
            label: "Flu",
            sub: null,
            href: null,
            group: null,
          },
        ],
      },
    ],
    standing: [],
    series: [],
    availableSeries: ["WEIGHT"],
    labSeries: [],
    availableLabs: [],
    symptomSeries: lines.filter((l) => values.includes(l.key)),
    availableSymptoms: lines.map(
      ({ key, definitionId, label, icon, isActive }) => ({
        key,
        definitionId,
        label,
        icon,
        isActive,
      }),
    ),
    notable: [],
  };
}

/** The `values` a request named, as a list. */
function valuesOf(path: string): string[] {
  const raw = new URL(path, window.location.origin).searchParams.get("values");
  return raw ? raw.split(",") : [];
}

function stubTimeline(): FetchStub {
  return stubFetch()
    .on("GET", "/api/timeline", (request) => ({
      data: timeline(valuesOf(request.path)),
    }))
    .on("GET", "/api/timeline/readiness", {
      data: { verdict: "carries", since: "2024-01-01", lanes: [] },
    })
    .on("GET", "/api/life-events", { data: { events: [] } });
}

async function mount(
  stored: string[] | null,
  modules: Record<string, boolean> = { timeline: true, illness: true },
) {
  if (stored) window.localStorage.setItem(VALUES_KEY, JSON.stringify(stored));
  setSearch("?zoom=all");
  const net = stubTimeline();
  const { screen } = await renderWithApp(<TimelineView />, {
    user: { timezone: "Europe/Berlin", modules },
  });
  return { net, screen };
}

function lastTimelineValues(net: FetchStub): string[] {
  const calls = net.calls("GET", "/api/timeline");
  return valuesOf(calls[calls.length - 1]?.path ?? "");
}

describe("symptom lines on the timeline page", () => {
  it("asks for a stored symptom and draws it as a value line on the fixed scale", async () => {
    await page.viewport(1280, 900);
    const { net } = await mount([HEADACHE]);
    const points = () =>
      document.querySelectorAll<SVGCircleElement>(
        `[data-series="${HEADACHE}"] [data-slot="timeline-series-point"]`,
      );
    await expect.poll(() => points().length).toBe(2);
    expect(lastTimelineValues(net)).toEqual([HEADACHE]);
    // The mean of four days is a full point, the one of a single day hollow.
    const [autumn, winter] = [...points()];
    expect(autumn.dataset.count).toBe("4");
    expect(autumn.dataset.thin).toBe("false");
    expect(winter.dataset.thin).toBe("true");
    // Fixed scale: 6.5 sits higher than 3, and both well inside the row,
    // where a self-fitted row would push the two towards its edges.
    const y = (el: SVGCircleElement) => Number(el.getAttribute("cy"));
    expect(y(autumn)).toBeLessThan(y(winter));
    const span = y(winter) - y(autumn);
    // 3.5 of 11 scale units across a 44 px row: about 14 px.
    expect(span).toBeGreaterThan(10);
    expect(span).toBeLessThan(20);
    // The latest value reads out of 10, and the legend says what a point is.
    expect(
      document.querySelector(`g[data-series="${HEADACHE}"]`)?.textContent,
    ).toContain("3/10");
    expect(
      document.querySelector('[data-slot="timeline-legend-symptom"]'),
    ).not.toBeNull();
  });

  it("reads a point on its own with the days behind it", async () => {
    await page.viewport(1280, 900);
    await mount([HEADACHE]);
    const target = (t: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-slot="timeline-point-target"][data-series="${HEADACHE}"][data-t="${t}"]`,
      );
    await expect.poll(() => target("2025-10-01") !== null).toBe(true);
    const label = target("2025-10-01")!.getAttribute("aria-label") ?? "";
    expect(label).toContain("Headache");
    expect(label).toContain("6.5/10");
    expect(label).toContain("mean of 4 days");
    expect(target("2026-01-01")!.getAttribute("aria-label")).toContain(
      "on 1 day",
    );
  });

  it("offers the record's symptoms, marks a hidden one, and a choice persists", async () => {
    await page.viewport(1280, 900);
    const { net, screen } = await mount(["WEIGHT"]);
    const trigger = screen.getByRole("button", { name: /Values \(1\)/ });
    await expect.element(trigger).toBeVisible();
    await trigger.click();
    await expect.element(screen.getByText("Symptoms")).toBeVisible();
    await expect
      .element(screen.getByRole("menuitemcheckbox", { name: /Nausea.*hidden/ }))
      .toBeVisible();
    const headache = screen.getByRole("menuitemcheckbox", {
      name: "Headache",
    });
    await expect.element(headache).toHaveAttribute("aria-checked", "false");
    await headache.click();
    await expect.element(headache).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(window.localStorage.getItem(VALUES_KEY)!)).toEqual([
      "WEIGHT",
      HEADACHE,
    ]);
    await expect
      .poll(() => lastTimelineValues(net))
      .toEqual(["WEIGHT", HEADACHE]);
  });

  it("neither offers nor asks for a symptom with the illness module off", async () => {
    await page.viewport(1280, 900);
    const { net, screen } = await mount(["WEIGHT", HEADACHE], {
      timeline: true,
      illness: false,
    });
    const trigger = screen.getByRole("button", { name: /Values \(1\)/ });
    await expect.element(trigger).toBeVisible();
    expect(lastTimelineValues(net)).toEqual(["WEIGHT"]);
    await trigger.click();
    await expect
      .element(screen.getByRole("menuitemcheckbox", { name: "Weight" }))
      .toBeVisible();
    expect(
      document.querySelector('[data-slot="timeline-values-symptoms"]'),
    ).toBe(null);
  });

  it("fits a phone and names the symptom's means in the chronicle", async () => {
    await page.viewport(390, 844);
    const { screen } = await mount([HEADACHE]);
    await expect
      .element(screen.getByRole("button", { name: "Values (1)" }))
      .toBeVisible();
    await expect
      .poll(
        () =>
          document.querySelectorAll(
            `[data-slot="timeline-mean-part"][data-series="${HEADACHE}"]`,
          ).length,
      )
      .toBeGreaterThan(0);
    const root = document.documentElement;
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  });
});
