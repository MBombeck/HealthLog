import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { annotateMock } = vi.hoisted(() => ({ annotateMock: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({
  annotate: annotateMock,
  getEvent: () => null,
}));

import { fetchExercises } from "../client";
import {
  combinePolarStart,
  mapExercise,
  normaliseExerciseList,
  parseIsoDuration,
} from "@/lib/polar/map";
import { type PolarExercise } from "@/lib/polar/wire-types";
import { PolarApiError } from "../response-classifier";

function installFetchMock(pages: Array<{ status: number; body?: unknown }>) {
  let i = 0;
  const fetchMock = vi.fn(async (...args: [string, RequestInit?]) => {
    void args;
    const page = pages[Math.min(i, pages.length - 1)]!;
    i += 1;
    return {
      status: page.status,
      json: async () => page.body ?? null,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  annotateMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function driftAnnotations() {
  return annotateMock.mock.calls
    .map((c) => c[0])
    .filter((f) => f?.action?.name === "polar.envelope.drift");
}

describe("fetchExercises — request path", () => {
  // #568 regression guard: the exercises collection GET carries NO userId in
  // the path (the user is identified by the Bearer token), exactly the shape
  // the v1.31.2 vitals-endpoint fix established. Assert the URL literally.
  it("hits GET /v3/exercises with Bearer auth and no userId in the path", async () => {
    const fetchMock = installFetchMock([{ status: 204 }]);
    await fetchExercises("tok");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.polaraccesslink.com/v3/exercises",
      expect.objectContaining({ method: "GET" }),
    );
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toBe("https://www.polaraccesslink.com/v3/exercises");
    expect(url).not.toContain("/users/");
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("returns [] on a 204 No Content", async () => {
    installFetchMock([{ status: 204 }]);
    expect(await fetchExercises("tok")).toEqual([]);
  });

  it("returns [] on a non-JSON 200 body", async () => {
    installFetchMock([{ status: 200, body: null }]);
    expect(await fetchExercises("tok")).toEqual([]);
  });

  it("classifies a 401 as a reauth-required PolarApiError", async () => {
    installFetchMock([{ status: 401 }]);
    await expect(fetchExercises("tok")).rejects.toMatchObject({
      classification: "reauth_required",
      httpStatus: 401,
    });
  });

  it("classifies a 5xx as transient", async () => {
    installFetchMock([{ status: 503 }]);
    await expect(fetchExercises("tok")).rejects.toMatchObject({
      classification: "transient",
    });
  });

  // Assumption #4: a scope gap on exercises surfaces as a 403, which the shared
  // classifier lifts to reauth_required — a soft/recoverable integration error
  // the workout sync records rather than hard-crashing the whole Polar sync.
  it("classifies a 403 scope error as a soft reauth-required error, not a crash", async () => {
    installFetchMock([{ status: 403 }]);
    const err = await fetchExercises("tok").catch((e) => e);
    expect(err).toBeInstanceOf(PolarApiError);
    expect(err.classification).toBe("reauth_required");
    expect(err.httpStatus).toBe(403);
  });
});

describe("normaliseExerciseList — pagination-absence tolerance (assumption #3)", () => {
  const one = { id: 1 };
  it("accepts a bare array", () => {
    expect(normaliseExerciseList([one])).toEqual([one]);
  });
  it("accepts a paged envelope under `exercises`", () => {
    expect(normaliseExerciseList({ exercises: [one], page: 1 })).toEqual([one]);
  });
  it("accepts alternate envelope keys (data / items)", () => {
    expect(normaliseExerciseList({ data: [one] })).toEqual([one]);
    expect(normaliseExerciseList({ items: [one] })).toEqual([one]);
  });
  it("returns [] for an unrecognised shape", () => {
    expect(normaliseExerciseList({ nope: [one] })).toEqual([]);
    expect(normaliseExerciseList(null)).toEqual([]);
    expect(normaliseExerciseList(42)).toEqual([]);
  });
});

describe("fetchExercises — body shape (assumption #3)", () => {
  it("unwraps a paged { exercises: [...] } envelope", async () => {
    installFetchMock([{ status: 200, body: { exercises: [{ id: "a" }] } }]);
    const r = await fetchExercises("tok");
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe("a");
  });
  it("returns the bare top-level array", async () => {
    installFetchMock([{ status: 200, body: [{ id: "a" }, { id: "b" }] }]);
    expect(await fetchExercises("tok")).toHaveLength(2);
  });
});

describe("fetchExercises — envelope drift logging (E-77)", () => {
  it("logs a drift breadcrumb and degrades to [] on an object body with no recognised list key", async () => {
    installFetchMock([{ status: 200, body: { nope: [{ id: "a" }] } }]);
    expect(await fetchExercises("tok")).toEqual([]);
    const drift = driftAnnotations();
    expect(drift).toHaveLength(1);
    expect(drift[0].action.details).toMatchObject({
      verb: "fetchExercises",
      httpStatus: 200,
      keys: ["nope"],
    });
  });

  it("does NOT drift on a bare array", async () => {
    installFetchMock([{ status: 200, body: [{ id: "a" }] }]);
    expect(await fetchExercises("tok")).toHaveLength(1);
    expect(driftAnnotations()).toHaveLength(0);
  });

  it("does NOT drift on a recognised envelope key (`data`)", async () => {
    installFetchMock([{ status: 200, body: { data: [{ id: "a" }] } }]);
    expect(await fetchExercises("tok")).toHaveLength(1);
    expect(driftAnnotations()).toHaveLength(0);
  });

  it("does NOT drift on an empty array under a recognised key", async () => {
    installFetchMock([{ status: 200, body: { exercises: [] } }]);
    expect(await fetchExercises("tok")).toEqual([]);
    expect(driftAnnotations()).toHaveLength(0);
  });

  it("does NOT drift on a 204 empty window", async () => {
    installFetchMock([{ status: 204 }]);
    expect(await fetchExercises("tok")).toEqual([]);
    expect(driftAnnotations()).toHaveLength(0);
  });
});

describe("parseIsoDuration", () => {
  it("parses hours/minutes/seconds", () => {
    expect(parseIsoDuration("PT2H44M30S")).toBe(2 * 3600 + 44 * 60 + 30);
    expect(parseIsoDuration("PT45M")).toBe(2700);
    expect(parseIsoDuration("PT30S")).toBe(30);
    expect(parseIsoDuration("PT1H")).toBe(3600);
  });
  it("parses fractional seconds and days", () => {
    expect(parseIsoDuration("PT1M2.5S")).toBe(63); // rounded
    expect(parseIsoDuration("P1DT2H")).toBe(86400 + 7200);
  });
  it("returns 0 for malformed / empty input", () => {
    expect(parseIsoDuration("nonsense")).toBe(0);
    expect(parseIsoDuration("")).toBe(0);
    expect(parseIsoDuration(null)).toBe(0);
    expect(parseIsoDuration(undefined)).toBe(0);
  });
});

describe("combinePolarStart — UTC-offset composition (assumption #2)", () => {
  it("applies a POSITIVE offset to a naive local wall-clock", () => {
    // 07:00 local at UTC+2 → 05:00 UTC.
    const d = combinePolarStart("2026-06-10T07:00:00", 120)!;
    expect(d.toISOString()).toBe("2026-06-10T05:00:00.000Z");
  });
  it("applies a NEGATIVE offset to a naive local wall-clock", () => {
    // 07:00 local at UTC-5 → 12:00 UTC.
    const d = combinePolarStart("2026-06-10T07:00:00", -300)!;
    expect(d.toISOString()).toBe("2026-06-10T12:00:00.000Z");
  });
  it("treats a missing offset as UTC wall-clock", () => {
    const d = combinePolarStart("2026-06-10T07:00:00", null)!;
    expect(d.toISOString()).toBe("2026-06-10T07:00:00.000Z");
  });
  it("uses a zone-qualified start directly and does NOT re-apply the offset", () => {
    // Already carries +02:00 → 05:00 UTC; the offset field must be ignored.
    const d = combinePolarStart("2026-06-10T07:00:00+02:00", 120)!;
    expect(d.toISOString()).toBe("2026-06-10T05:00:00.000Z");
  });
  it("handles a trailing-Z start directly", () => {
    const d = combinePolarStart("2026-06-10T07:00:00Z", 120)!;
    expect(d.toISOString()).toBe("2026-06-10T07:00:00.000Z");
  });
  it("returns null for a missing / unparseable start", () => {
    expect(combinePolarStart(null, 0)).toBeNull();
    expect(combinePolarStart("", 0)).toBeNull();
    expect(combinePolarStart("not-a-date", 0)).toBeNull();
  });
});

describe("mapExercise", () => {
  const full: PolarExercise = {
    id: 987654321,
    start_time: "2026-06-10T07:00:00",
    start_time_utc_offset: 120,
    duration: "PT45M",
    sport: "RUNNING",
    detailed_sport_info: "TRAIL_RUNNING",
    calories: 512,
    distance: 9200.5,
    heart_rate: { average: 148, maximum: 172 },
    training_load: 145.2,
    device: "Polar Vantage",
    device_id: "dev-1",
  };

  it("maps a full exercise into the exact Workout row shape", () => {
    const row = mapExercise(full)!;
    expect(row.externalId).toBe("987654321");
    expect(row.sportType).toBe("running");
    expect(row.startedAt.toISOString()).toBe("2026-06-10T05:00:00.000Z");
    expect(row.durationSec).toBe(2700);
    expect(row.endedAt.toISOString()).toBe("2026-06-10T05:45:00.000Z");
    expect(row.totalEnergyKcal).toBe(512);
    expect(row.totalDistanceM).toBe(9200.5);
    expect(row.avgHeartRate).toBe(148);
    expect(row.maxHeartRate).toBe(172);
    expect(row.elevationM).toBeNull();
    expect(row.metadata).toMatchObject({
      polarSport: "RUNNING",
      polarDetailedSportInfo: "TRAIL_RUNNING",
      polarDevice: "Polar Vantage",
      polarDeviceId: "dev-1",
      trainingLoad: 145.2,
      startTimeUtcOffset: 120,
    });
  });

  // Assumption #1: the id may arrive as a string OR a number — coerce both to a
  // stable string externalId, never parse it.
  it("coerces a numeric id and a string id to the same stable externalId", () => {
    expect(mapExercise({ ...full, id: 42 })!.externalId).toBe("42");
    expect(mapExercise({ ...full, id: "42" })!.externalId).toBe("42");
    expect(mapExercise({ ...full, id: "abc-123" })!.externalId).toBe("abc-123");
  });

  it("nulls optional numeric fields when absent", () => {
    const row = mapExercise({
      id: "x",
      start_time: "2026-06-10T07:00:00",
      start_time_utc_offset: 0,
      duration: "PT30M",
      sport: "STRENGTH_TRAINING",
    })!;
    expect(row.totalEnergyKcal).toBeNull();
    expect(row.totalDistanceM).toBeNull();
    expect(row.avgHeartRate).toBeNull();
    expect(row.maxHeartRate).toBeNull();
    expect(row.sportType).toBe("strength");
  });

  it("treats a malformed duration as 0 and never lands endedAt before startedAt", () => {
    const row = mapExercise({ ...full, duration: "garbage" })!;
    expect(row.durationSec).toBe(0);
    expect(row.endedAt.getTime()).toBe(row.startedAt.getTime());
  });

  it("skips an exercise with no id", () => {
    expect(mapExercise({ ...full, id: null })).toBeNull();
    expect(mapExercise({ ...full, id: undefined })).toBeNull();
  });

  it("skips an exercise with an unparseable start", () => {
    expect(mapExercise({ ...full, start_time: "nope" })).toBeNull();
    expect(mapExercise({ ...full, start_time: null })).toBeNull();
  });

  it("drops negative numerics to null (non-negative guard)", () => {
    const row = mapExercise({
      ...full,
      calories: -5,
      distance: -1,
      heart_rate: { average: -1, maximum: -1 },
    })!;
    expect(row.totalEnergyKcal).toBeNull();
    expect(row.totalDistanceM).toBeNull();
    expect(row.avgHeartRate).toBeNull();
    expect(row.maxHeartRate).toBeNull();
  });
});
