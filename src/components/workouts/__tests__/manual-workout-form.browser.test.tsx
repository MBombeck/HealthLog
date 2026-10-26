/**
 * `<ManualWorkoutForm>`, the quick-entry sheet's workout form, driven by
 * picking, typing and pressing Save. The entry rules live in
 * `manual-entry.ts` and its own suite; this one pins what the person sees
 * and what reaches `POST /api/workouts/batch`: the field errors, the distance
 * asked in the reader's unit and sent in metres, the start counted back from
 * now, the pending state, and one external id per opened form.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import type { AuthUser } from "@/hooks/use-auth";
import { manualWorkoutOriginalFromRow } from "@/lib/workouts/manual-entry";

import { pinDate } from "../../../../tests/browser/clock";
import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { ManualWorkoutForm } from "../manual-workout-form";

const NOW = "2026-09-15T10:00:00.000Z";
const BATCH = "/api/workouts/batch";

let api: FetchStub;

beforeEach(() => {
  pinDate(NOW);
  api = stubFetch().on("POST", BATCH, {
    data: { entries: [{ index: 0, status: "inserted" }] },
  });
});

async function mount(
  props: Parameters<typeof ManualWorkoutForm>[0] = {},
  user: Partial<AuthUser> = {},
) {
  const onSuccess = vi.fn();
  const { screen } = await renderWithApp(
    <ManualWorkoutForm onSuccess={onSuccess} onCancel={() => {}} {...props} />,
    { user },
  );
  const save = screen.getByRole("button", { name: "Save" });
  const pickSport = async (name: string) => {
    await screen.getByRole("combobox", { name: /^Activity/ }).click();
    await screen.getByRole("option", { name }).click();
  };
  return { screen, onSuccess, save, pickSport };
}

type Posted = { workouts: Array<Record<string, unknown>> };
const posted = () => api.calls("POST", BATCH).map((r) => r.body as Posted);

describe("<ManualWorkoutForm>", () => {
  it("names what is missing under each field and sends nothing", async () => {
    const { screen, save } = await mount();
    await save.click();
    await expect.element(screen.getByText("Choose an activity.")).toBeVisible();
    await expect
      .element(screen.getByText("Enter how long the workout lasted."))
      .toBeVisible();
    await expect
      .element(screen.getByLabelText("Hours"))
      .toHaveAttribute("aria-invalid", "true");
    expect(api.requests).toEqual([]);
  });

  it("asks an imperial reader for miles and sends metres, counted back from now", async () => {
    const { screen, save, onSuccess, pickSport } = await mount(
      {},
      { unitPreference: "imperial" },
    );
    await pickSport("Running");
    await screen.getByLabelText("Hours").fill("1");
    await screen.getByLabelText("Minutes").fill("30");
    await screen.getByLabelText("Distance (mi)").fill("10");
    await screen.getByLabelText("Active energy (kcal)").fill("640");
    await save.click();

    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    const [body] = posted();
    expect(body.workouts).toHaveLength(1);
    expect(body.workouts[0]).toEqual({
      sportType: "running",
      startedAt: "2026-09-15T08:30:00.000Z",
      endedAt: NOW,
      source: "MANUAL",
      externalId: expect.stringMatching(/^manual:/),
      totalDistanceM: 16093.4,
      totalEnergyKcal: 640,
    });
  });

  it("asks a metric reader for kilometres", async () => {
    const { screen, save, onSuccess, pickSport } = await mount();
    await pickSport("Cycling");
    await screen.getByLabelText("Minutes").fill("45");
    await screen.getByLabelText("Distance (km)").fill("21,5");
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    expect(posted()[0].workouts[0]).toMatchObject({
      sportType: "cycling",
      startedAt: "2026-09-15T09:15:00.000Z",
      totalDistanceM: 21500,
    });
  });

  it("holds Save while the write is pending, then reports it once", async () => {
    const pending = api.deferred("POST", BATCH);
    const { screen, save, onSuccess, pickSport } = await mount();
    await pickSport("Yoga");
    await screen.getByLabelText("Minutes").fill("20");
    await save.click();

    await expect.element(save).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Cancel" }))
      .toBeDisabled();
    pending.release({ data: { entries: [{ index: 0, status: "inserted" }] } });
    await expect.element(save).toBeEnabled();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("retries a failed save under the same external id", async () => {
    api.on("POST", BATCH, { status: 503, error: "Service unavailable" });
    const { screen, save, onSuccess, pickSport } = await mount();
    await pickSport("Running");
    await screen.getByLabelText("Minutes").fill("30");
    await save.click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Service unavailable");
    expect(onSuccess).not.toHaveBeenCalled();

    api.on("POST", BATCH, {
      data: { entries: [{ index: 0, status: "duplicate" }] },
    });
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    const [first, second] = posted();
    expect(second.workouts[0].externalId).toBe(first.workouts[0].externalId);
  });

  it("lays out for a phone: duration side by side, distance over energy", async () => {
    await page.viewport(390, 844);
    const { screen, save } = await mount();
    const top = (label: string) =>
      screen.getByLabelText(label).element().getBoundingClientRect().top;
    expect(top("Hours")).toBe(top("Minutes"));
    expect(top("Active energy (kcal)")).toBeGreaterThan(top("Distance (km)"));
    expect(
      save.element().getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
    // A record, not a training log: no heart rate, sets or route to fill in.
    await expect
      .element(screen.getByText(/heart|bpm|sets|reps/i))
      .not.toBeInTheDocument();
  });

  it("opens an edit on the stored values and re-posts them unchanged", async () => {
    const original = manualWorkoutOriginalFromRow(
      {
        sportType: "cycling",
        startedAt: "2026-09-14T06:00:00.000Z",
        endedAt: "2026-09-14T07:30:00.000Z",
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
      { timezone: "UTC", unitPreference: "metric" },
    );
    const externalId = "manual:5b0f3c1e-1111-4222-8333-444455556666";
    api.on("POST", BATCH, {
      data: { entries: [{ index: 0, status: "updated" }] },
    });
    const { screen, save, onSuccess } = await mount({
      edit: { externalId, original },
    });
    await expect
      .element(screen.getByRole("combobox", { name: /^Activity/ }))
      .toHaveTextContent("Cycling");
    await expect.element(screen.getByLabelText("Hours")).toHaveValue("1");
    await expect.element(screen.getByLabelText("Minutes")).toHaveValue("30");
    await expect
      .element(screen.getByLabelText("Distance (km)"))
      .toHaveValue("32");
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    expect(posted()[0].workouts[0]).toMatchObject({
      externalId,
      startedAt: "2026-09-14T06:00:00.000Z",
      endedAt: "2026-09-14T07:30:00.000Z",
      totalDistanceM: 32000,
      totalEnergyKcal: 640,
      avgHeartRate: 131,
    });
  });
});
