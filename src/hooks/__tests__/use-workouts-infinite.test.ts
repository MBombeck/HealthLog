import { describe, expect, it } from "vitest";

import {
  flattenWorkoutPages,
  getNextWorkoutPageOffset,
  type WorkoutListEntry,
  type WorkoutListPayload,
} from "@/hooks/use-workouts";

function workout(id: string): WorkoutListEntry {
  return {
    id,
    sportType: "running",
    startedAt: "2026-07-20T08:00:00.000Z",
    endedAt: "2026-07-20T08:30:00.000Z",
    durationSec: 1800,
    distanceM: null,
    activeEnergyKcal: null,
    avgHr: null,
    maxHr: null,
    source: "APPLE_HEALTH",
    externalId: null,
  };
}

function page(
  ids: string[],
  { total = 201, limit = 100, offset = 0 } = {},
): WorkoutListPayload {
  return {
    workouts: ids.map(workout),
    meta: { total, limit, offset, droppedDuplicates: 0 },
  };
}

describe("infinite workout paging", () => {
  it("uses the accumulated canonical row count as the next offset", () => {
    const first = page(
      Array.from({ length: 100 }, (_, index) => `w-${index + 1}`),
    );
    const second = page(
      Array.from({ length: 100 }, (_, index) => `w-${index + 101}`),
      { offset: 100 },
    );

    expect(getNextWorkoutPageOffset(second, [first, second])).toBe(200);
  });

  it("stops when the server total is reached or the page is short", () => {
    const complete = page(["w-201"], { total: 201, offset: 200 });
    expect(
      getNextWorkoutPageOffset(complete, [
        page(Array.from({ length: 100 }, (_, index) => `w-${index + 1}`)),
        page(
          Array.from({ length: 100 }, (_, index) => `w-${index + 101}`),
          {
            offset: 100,
          },
        ),
        complete,
      ]),
    ).toBeUndefined();

    const short = page(["w-101"], { total: 250, offset: 100 });
    expect(
      getNextWorkoutPageOffset(short, [
        page(Array.from({ length: 100 }, (_, index) => `w-${index + 1}`)),
        short,
      ]),
    ).toBeUndefined();
  });

  it("flattens pages once and keeps the first row for duplicate ids", () => {
    const first = page(["w-1", "w-2"]);
    const second = page(["w-2", "w-3"], { offset: 2 });

    expect(flattenWorkoutPages([first, second]).map((row) => row.id)).toEqual([
      "w-1",
      "w-2",
      "w-3",
    ]);
  });
});
