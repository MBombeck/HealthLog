/**
 * v1.4.42 W5 — write-time canonical-row picker tests.
 *
 * Pairs with `src/lib/workouts/canonical-rows.ts`. The helper is the
 * pre-`createMany` dedup pass invoked by `POST /api/workouts/batch`
 * when the v1.5 iOS sprint posts a batch carrying both an Apple Watch
 * row and a Withings ScanWatch row for the same Sunday-morning run.
 * The tests pin the algorithm contract so a future tightening of the
 * window or a tie-breaker tweak surfaces a failing assertion rather
 * than a silent regression in the duplicate-drop count.
 */
import { describe, expect, it } from "vitest";

import {
  dedupeWorkoutBatch,
  WORKOUT_DEDUP_WINDOW_MS,
  type WorkoutRow,
} from "../canonical-rows";

import type { MeasurementSource } from "@/generated/prisma/client";

interface TestRow extends WorkoutRow {
  /** Marker so the test can assert which input row survived. */
  id: string;
}

function row(partial: Partial<TestRow> & { id: string }): TestRow {
  return {
    id: partial.id,
    userId: partial.userId ?? "user-1",
    activityType: partial.activityType ?? "running",
    startedAt: partial.startedAt ?? new Date("2026-05-21T08:00:00Z"),
    source: partial.source ?? "APPLE_HEALTH",
    caloriesKcal: partial.caloriesKcal ?? null,
    createdAt: partial.createdAt ?? null,
    index: partial.index,
  };
}

