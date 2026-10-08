/**
 * `<ManualWorkoutForm>` and its save path, and the detail page's delete.
 *
 * SSR-only, like the other capture-form suites (vitest runs in `node`, no
 * testing-library). The rules themselves live in `manual-entry.ts` and are
 * pinned in its own suite; this one pins the wire and the markup:
 *
 *   1. the save posts ONE entry to `POST /api/workouts/batch`, MANUAL, with
 *      the form's external id, and refreshes the workout reads;
 *   2. a `duplicate` (a second tap) is a success, a `skipped` entry is not;
 *   3. the form renders its five fields, the distance in the reader's unit,
 *      and a layout that stacks distance / energy on a phone;
 *   4. delete is offered for a hand-entered workout in one's own record only,
 *      and calls `DELETE /api/workouts/{id}`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryClient } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const authRef: { unitPreference: "metric" | "imperial" } = {
  unitPreference: "metric",
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      username: "tester",
      timezone: "Europe/Berlin",
      unitPreference: authRef.unitPreference,
    },
  }),
}));

import {
  ManualWorkoutForm,
  saveManualWorkout,
  sportOptions,
} from "../manual-workout-form";
import {
  canDeleteWorkout,
  deleteManualWorkout,
} from "../delete-workout-button";
import {
  manualWorkoutOriginalFromRow,
  type ManualWorkoutEntry,
} from "@/lib/workouts/manual-entry";

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

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  authRef.unitPreference = "metric";
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

describe("<ManualWorkoutForm> — markup", () => {
  it("renders the five fields and nothing else", () => {
    const html = render(<ManualWorkoutForm />);
    expect(html).toContain('data-testid="manual-workout-sport"');
    expect(html).toContain('data-testid="manual-workout-start"');
    expect(html).toContain('data-testid="manual-workout-hours"');
    expect(html).toContain('data-testid="manual-workout-minutes"');
    expect(html).toContain('data-testid="manual-workout-distance"');
    expect(html).toContain('data-testid="manual-workout-energy"');
    expect(html).toContain("Activity");
    expect(html).toContain("Duration");
    expect(html).toContain("Active energy (kcal)");
    // No heart rate, no sets, no route: a record, not a training log.
    expect(html).not.toMatch(/heart|bpm|sets|reps/i);
  });

  it("names the distance in kilometres for a metric reader", () => {
    expect(render(<ManualWorkoutForm />)).toContain("Distance (km)");
  });

  it("names the distance in miles for an imperial reader", () => {
    authRef.unitPreference = "imperial";
    expect(render(<ManualWorkoutForm />)).toContain("Distance (mi)");
  });

  it("keeps hours and minutes side by side and stacks distance and energy on a phone", () => {
    const html = render(<ManualWorkoutForm />);
    // Two short numeric fields fit a 390 px sheet side by side.
    expect(html).toMatch(/class="grid grid-cols-2 gap-4"/);
    // Distance and energy carry longer labels: one column below `sm`, two
    // from 640 px up.
    expect(html).toMatch(/class="grid gap-4 sm:grid-cols-2"/);
    // The action buttons keep the 44 px touch floor on a phone.
    expect(html).toContain("min-h-11 sm:min-h-9");
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

describe("<ManualWorkoutForm> — editing a stored workout (#1162)", () => {
  const original = manualWorkoutOriginalFromRow(
    {
      sportType: "cycling",
      startedAt: "2026-09-15T06:00:00.000Z",
      endedAt: "2026-09-15T07:30:00.000Z",
      durationSec: 5400,
      distanceM: 32000,
      activeEnergyKcal: 640,
      minHr: null,
      stepCount: null,
      elevationM: null,
      pauseDurationSec: null,
      storedAvgHr: 131,
      storedMaxHr: null,
    },
    { timezone: "Europe/Berlin", unitPreference: "metric" },
  );

  it("opens on the stored values", () => {
    const html = render(
      <ManualWorkoutForm edit={{ externalId: ENTRY.externalId, original }} />,
    );
    expect(html).toContain('value="2026-09-15T08:00"');
    expect(html).toContain('value="1"');
    expect(html).toContain('value="30"');
    expect(html).toContain('value="32"');
    expect(html).toContain('value="640"');
  });

  it("opens empty when it is not editing", () => {
    const html = render(<ManualWorkoutForm />);
    expect(html).not.toContain('value="640"');
  });
});
