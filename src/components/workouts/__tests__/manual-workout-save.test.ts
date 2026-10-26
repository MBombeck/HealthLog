/**
 * The manual workout save path, and the detail page's delete.
 *
 * The rules themselves live in `manual-entry.ts` and are pinned in its own
 * suite, and the mounted form (fields, units, layout, editing) is driven in
 * `manual-workout-form.browser.test.tsx`. This one pins the save and delete
 * helpers on their own:
 *
 *   1. the save posts ONE entry to `POST /api/workouts/batch`, MANUAL, with
 *      the form's external id, and refreshes the workout reads;
 *   2. a `duplicate` (a second tap) is a success, a `skipped` entry is not;
 *   3. delete is offered for a hand-entered workout in one's own record only,
 *      and calls `DELETE /api/workouts/{id}`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";

import { saveManualWorkout, sportOptions } from "../manual-workout-form";
import {
  canDeleteWorkout,
  deleteManualWorkout,
} from "../delete-workout-button";
import type { ManualWorkoutEntry } from "@/lib/workouts/manual-entry";

const ENTRY: ManualWorkoutEntry = {
  sportType: "cycling",
  startedAt: "2026-09-15T06:00:00.000Z",
  endedAt: "2026-09-15T07:30:00.000Z",
  source: "MANUAL",
  externalId: "manual:5b0f3c1e-1111-4222-8333-444455556666",
  totalDistanceM: 32000,
};

function envelope(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeClient() {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
    removeQueries: vi.fn(),
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveManualWorkout — the wire", () => {
  it("posts one MANUAL entry with the form's external id to the batch route", async () => {
    fetchSpy.mockResolvedValue(
      envelope({ entries: [{ index: 0, status: "inserted" }] }),
    );
    const client = fakeClient();

    const outcome = await saveManualWorkout(
      ENTRY,
      client as unknown as QueryClient,
    );

    expect(outcome).toBe("inserted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("/api/workouts/batch");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ workouts: [ENTRY] });
    expect(body.workouts[0].source).toBe("MANUAL");
    expect(body.workouts[0].externalId).toBe(ENTRY.externalId);
  });

  it("refreshes every workout read, and the daily reads", async () => {
    fetchSpy.mockResolvedValue(
      envelope({ entries: [{ index: 0, status: "inserted" }] }),
    );
    const client = fakeClient();

    await saveManualWorkout(ENTRY, client as unknown as QueryClient);

    const keys = client.invalidateQueries.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(queryKeys.workouts()));
    expect(keys).toContain(JSON.stringify(queryKeys.dailyDigest()));
    expect(keys).toContain(JSON.stringify(queryKeys.dashboardSnapshot()));
  });

  it("treats a duplicate (the same form submitted twice) as saved", async () => {
    fetchSpy.mockResolvedValue(
      envelope({ entries: [{ index: 0, status: "duplicate" }] }),
    );

    await expect(
      saveManualWorkout(ENTRY, fakeClient() as unknown as QueryClient),
    ).resolves.toBe("duplicate");
  });

  it("treats an edited resubmit (`updated`) as saved and refreshes", async () => {
    fetchSpy.mockResolvedValue(
      envelope({ entries: [{ index: 0, status: "updated" }] }),
    );
    const client = fakeClient();

    await expect(
      saveManualWorkout(ENTRY, client as unknown as QueryClient),
    ).resolves.toBe("updated");
    expect(client.invalidateQueries).toHaveBeenCalled();
  });

  it("throws when the route skipped the entry, and refreshes nothing", async () => {
    fetchSpy.mockResolvedValue(
      envelope({ entries: [{ index: 0, status: "skipped" }] }),
    );
    const client = fakeClient();

    await expect(
      saveManualWorkout(ENTRY, client as unknown as QueryClient),
    ).rejects.toThrow();
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("sportOptions", () => {
  it("lists every sport by label, with Other last", () => {
    const options = sportOptions((sport) => sport.toUpperCase());
    expect(options).toHaveLength(21);
    expect(options.at(-1)).toEqual({ value: "other", label: "OTHER" });
    const labels = options.slice(0, -1).map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });
});

describe("delete — a hand-entered workout in one's own record only", () => {
  it("is offered for a MANUAL workout in one's own record", () => {
    expect(
      canDeleteWorkout({ source: "MANUAL" }, { inSharedRecord: false }),
    ).toBe(true);
  });

  it.each([
    "APPLE_HEALTH",
    "WITHINGS",
    "WHOOP",
    "FITBIT",
    "STRAVA",
    "EXTERNAL",
  ])("is not offered for a %s workout", (source) => {
    expect(canDeleteWorkout({ source }, { inSharedRecord: false })).toBe(false);
  });

  it("is not offered inside somebody else's record", () => {
    expect(
      canDeleteWorkout({ source: "MANUAL" }, { inSharedRecord: true }),
    ).toBe(false);
  });

  it("calls DELETE on the workout and drops its detail from the cache", async () => {
    fetchSpy.mockResolvedValue(envelope({ deleted: true }));
    const client = fakeClient();

    await deleteManualWorkout("w-1", client as unknown as QueryClient);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("/api/workouts/w-1");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(client.removeQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.workoutDetail("w-1"),
    });
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.workouts(),
    });
  });
});
