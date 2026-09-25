import { describe, expect, it } from "vitest";

import {
  isBeforeLiveEra,
  liveEraStart,
  liveEraStartsByMedication,
} from "@/lib/medications/scheduling/live-era";

const d = (iso: string) => new Date(iso);

describe("live era start", () => {
  it("is null without a revision", () => {
    expect(liveEraStart(undefined)).toBeNull();
    expect(liveEraStart([])).toBeNull();
    expect(isBeforeLiveEra(d("2026-06-10T06:00:00Z"), null)).toBe(false);
  });

  it("is the newest revision boundary, and floors earlier slots", () => {
    const start = liveEraStart([
      { validUntil: d("2026-06-01T00:00:00Z") },
      { validUntil: d("2026-06-10T12:30:00Z") },
    ]);
    expect(start?.toISOString()).toBe("2026-06-10T12:30:00.000Z");
    expect(isBeforeLiveEra(d("2026-06-10T06:00:00Z"), start)).toBe(true);
    expect(isBeforeLiveEra(d("2026-06-10T12:30:00Z"), start)).toBe(false);
    expect(isBeforeLiveEra(d("2026-06-11T06:00:00Z"), start)).toBe(false);
  });

  it("maps a groupBy of active revisions", () => {
    const map = liveEraStartsByMedication([
      { medicationId: "a", _max: { validUntil: d("2026-06-10T12:30:00Z") } },
      { medicationId: "b", _max: { validUntil: null } },
    ]);
    expect([...map.keys()]).toEqual(["a"]);
  });
});