describe("dedupeWorkoutBatch", () => {
  it("returns an empty array on empty input", () => {
    expect(dedupeWorkoutBatch([])).toEqual([]);
  });

  it("preserves overlapping workouts from the same source", () => {
    const a = row({
      id: "a",
      source: "APPLE_HEALTH",
      caloriesKcal: 420,
      createdAt: new Date("2026-05-21T08:30:00Z"),
    });
    const b = row({
      id: "b",
      source: "APPLE_HEALTH",
      caloriesKcal: 420,
      createdAt: new Date("2026-05-21T08:31:00Z"),
    });

    expect(dedupeWorkoutBatch([a, b]).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("prefers the higher-priority source on a cross-source overlap inside the window", () => {
    // Apple Watch + Withings ScanWatch both record the same run. The
    // window is satisfied (rows are 60 s apart, well under the 90 s
    // ceiling) and the activityType matches → group dedups to one
    // survivor. APPLE_HEALTH outranks WITHINGS per the ladder.
    const apple = row({
      id: "apple",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:00:00Z"),
      caloriesKcal: 400,
    });
    const withings = row({
      id: "withings",
      source: "WITHINGS",
      startedAt: new Date("2026-05-21T08:01:00Z"),
      caloriesKcal: 500,
    });

    const out = dedupeWorkoutBatch([apple, withings]);
    expect(out).toHaveLength(1);
    // Source-axis wins outright — APPLE_HEALTH beats WITHINGS even
    // when WITHINGS has higher calories. The calories tie-break only
    // fires WITHIN a single source tier.
    expect(out[0]!.id).toBe("apple");
  });

  it("retains every row from the winning source in a cross-source overlap", () => {
    const appleFirst = row({
      id: "apple-first",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const withings = row({
      id: "withings",
      source: "WITHINGS",
      startedAt: new Date("2026-05-21T08:00:30Z"),
    });
    const appleSecond = row({
      id: "apple-second",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:01:00Z"),
    });

    expect(
      dedupeWorkoutBatch([appleFirst, withings, appleSecond]).map(
        (item) => item.id,
      ),
    ).toEqual(["apple-first", "apple-second"]);
  });

  it("returns every row unchanged when no overlap exists", () => {
    // Two runs 10 min apart from the SAME source — well outside the
    // 90 s window. Both must survive; the helper is not a generic
    // "one run per day" filter.
    const first = row({
      id: "first",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const second = row({
      id: "second",
      startedAt: new Date("2026-05-21T08:10:00Z"),
    });

    const out = dedupeWorkoutBatch([first, second]);
    expect(out.map((r) => r.id)).toEqual(["first", "second"]);
  });

  it("returns rows from different users untouched even on identical timestamps", () => {
    // A multi-user batch (theoretically possible from an admin path)
    // must never collapse rows across `userId`. The window check
    // includes the userId in the grouping key.
    const u1 = row({
      id: "u1",
      userId: "user-1",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const u2 = row({
      id: "u2",
      userId: "user-2",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });

    const out = dedupeWorkoutBatch([u1, u2]);
    expect(out.map((r) => r.id).sort()).toEqual(["u1", "u2"]);
  });

  it("returns rows of different activity types untouched at the same instant", () => {
    // A user opens a "Walk" workout on the Watch and a "Strength"
    // workout on the iPhone at the same instant. The window matches
    // but the activityType doesn't — two distinct rows, both survive.
    const walk = row({
      id: "walk",
      activityType: "walking",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const strength = row({
      id: "strength",
      activityType: "strength",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });

    const out = dedupeWorkoutBatch([walk, strength]);
    expect(out.map((r) => r.id).sort()).toEqual(["strength", "walk"]);
  });

  it("preserves same-source workouts when calories differ", () => {
    const lo = row({
      id: "lo",
      source: "APPLE_HEALTH",
      caloriesKcal: 200,
    });
    const hi = row({
      id: "hi",
      source: "APPLE_HEALTH",
      caloriesKcal: 500,
      createdAt: new Date("2026-05-21T09:00:00Z"),
    });

    expect(dedupeWorkoutBatch([lo, hi]).map((item) => item.id)).toEqual([
      "lo",
      "hi",
    ]);
  });

  it("preserves same-source input order when creation times differ", () => {
    const early = row({
      id: "early",
      source: "WITHINGS",
      caloriesKcal: 350,
      createdAt: new Date("2026-05-21T08:30:00Z"),
    });
    const late = row({
      id: "late",
      source: "WITHINGS",
      caloriesKcal: 350,
      createdAt: new Date("2026-05-21T08:45:00Z"),
    });

    expect(dedupeWorkoutBatch([late, early]).map((item) => item.id)).toEqual([
      "late",
      "early",
    ]);
  });

  it("preserves same-source input order when every field ties", () => {
    const first = row({ id: "first", source: "MANUAL" });
    const second = row({ id: "second", source: "MANUAL" });

    expect(dedupeWorkoutBatch([first, second]).map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
    expect(dedupeWorkoutBatch([second, first]).map((item) => item.id)).toEqual([
      "second",
      "first",
    ]);
  });

  it("treats a row exactly at the ±90 s boundary as in-window", () => {
    // The window is inclusive (`<=`). A row landing on the boundary
    // joins the group; one millisecond past stays separate.
    const anchor = row({
      id: "anchor",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const onBoundary = row({
      id: "boundary",
      source: "WITHINGS",
      startedAt: new Date(anchor.startedAt.getTime() + WORKOUT_DEDUP_WINDOW_MS),
    });
    const justOutside = row({
      id: "outside",
      source: "WITHINGS",
      startedAt: new Date(
        anchor.startedAt.getTime() + WORKOUT_DEDUP_WINDOW_MS + 1,
      ),
    });

    // anchor + onBoundary → one group; APPLE_HEALTH wins.
    expect(dedupeWorkoutBatch([anchor, onBoundary]).map((r) => r.id)).toEqual([
      "anchor",
    ]);

    // anchor + justOutside → two distinct groups, both survive.
    expect(dedupeWorkoutBatch([anchor, justOutside]).map((r) => r.id)).toEqual([
      "anchor",
      "outside",
    ]);
  });

  it("anchors overlap groups to the first row instead of chaining neighbours", () => {
    const anchor = row({
      id: "anchor",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const neighbour = row({
      id: "neighbour",
      source: "WITHINGS",
      startedAt: new Date(
        anchor.startedAt.getTime() + WORKOUT_DEDUP_WINDOW_MS - 1_000,
      ),
    });
    const chained = row({
      id: "chained",
      source: "WITHINGS",
      startedAt: new Date(
        anchor.startedAt.getTime() + 2 * (WORKOUT_DEDUP_WINDOW_MS - 1_000),
      ),
    });

    expect(
      dedupeWorkoutBatch([anchor, neighbour, chained]).map((item) => item.id),
    ).toEqual(["anchor", "chained"]);
  });

  it("keeps anchor windows stable when the batch arrives out of order", () => {
    const anchor = row({
      id: "anchor",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const neighbour = row({
      id: "neighbour",
      source: "WITHINGS",
      startedAt: new Date(
        anchor.startedAt.getTime() + WORKOUT_DEDUP_WINDOW_MS - 1_000,
      ),
    });
    const chained = row({
      id: "chained",
      source: "WITHINGS",
      startedAt: new Date(
        anchor.startedAt.getTime() + 2 * (WORKOUT_DEDUP_WINDOW_MS - 1_000),
      ),
    });

    expect(
      dedupeWorkoutBatch([neighbour, chained, anchor]).map((item) => item.id),
    ).toEqual(["chained", "anchor"]);
  });

  it("walks the full source ladder (APPLE_HEALTH > WITHINGS > MANUAL > IMPORT)", () => {
    const sources: MeasurementSource[] = [
      "IMPORT",
      "MANUAL",
      "WITHINGS",
      "APPLE_HEALTH",
    ];
    const rows = sources.map((source, idx) =>
      row({
        id: source,
        source,
        // Stagger by 10 s so each row sits inside the 90 s window
        // relative to the anchor (the first row inserted).
        startedAt: new Date(
          new Date("2026-05-21T08:00:00Z").getTime() + idx * 10_000,
        ),
      }),
    );

    expect(dedupeWorkoutBatch(rows).map((r) => r.id)).toEqual(["APPLE_HEALTH"]);
  });

  it("honours a custom user ladder that promotes MANUAL above APPLE_HEALTH", () => {
    // v1.4.43 W9 — when the user has customised Settings → Sources to
    // promote MANUAL above APPLE_HEALTH, a Manual row inside the 90 s
    // window MUST win over the Apple Watch twin. Without the
    // user-priority wiring this helper would silently drop the
    // user's preferred row at write-time before the read-time picker
    // ever saw it.
    const apple = row({
      id: "apple",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:00:00Z"),
      caloriesKcal: 500,
    });
    const manual = row({
      id: "manual",
      source: "MANUAL",
      startedAt: new Date("2026-05-21T08:01:00Z"),
      caloriesKcal: 300,
    });

    const userPriorityJson = {
      steps: ["MANUAL", "APPLE_HEALTH", "WITHINGS"] as MeasurementSource[],
    };

    const out = dedupeWorkoutBatch([apple, manual], userPriorityJson);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("manual");
  });

  it("falls back to the canonical default ladder when userPriorityJson is null", () => {
    // Null = no user preference persisted. The helper must walk the
    // canonical `DEFAULT_WORKOUT_SOURCE_PRIORITY` ladder so existing
    // callers that don't supply the blob keep their v1.4.42 behaviour.
    const apple = row({
      id: "apple",
      source: "APPLE_HEALTH",
      startedAt: new Date("2026-05-21T08:00:00Z"),
    });
    const manual = row({
      id: "manual",
      source: "MANUAL",
      startedAt: new Date("2026-05-21T08:01:00Z"),
    });

    expect(dedupeWorkoutBatch([apple, manual], null).map((r) => r.id)).toEqual([
      "apple",
    ]);
    expect(
      dedupeWorkoutBatch([apple, manual], undefined).map((r) => r.id),
    ).toEqual(["apple"]);
    // Argument omitted entirely — same behaviour as null/undefined.
    expect(dedupeWorkoutBatch([apple, manual]).map((r) => r.id)).toEqual([
      "apple",
    ]);
  });

  it("does not mutate caller rows", () => {
    // The picker is pure — the caller's array reference and row
    // identity survive the call so a future audit-overlay can
    // re-inspect the dropped rows.
    const a = row({ id: "a", source: "APPLE_HEALTH", caloriesKcal: 100 });
    const b = row({ id: "b", source: "WITHINGS", caloriesKcal: 100 });
    const before = JSON.stringify([a, b]);
    dedupeWorkoutBatch([a, b]);
    expect(JSON.stringify([a, b])).toBe(before);
  });
});
