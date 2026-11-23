/**
 * `<ScheduleTimesEditor>`, the Schedule tab's dose-time editor, driven the
 * way a person changes a dose time: take the old time off, type the new one
 * into the add field, press Save. What reaches `PUT /api/medications/{id}` is
 * the contract.
 *
 * The add field's typed text only becomes a value when the field commits
 * (Enter or blur). A typed time that never became a chip was dropped, and a
 * save with no chip left fell back to the schedule's stored `windowStart`, so
 * the request carried the old time, the server stored it, and the tab said
 * "Schedule saved".
 *
 * Mutation checks, run: restoring the draft-only add field (a time waits for
 * the Add button) turns the first three cases red; dropping the blur flush
 * and the press-without-focus on Save turns the first red (the blur at press
 * time grows the form and the click lands off the button); adding a chip per
 * picker column instead of replacing the pending one turns the third red;
 * restoring the `windowStart` fallback in `save()` turns the last red.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import {
  stubFetch,
  type FetchStub,
} from "../../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../../tests/browser/render";
import {
  ScheduleTimesEditor,
  type EditableSchedule,
} from "../schedule-times-editor";

const ID = "med-1";
const PUT_PATH = `/api/medications/${ID}`;

const DAILY: EditableSchedule = {
  id: "sched-1",
  windowStart: "11:30",
  windowEnd: "11:30",
  label: null,
  dose: null,
  daysOfWeek: null,
  timesOfDay: ["11:30"],
  rrule: "FREQ=DAILY",
  scheduleType: "SCHEDULED",
  doseWindows: [],
};

let api: FetchStub;

beforeEach(() => {
  api = stubFetch().on("PUT", PUT_PATH, { data: { id: ID } });
});

type Put = { schedules: Array<{ timesOfDay: string[] }> };
const sentTimes = () =>
  api
    .calls("PUT", PUT_PATH)
    .map((r) => (r.body as Put).schedules.map((s) => s.timesOfDay));

async function mount() {
  const { screen } = await renderWithApp(
    <ScheduleTimesEditor
      medicationId={ID}
      schedules={[DAILY]}
      trackIntake={true}
    />,
  );
  return {
    screen,
    removeOld: () =>
      screen.getByRole("button", { name: /^Remove 11:30/ }).click(),
    draft: screen.getByTestId("times-of-day-draft-input"),
    save: screen.getByRole("button", { name: "Save schedule" }),
  };
}

describe("<ScheduleTimesEditor> changing a dose time", () => {
  it("sends the typed time when Save is pressed straight after typing", async () => {
    const { removeOld, draft, save } = await mount();
    await removeOld();
    await draft.fill("16:00");
    await save.click();
    await expect.poll(sentTimes).toEqual([[["16:00"]]]);
  });

  it("adds the typed time with one press of Add time", async () => {
    const { screen, removeOld, draft, save } = await mount();
    await removeOld();
    await draft.fill("17:45");
    await screen.getByRole("button", { name: "Add time" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Remove 05:45 PM" }))
      .toBeVisible();
    await save.click();
    await expect.poll(sentTimes).toEqual([[["17:45"]]]);
  });

  it("sends one picked time, not one per picker column, without pressing Add", async () => {
    const { screen, removeOld, save } = await mount();
    await removeOld();
    await screen.getByRole("button", { name: "Open time picker" }).click();
    const hours = screen.getByRole("group", { name: "Hours" });
    await hours.getByRole("button", { name: "4", exact: true }).click();
    await screen.getByRole("button", { name: "PM", exact: true }).click();
    const minutes = screen.getByRole("group", { name: "Minutes" });
    await minutes.getByRole("button", { name: "45", exact: true }).click();
    await userEvent.keyboard("{Escape}");
    await save.click();
    await expect.poll(sentTimes).toEqual([[["16:45"]]]);
  });

  it("sends nothing when every time was removed, instead of the stored one", async () => {
    const { screen, removeOld, save } = await mount();
    await removeOld();
    await save.click();
    await expect
      .element(screen.getByText("Add at least one time."))
      .toBeVisible();
    expect(api.calls("PUT", PUT_PATH)).toEqual([]);
  });
});
