/**
 * The edit sheet corrects a blood glucose reading's meal context (#1407): the
 * same selector as the add form, seeded with the row's context, an explicit
 * "not specified" for a reading saved without one, and the choice on the wire
 * of the PUT. A reading of any other type shows no selector and sends none.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";

import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import type { Measurement } from "../list/list-model";
import { MeasurementEditSheet } from "../list/measurement-edit-sheet";
import { useMeasurementEdit } from "../list/use-measurement-edit";
import { useMeasurementRowDisplay } from "../list/use-measurement-row-display";

let api: FetchStub;

beforeEach(() => {
  api = stubFetch().on("PUT", /^\/api\/measurements\//, {
    status: 200,
    data: {},
  });
});

const reading = (over: Partial<Measurement>): Measurement => ({
  id: "g1",
  type: "BLOOD_GLUCOSE",
  value: 95,
  unit: "mg/dL",
  source: "MANUAL",
  measuredAt: "2026-10-01T08:00:00.000Z",
  notes: null,
  glucoseContext: "FASTING",
  ...over,
});

function Harness({ measurement }: { measurement: Measurement }) {
  const display = useMeasurementRowDisplay();
  // The sheet's delete is not under test; a real mutation keeps the type.
  const deleteMutation = useMutation({
    mutationFn: async (_id: string) => {},
  });
  const edit = useMeasurementEdit({
    display,
    deleteMutation,
  });
  const { startEdit } = edit;
  useEffect(() => {
    startEdit(measurement);
    // Open once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <MeasurementEditSheet edit={edit} display={display} />;
}

async function open(measurement: Measurement) {
  const { screen } = await renderWithApp(<Harness measurement={measurement} />);
  return screen;
}

const put = () => api.calls("PUT", /^\/api\/measurements\//).map((r) => r.body);

describe("<MeasurementEditSheet> glucose context", () => {
  it("seeds the row's context and sends the corrected one", async () => {
    const screen = await open(reading({}));
    const context = screen.getByRole("combobox", { name: /^Context/ });
    await expect
      .element(context)
      .toHaveTextContent("Fasting (≥8h without food)");
    await context.click();
    await screen
      .getByRole("option", { name: "Post-meal (2h after eating)" })
      .click();
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => put().length).toBe(1);
    expect(put()[0]).toEqual({
      measuredAt: "2026-10-01T08:00:00.000Z",
      notes: null,
      glucoseContext: "POSTPRANDIAL",
    });
  });

  it("offers 'not specified' for a reading saved without a context", async () => {
    const screen = await open(
      reading({ source: "NIGHTSCOUT", glucoseContext: null }),
    );
    const context = screen.getByRole("combobox", { name: /^Context/ });
    await expect.element(context).toHaveTextContent("Not specified");
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => put().length).toBe(1);
    // An untouched value is not sent, so a sensor row's note can be saved.
    expect(put()[0]).toEqual({
      measuredAt: "2026-10-01T08:00:00.000Z",
      notes: null,
      glucoseContext: null,
    });
  });

  it("shows no selector and sends no context for another type", async () => {
    const screen = await open(
      reading({ type: "WEIGHT", unit: "kg", value: 80, glucoseContext: null }),
    );
    await screen.getByLabelText(/^Value/).fill("81");
    expect(
      screen.getByRole("combobox", { name: /^Context/ }).query(),
    ).toBeNull();
    await screen.getByRole("button", { name: "Save" }).click();

    await expect.poll(() => put().length).toBe(1);
    expect(put()[0]).toEqual({
      value: 81,
      measuredAt: "2026-10-01T08:00:00.000Z",
      notes: null,
    });
  });
});
