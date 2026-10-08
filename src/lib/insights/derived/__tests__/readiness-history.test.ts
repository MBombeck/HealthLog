/**
 * The readiness course is read, never recomputed: the nightly job persists
 * this blend as the COMPUTED recovery row, and a device's own recovery number
 * (WHOOP, Oura, Polar) is not this blend, so it never enters the series.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany } },
}));

import { readReadinessHistory } from "../readiness";

const NOW = new Date("2026-06-02T07:00:00Z");

beforeEach(() => findMany.mockReset());

describe("readReadinessHistory", () => {
  it("reads only the persisted blend inside the window, oldest first", async () => {
    // Newest first, as the query orders them.
    findMany.mockResolvedValue([
      { value: 71.6 },
      { value: 64.2 },
      { value: 80 },
    ]);

    const series = await readReadinessHistory("u1", NOW, 30);

    expect(series).toEqual([80, 64, 72]);
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "u1",
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      deletedAt: null,
    });
    expect(where.measuredAt.lte).toEqual(NOW);
    expect(where.measuredAt.gte).toEqual(new Date("2026-05-03T07:00:00Z"));
  });

  it("answers an empty course when the job never ran", async () => {
    findMany.mockResolvedValue([]);
    expect(await readReadinessHistory("u1", NOW, 30)).toEqual([]);
  });
});
