/**
 * Lab markers on the timeline page (#1299), in a real browser: the page as
 * mounted, its reads answered by a stubbed network.
 *
 *   - A stored choice that names a lab marker reaches the request, and the
 *     marker is drawn as its readings under the value lines.
 *   - The values menu offers the record's markers under their groups;
 *     choosing one adds it to the stored list and to the next request,
 *     unchoosing removes it from both.
 *   - With the labs module off, no marker is offered or requested.
 *   - A reading's point reads on its own by keyboard: day, value, the word
 *     for a reading outside its range, the range and the report.
 *   - At 390 px the page does not scroll sideways, the values menu is an
 *     icon button with a name, and the lab day's row lists the readings.
 *
 * All data invented.
 */
import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { TimelineResponse } from "@/lib/day/contract";

import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { setSearch } from "../../../../tests/browser/url";
import { TimelineView } from "../timeline-view";

const VALUES_KEY = "healthlog.timeline.values";

function timeline(values: readonly string[]): TimelineResponse {
  const ferritin = values.includes("lab:bm-ferritin");
  return {
    zoom: "all",
    range: { from: "2024-01-01", to: "2026-06-30", dataFrom: "2024-01-01" },
    bucket: "quarter",
    lanes: [
      {
        key: "labs",
        items: [
          {
            id: "lab-day:2024-02-12",
            kind: "labDay",
            start: "2024-02-12",
            end: null,
            open: false,
            precision: "DAY",
            startKnown: true,
            label: "Ferritin",
            sub: "1",
            href: "/labs",
            group: null,
          },
          {
            id: "lab-day:2026-03-02",
            kind: "labDay",
            start: "2026-03-02",
            end: null,
            open: false,
            precision: "DAY",
            startKnown: true,
            label: "Ferritin, HbA1c",
            sub: "2",
            href: "/labs",
            group: null,
          },
        ],
      },
    ],
    standing: [],
    series: values.includes("WEIGHT")
      ? [
          {
            key: "WEIGHT",
            unit: "kg",
            points: [
              { t: "2025-01-01", mean: 82.4, count: 6 },
              { t: "2025-04-01", mean: 81.9, count: 5 },
            ],
          },
        ]
      : [],
    availableSeries: ["WEIGHT"],
    labSeries: ferritin
      ? [
          {
            key: "lab:bm-ferritin",
            biomarkerId: "bm-ferritin",
            name: "Ferritin",
            panel: "Iron",
            unit: "ng/mL",
            band: { low: 30, high: 400 },
            points: [
              {
                id: "r1",
                date: "2024-02-12",
                value: 18,
                sourceValue: null,
                rangeStatus: "below",
                referenceLow: 30,
                referenceHigh: 400,
                report: {
                  id: "d1",
                  title: "February report",
                  href: "/documents?doc=d1",
                },
              },
              {
                id: "r2",
                date: "2026-03-02",
                value: 120,
                sourceValue: null,
                rangeStatus: "in-range",
                referenceLow: 30,
                referenceHigh: 400,
                report: null,
              },
            ],
            excluded: 0,
          },
        ]
      : [],
    availableLabs: [
      {
        key: "lab:bm-hba1c",
        biomarkerId: "bm-hba1c",
        name: "HbA1c",
        panel: "Glucose",
        unit: "%",
      },
      {
        key: "lab:bm-ferritin",
        biomarkerId: "bm-ferritin",
        name: "Ferritin",
        panel: "Iron",
        unit: "ng/mL",
      },
    ],
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
  modules: Record<string, boolean> = { timeline: true, labs: true },
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

describe("lab lines on the timeline page", () => {
  it("asks for a stored lab marker and draws it as its readings", async () => {
    await page.viewport(1280, 900);
    const { net } = await mount(["WEIGHT", "lab:bm-ferritin"]);
    await expect
      .poll(
        () =>
          document.querySelectorAll(
            '[data-lab-series="lab:bm-ferritin"] [data-slot="timeline-lab-mark"]',
          ).length,
      )
      .toBe(2);
    expect(lastTimelineValues(net)).toEqual(["WEIGHT", "lab:bm-ferritin"]);
    const below = document.querySelector(
      '[data-lab-series="lab:bm-ferritin"] [data-status="below"]',
    );
    expect(below?.tagName.toLowerCase()).toBe("path");
    // The value line keeps its own row above it.
    expect(document.querySelector('[data-series="WEIGHT"]')).not.toBeNull();
    // The name leads to the marker's page.
    const link = document.querySelector(
      '[data-slot="timeline-series-link"][data-series="lab:bm-ferritin"]',
    );
    expect(link?.getAttribute("href")).toBe("/labs/bm-ferritin");
  });

  it("offers the record's markers under their groups, and a choice persists both ways", async () => {
    await page.viewport(1280, 900);
    const { net, screen } = await mount(["WEIGHT"]);
    const trigger = screen.getByRole("button", { name: /Values \(1\)/ });
    await expect.element(trigger).toBeVisible();
    await trigger.click();
    await expect.element(screen.getByText("Lab values")).toBeVisible();
    await expect.element(screen.getByText("Glucose")).toBeVisible();
    await expect.element(screen.getByText("Iron")).toBeVisible();
    const ferritin = screen.getByRole("menuitemcheckbox", { name: "Ferritin" });
    await expect.element(ferritin).toHaveAttribute("aria-checked", "false");
    await ferritin.click();
    await expect.element(ferritin).toHaveAttribute("aria-checked", "true");
    expect(JSON.parse(window.localStorage.getItem(VALUES_KEY)!)).toEqual([
      "WEIGHT",
      "lab:bm-ferritin",
    ]);
    await expect
      .poll(() => lastTimelineValues(net))
      .toEqual(["WEIGHT", "lab:bm-ferritin"]);

    await ferritin.click();
    await expect.element(ferritin).toHaveAttribute("aria-checked", "false");
    expect(JSON.parse(window.localStorage.getItem(VALUES_KEY)!)).toEqual([
      "WEIGHT",
    ]);
    await expect.poll(() => lastTimelineValues(net)).toEqual(["WEIGHT"]);
  });

  it("neither offers nor asks for a marker with the labs module off", async () => {
    await page.viewport(1280, 900);
    const { net, screen } = await mount(["WEIGHT", "lab:bm-ferritin"], {
      timeline: true,
      labs: false,
    });
    const trigger = screen.getByRole("button", { name: /Values \(1\)/ });
    await expect.element(trigger).toBeVisible();
    expect(lastTimelineValues(net)).toEqual(["WEIGHT"]);
    await trigger.click();
    await expect
      .element(screen.getByRole("menuitemcheckbox", { name: "Weight" }))
      .toBeVisible();
    expect(document.querySelector('[data-slot="timeline-values-labs"]')).toBe(
      null,
    );
  });

  it("reads a reading's point on its own by keyboard", async () => {
    await page.viewport(1280, 900);
    await mount(["lab:bm-ferritin"]);
    const target = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-slot="timeline-point-target"][data-series="lab:bm-ferritin"][data-t="r1"]',
      );
    await expect.poll(() => target() !== null).toBe(true);
    expect(target()!.getAttribute("aria-label")).toBe(
      "Ferritin, Feb 12, 2024: 18 ng/mL, below range, reference 30–400 ng/mL, Report: February report",
    );
    // One tab stop per line, on its newest reading; Left walks back.
    target()!
      .parentElement?.querySelector<HTMLButtonElement>('[data-t="r2"]')
      ?.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(target());
    const tip = document.querySelector('[data-slot="timeline-point-tip"]');
    expect(tip?.textContent).toContain("18 ng/mL");
    expect(tip?.textContent).toContain("below range");
    expect(tip?.textContent).toContain("February report");
  });

  it("fits a phone: no sideways scroll, a named values button, the readings on the lab day", async () => {
    await page.viewport(390, 844);
    const { screen } = await mount(["lab:bm-ferritin"]);
    await expect
      .element(screen.getByRole("button", { name: "Values (1)" }))
      .toBeVisible();
    // Newest first, each lab day with its own readings.
    await expect
      .poll(() =>
        [
          ...document.querySelectorAll('[data-slot="timeline-chronicle-labs"]'),
        ].map((el) => el.textContent),
      )
      .toEqual(["Ferritin 120 ng/mL", "Ferritin 18 ng/mL, below range"]);
    const root = document.documentElement;
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    const mobile = document.querySelector<HTMLElement>(
      '[data-slot="timeline-mobile"]',
    )!;
    expect(mobile.scrollWidth).toBeLessThanOrEqual(mobile.clientWidth);
  });
});
