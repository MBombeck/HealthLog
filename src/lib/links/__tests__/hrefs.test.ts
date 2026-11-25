/**
 * What the href registry answers, pinned per question the hand-built links
 * used to answer differently on different surfaces.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dailyBriefingKeyFindingSchema } from "@/lib/ai/schema";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import { DAY_QUERY_PARAM } from "@/lib/day/contract";
import {
  CARE_WEB_PATH,
  CARE_WIRE_PATH,
  visitPath,
} from "@/lib/encounters/visit-links";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";
import { dashboardTileHref } from "@/components/dashboard/tile-destinations";
import { readSource } from "@/__tests__/helpers/source-files";

import {
  RECORD_HREF_KINDS,
  dayHref,
  labDayHref,
  labHref,
  metricHref,
  moodDayHref,
  pageHref,
  recordHref,
  webHref,
} from "../hrefs";

const APP = join(process.cwd(), "src/app");

/** True when the path (without query) names a page under src/app. */
function pageExists(href: string): boolean {
  const path = href.split(/[?#]/)[0]!;
  // A dynamic segment: the folder is named `[param]`.
  const parts = path.split("/").filter(Boolean);
  let dir = APP;
  for (const part of parts) {
    const literal = join(dir, part);
    if (existsSync(literal)) {
      dir = literal;
      continue;
    }
    const dynamic = ["[id]", "[biomarkerId]", "[type]", "[metric]"]
      .map((name) => join(dir, name))
      .find((candidate) => existsSync(candidate));
    if (!dynamic) return false;
    dir = dynamic;
  }
  return existsSync(join(dir, "page.tsx"));
}

describe("metric pages", () => {
  it("leads a value with a page of its own to that page", () => {
    expect(metricHref("WEIGHT")).toBe("/insights/weight");
    expect(metricHref("PULSE")).toBe("/insights/pulse");
    expect(metricHref("SLEEP_DURATION")).toBe("/insights/sleep");
    expect(metricHref("BODY_FAT")).toBe("/insights/body-fat");
    expect(metricHref("BLOOD_PRESSURE")).toBe("/insights/blood-pressure");
    expect(metricHref("BLOOD_PRESSURE_SYS")).toBe("/insights/blood-pressure");
    expect(metricHref("HRV_RMSSD")).toBe("/insights/hrv");
    expect(metricHref("MOOD")).toBe("/insights/mood");
  });

  it("gives a kind without a page no link", () => {
    expect(metricHref("NOT_A_TYPE")).toBeNull();
    expect(metricHref("")).toBeNull();
    expect(metricHref("constructor")).toBeNull();
  });

  it("gives VO₂ max one page, whichever spelling asks", () => {
    const page = "/insights/cardio-fitness";
    expect(metricHref("VO2_MAX")).toBe(page);
    expect(metricHref("vo2_max")).toBe(page);
    expect(metricHref("cardio-fitness")).toBe(page);
    expect(dashboardTileHref("vo2Max", null)).toBe(page);
  });

  it("leads every briefing finding to a page that exists", () => {
    for (const metric of dailyBriefingKeyFindingSchema.shape.sourceMetric
      .options) {
      const href = metricHref(metric);
      expect(href, metric).not.toBeNull();
      expect(pageExists(href!), `${metric} → ${href}`).toBe(true);
    }
  });

  it("leads every sub-page slug and Coach source to a page that exists", () => {
    for (const key of [
      ...SUB_PAGE_SLUGS,
      ...Object.keys(COACH_SOURCE_MEASUREMENT_TYPES),
    ]) {
      const href = metricHref(key);
      if (href === null) continue;
      expect(pageExists(href), `${key} → ${href}`).toBe(true);
    }
  });

  it("agrees with the dashboard tile for a metric both name", () => {
    const pairs: [string, string][] = [
      ["weight", "WEIGHT"],
      ["bp", "BLOOD_PRESSURE_SYS"],
      ["pulse", "PULSE"],
      ["bodyFat", "BODY_FAT"],
      ["sleep", "SLEEP_DURATION"],
      ["steps", "ACTIVITY_STEPS"],
      ["glucose", "BLOOD_GLUCOSE"],
      ["hrv", "HEART_RATE_VARIABILITY"],
      ["oxygenSaturation", "OXYGEN_SATURATION"],
      ["respiratoryRate", "RESPIRATORY_RATE"],
      ["wristTemperature", "WRIST_TEMPERATURE"],
      ["muscleMass", "MUSCLE_MASS"],
      ["totalBodyWater", "TOTAL_BODY_WATER"],
      ["boneMass", "BONE_MASS"],
      ["vo2Max", "VO2_MAX"],
    ];
    for (const [tile, type] of pairs) {
      expect(dashboardTileHref(tile, null), tile).toBe(metricHref(type));
    }
  });
});

describe("record links", () => {
  it("opens every record kind on a page that exists", () => {
    for (const kind of RECORD_HREF_KINDS) {
      const href = recordHref(kind, "rec_1");
      expect(pageExists(webHref(href)), `${kind} → ${href}`).toBe(true);
    }
  });

  it("opens a dose on the history tab, not on the redirect page", () => {
    const href = recordHref("medicationHistory", "med_1");
    expect(href).toBe("/medications/med_1?tab=history");
    expect(href).not.toContain("/history");
  });

  it("names the record a day entry is about", () => {
    expect(recordHref("seizure", "s1")).toBe("/seizures?event=s1");
    expect(recordHref("assessment", "a1")).toBe(
      "/mental-wellbeing?assessment=a1",
    );
    expect(moodDayHref("2026-03-01")).toBe(
      "/mood?from=2026-03-01&to=2026-03-01",
    );
  });

  it("encodes what it splices", () => {
    expect(recordHref("analyte", "LDL / HDL")).toBe(
      "/labs?analyte=LDL%20%2F%20HDL",
    );
  });

  it("opens a lab reading on its marker, else its name, else the list", () => {
    expect(labHref({ biomarkerId: "b1", analyte: "LDL" })).toBe("/labs/b1");
    expect(labHref({ biomarkerId: null, analyte: "LDL" })).toBe(
      "/labs?analyte=LDL",
    );
    expect(labHref({ biomarkerId: null })).toBe(pageHref("labs"));
  });

  it("opens a lab day on its one marker, else the day over the list", () => {
    expect(labDayHref("2026-03-01", ["b1", "b1"])).toBe("/labs/b1");
    expect(labDayHref("2026-03-01", ["b1", "b2"])).toBe("/labs?day=2026-03-01");
    expect(labDayHref("2026-03-01", ["b1", null])).toBe("/labs?day=2026-03-01");
    expect(labDayHref("2026-03-01", [null])).toBe("/labs?day=2026-03-01");
  });
});

describe("day links", () => {
  it("open the day layer, which the shell mounts over every page", () => {
    expect(dayHref("illness", "2026-03-01")).toBe(
      `/illness?${DAY_QUERY_PARAM}=2026-03-01`,
    );
    // The reader of `?day=` on `/illness`, `/labs`, `/seizures`, … is the
    // day layer, mounted once in the authenticated shell for every page.
    readSource("src/components/layout/auth-shell.tsx", /<DayLayerMount\s*\/>/);
    readSource(
      "src/components/day/day-layer.tsx",
      "searchParams.get(DAY_QUERY_PARAM)",
    );
  });
});

describe("webHref", () => {
  it("opens a wire care path on the web page, without the redirect", () => {
    expect(webHref(CARE_WIRE_PATH)).toBe(CARE_WEB_PATH);
    expect(webHref(visitPath("v1"))).toBe(`${CARE_WEB_PATH}?visit=v1`);
    expect(webHref(`${CARE_WIRE_PATH}#x`)).toBe(`${CARE_WEB_PATH}#x`);
  });

  it("leaves every other path alone", () => {
    for (const href of ["/labs/b1", `${CARE_WIRE_PATH}-other`, "/careers"]) {
      expect(webHref(href)).toBe(href);
    }
  });
});
