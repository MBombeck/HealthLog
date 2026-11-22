/**
 * The slice's night history keeps its old nights as a closed block and still
 * answers what `summarizeNights` answers over the full walk.
 *
 * The walk is mocked at its two reads (the night list, a chunk's stage rows)
 * and the reconstruction, so the test can count chunk reads and move a span.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SleepNight } from "@/lib/analytics/sleep-night";
import type { SleepNightSpan } from "@/lib/measurements/list/sleep-nights";

const state = vi.hoisted(() => ({
  spans: [] as SleepNightSpan[],
  chunkReads: [] as string[][],
}));

vi.mock("@/lib/measurements/list/sleep-nights", () => ({
  NIGHT_CHUNK: 90,
  sleepNightPage: vi.fn(async () => ({
    nights: state.spans,
    total: state.spans.length,
  })),
  // A chunk's "rows" are its spans, so the reconstruction below can build
  // its nights from them.
  readNightSpanRows: vi.fn(async (_userId: string, chunk: SleepNightSpan[]) => {
    state.chunkReads.push(chunk.map((c) => c.night));
    return chunk;
  }),
}));
vi.mock("@/lib/analytics/sleep-night", () => ({
  reconstructSleepNights: (rows: SleepNightSpan[]) =>
    rows.map((span) => night(span)),
}));

import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { summarize } from "@/lib/analytics/trends";

import { closedNightsBefore, readNightHistory } from "../sleep-night-history";

const DAY = 86_400_000;
const NOW = new Date("2026-10-23T12:00:00.000Z");

/** A night whose minutes follow from its day; every seventh one awake only. */
function night(span: SleepNightSpan): SleepNight {
  const d = Math.round(span.spanEnd.getTime() / DAY);
  return {
    night: span.night,
    measuredAt: span.spanEnd,
    asleepMinutes: d % 7 === 0 ? 0 : 300 + (d % 90),
    sourceDiscrepancy: d % 5 === 0 ? { deltaMinutes: 40, sources: [] } : null,
  } as unknown as SleepNight;
}

function spansFor(days: number): SleepNightSpan[] {
  return Array.from({ length: days }, (_, i) => {
    const end = new Date(NOW.getTime() - (days - i) * DAY);
    return {
      night: end.toISOString().slice(0, 10),
      spanStart: new Date(end.getTime() - 8 * 3_600_000),
      spanEnd: end,
    };
  });
}

/** What the full walk and `summarizeNights` answer over the same spans. */
function fullWalk(spans: SleepNightSpan[]) {
  const nights = spans.map(night);
  const asleep = nights.filter((n) => n.asleepMinutes > 0);
  return {
    nightCount: nights.length,
    summary: summarize(
      asleep.map((n) => ({ date: n.measuredAt, value: n.asleepMinutes })),
    ),
    latestNight: asleep.length > 0 ? asleep[asleep.length - 1] : null,
  };
}

beforeEach(() => {
  __resetAllCachesForTests();
  state.chunkReads = [];
});

describe("readNightHistory", () => {
  it("answers what the full walk answers, cold and from the closed block", async () => {
    state.spans = spansFor(400);
    const cold = await readNightHistory("u1", "UTC", null, NOW);
    expect(cold).toEqual(fullWalk(state.spans));
    const coldReads = state.chunkReads.length;
    expect(coldReads).toBe(5);

    state.chunkReads = [];
    const warm = await readNightHistory("u1", "UTC", null, NOW);
    expect(warm).toEqual(fullWalk(state.spans));
    // Only the chunks after the block are read again.
    expect(state.chunkReads.length).toBeLessThan(coldReads);
    const before = closedNightsBefore(NOW).getTime();
    for (const chunk of state.chunkReads) {
      expect(
        chunk.some((key) => Date.parse(`${key}T00:00:00Z`) >= before - DAY),
      ).toBe(true);
    }
  });

  it("keeps the walk's own chunks: the block ends on a chunk boundary", async () => {
    state.spans = spansFor(400);
    await readNightHistory("u1", "UTC", null, NOW);
    const sizes = state.chunkReads.map((c) => c.length);
    expect(sizes.slice(0, -1).every((n) => n === 90)).toBe(true);
  });

  it("rebuilds the block when one of its spans moved", async () => {
    state.spans = spansFor(400);
    await readNightHistory("u1", "UTC", null, NOW);
    const moved = state.spans.map((s, i) =>
      i === 10
        ? { ...s, spanEnd: new Date(s.spanEnd.getTime() + 3_600_000) }
        : s,
    );
    state.spans = moved;
    state.chunkReads = [];
    const out = await readNightHistory("u1", "UTC", null, NOW);
    expect(out).toEqual(fullWalk(moved));
    expect(state.chunkReads[0]?.[0]).toBe(moved[0].night);
  });

  it("holds no block for a short history", async () => {
    state.spans = spansFor(30);
    const out = await readNightHistory("u1", "UTC", null, NOW);
    expect(out).toEqual(fullWalk(state.spans));
    expect(state.chunkReads).toHaveLength(1);
  });
});
