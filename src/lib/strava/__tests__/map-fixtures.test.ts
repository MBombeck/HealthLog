/**
 * What each Strava mapper makes of a fixed set of payloads, pinned in
 * `__golden__/`.
 *
 * The fixtures under `__fixtures__/` are synthetic `SummaryActivity`
 * payloads in the documented v3 wire shape, each paired with the
 * `DetailedActivity` the sync would read for it (or none): heart rate on the
 * summary or only on the detail, a start only on the detail, legacy `type`
 * labels, unknown sports, zero and negative values, and the records the
 * mapper refuses. The rate-limit wait and the sport lookup take scalar
 * inputs, so their cases are tables in this file. The goldens were written
 * while the mappers still lived in `client.ts`, so a green run after they
 * move proves the move changed nothing.
 */
import { format } from "prettier";
import { describe, expect, it } from "vitest";

import { stravaRateLimitRetryAfterSeconds } from "../client";
import { mapActivity, summaryHasHeartRate } from "@/lib/strava/map";
import {
  type StravaDetailedActivity,
  type StravaSummaryActivity,
} from "@/lib/strava/wire-types";
import { mapStravaSportType } from "../sport-map";
import activitiesFixture from "./__fixtures__/activities.json";

interface ActivityCase {
  label: string;
  summary: StravaSummaryActivity;
  detail?: StravaDetailedActivity | null;
}

const activities: readonly ActivityCase[] = activitiesFixture;

/** The golden is written in the repository's JSON format, so the format check passes on it unchanged. */
async function golden(value: unknown): Promise<string> {
  return format(JSON.stringify(value), { parser: "json" });
}

describe("Strava mappers against the fixture payloads", () => {
  it("maps activities", async () => {
    const output = activities.map(({ label, summary, detail }) => ({
      label,
      summaryHasHeartRate: summaryHasHeartRate(summary),
      row: mapActivity(summary, detail),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-activities.json",
    );
  });

  it("resolves sport labels", async () => {
    const labels: Array<string | null | undefined> = [
      "Run",
      "TrailRun",
      "VirtualRide",
      "Virtual Ride",
      "virtual_ride",
      "  WeightTraining  ",
      "HighIntensityIntervalTraining",
      "Snowshoe",
      "Workout",
      "SomethingStravaAddedLater",
      "",
      "   ",
      null,
      undefined,
    ];
    const output = labels.map((raw) => ({
      raw: raw === undefined ? "(undefined)" : raw,
      sportType: mapStravaSportType(raw),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sport.json",
    );
  });

  it("derives the wait after a rate limit", async () => {
    const cases: Array<{
      label: string;
      headers: Record<string, string>;
      now: string;
    }> = [
      { label: "no headers", headers: {}, now: "2026-03-02T10:07:30.000Z" },
      {
        label: "retry-after seconds",
        headers: { "retry-after": "120" },
        now: "2026-03-02T10:07:30.000Z",
      },
      {
        label: "retry-after HTTP date",
        headers: { "retry-after": "Mon, 02 Mar 2026 10:10:00 GMT" },
        now: "2026-03-02T10:07:30.000Z",
      },
      {
        label: "retry-after zero falls through",
        headers: { "retry-after": "0" },
        now: "2026-03-02T10:07:30.000Z",
      },
      {
        label: "15-minute window spent",
        headers: {
          "x-ratelimit-limit": "200,2000",
          "x-ratelimit-usage": "200,450",
        },
        now: "2026-03-02T10:07:30.000Z",
      },
      {
        label: "daily window spent",
        headers: {
          "x-ratelimit-limit": "200,2000",
          "x-ratelimit-usage": "120,2000",
        },
        now: "2026-03-02T10:07:30.000Z",
      },
      {
        label: "daily read window spent",
        headers: {
          "x-ratelimit-limit": "200,2000",
          "x-ratelimit-usage": "40,500",
          "x-readratelimit-limit": "100,1000",
          "x-readratelimit-usage": "30,1001",
        },
        now: "2026-03-02T10:07:30.000Z",
      },
      {
        label: "malformed pair",
        headers: {
          "x-ratelimit-limit": "200",
          "x-ratelimit-usage": "abc,2000",
        },
        now: "2026-03-02T10:07:30.000Z",
      },
      {
        label: "exactly on a quarter hour",
        headers: {},
        now: "2026-03-02T10:15:00.000Z",
      },
      {
        label: "half a second before midnight, daily spent",
        headers: {
          "x-ratelimit-limit": "200,2000",
          "x-ratelimit-usage": "10,2500",
        },
        now: "2026-03-02T23:59:59.500Z",
      },
    ];
    const output = cases.map(({ label, headers, now }) => ({
      label,
      seconds: stravaRateLimitRetryAfterSeconds(
        new Headers(headers),
        new Date(now),
      ),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-rate-limit.json",
    );
  });
});
