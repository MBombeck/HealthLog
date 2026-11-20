/**
 * Which active symptoms become correlation channels: the most logged in the
 * analysis window, at most eight, built-in and own alike, and the same eight
 * for the same data whatever order the rows arrive in.
 *
 * Mutation checks (each run, each seen red):
 *   - sort by creation only (drop the count) → "takes the most logged"
 *     goes red;
 *   - drop the most-recent tie-break → "breaks a tie on the most recent
 *     occurrence" goes red;
 *   - slice by `MAX_ACTIVE_SYMPTOM_DEFINITIONS` → "takes at most eight"
 *     goes red.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  MAX_ACTIVE_SYMPTOM_DEFINITIONS,
  MAX_SYMPTOM_CORRELATION_CHANNELS,
  pickCorrelationSymptoms,
  type CorrelationSymptomCandidate,
} from "../server";

function candidate(
  id: string,
  eventCount: number,
  last: string | null,
  created = "2026-01-01T00:00:00.000Z",
): CorrelationSymptomCandidate {
  return {
    id,
    createdAt: new Date(created),
    eventCount,
    lastOccurredAt: last ? new Date(last) : null,
  };
}

/** A fixed shuffle, so input order is shown not to matter. */
function shuffled<T>(list: readonly T[]): T[] {
  return list
    .map((item, i) => ({ item, key: (i * 7 + 3) % list.length }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

describe("pickCorrelationSymptoms", () => {
  it("separates the active cap from the channel bound", () => {
    expect(MAX_ACTIVE_SYMPTOM_DEFINITIONS).toBe(30);
    expect(MAX_SYMPTOM_CORRELATION_CHANNELS).toBe(8);
  });

  it("takes the most logged, at most eight, whatever the input order", () => {
    // The most logged were felt longest ago and defined last, so neither
    // tie-break alone would pick them.
    const all = Array.from({ length: 12 }, (_, i) =>
      candidate(
        `d${i}`,
        i,
        `2026-11-${String(30 - i).padStart(2, "0")}`,
        `2026-01-${String(1 + i).padStart(2, "0")}`,
      ),
    );
    const picked = pickCorrelationSymptoms(shuffled(all)).map((c) => c.id);
    expect(picked).toEqual(["d11", "d10", "d9", "d8", "d7", "d6", "d5", "d4"]);
    expect(pickCorrelationSymptoms(all).map((c) => c.id)).toEqual(picked);
  });

  it("takes at most eight of thirty", () => {
    const all = Array.from({ length: 30 }, (_, i) =>
      candidate(`d${String(i).padStart(2, "0")}`, 1, null),
    );
    expect(pickCorrelationSymptoms(all)).toHaveLength(8);
  });

  it("breaks a tie on the most recent occurrence, then the older definition, then the id", () => {
    const picked = pickCorrelationSymptoms(
      [
        candidate("never", 0, null, "2025-01-01T00:00:00.000Z"),
        candidate("older", 3, "2026-11-01T08:00:00.000Z"),
        candidate("newer", 3, "2026-11-02T08:00:00.000Z"),
        candidate("b-same", 3, "2026-11-01T08:00:00.000Z"),
        candidate("first", 3, "2026-11-01T08:00:00.000Z", "2025-06-01"),
      ],
      5,
    ).map((c) => c.id);
    expect(picked).toEqual(["newer", "first", "b-same", "older", "never"]);
  });

  it("ranks a symptom never logged in the window last", () => {
    const picked = pickCorrelationSymptoms(
      [
        candidate("quiet", 0, null, "2020-01-01T00:00:00.000Z"),
        candidate("once", 1, "2026-01-01T00:00:00.000Z"),
      ],
      1,
    );
    expect(picked.map((c) => c.id)).toEqual(["once"]);
  });
});
