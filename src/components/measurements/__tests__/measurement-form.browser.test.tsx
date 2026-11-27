/**
 * `<MeasurementForm>` driven by typing and pressing Save, with the request
 * body read off the network boundary. What the markup tests could only pin
 * against the source is asserted on the wire here: a weight typed in lb, a
 * glucose typed in mmol/L and a sleep typed as "7:30" each arrive in their
 * canonical unit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { AuthUser } from "@/hooks/use-auth";

import { pinDate } from "../../../../tests/browser/clock";
import {
  stubFetch,
  type FetchStub,
} from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { defaultGlucoseContext } from "@/lib/measurements/glucose-context-default";

import { MeasurementForm } from "../measurement-form";

const NOW = "2026-09-15T10:00:00.000Z";

let api: FetchStub;

beforeEach(() => {
  pinDate(NOW);
  api = stubFetch()
    .on("POST", "/api/measurements", { status: 201, data: { id: "m1" } })
    // The form's own reads: recent manual types and the type's last reading.
    .on("GET", /^\/api\/measurements\?/, { data: { measurements: [] } });
});

/** Every request but the form's reads. */
const writes = () => api.requests.filter((r) => r.method !== "GET");

/** A stored reading as the list route answers it. */
const reading = (type: string, value: number, unit: string, at: string) => ({
  id: `${type}-${at}`,
  type,
  value,
  unit,
  source: "MANUAL",
  measuredAt: at,
  notes: null,
});

async function mount(
  props: Parameters<typeof MeasurementForm>[0] = {},
  user: Partial<AuthUser> = {},
) {
  const onSuccess = vi.fn();
  const { screen } = await renderWithApp(
    <MeasurementForm onSuccess={onSuccess} onCancel={() => {}} {...props} />,
    { user },
  );
  const save = screen.getByRole("button", { name: "Save" });
  return { screen, onSuccess, save };
}

const posted = () => api.calls("POST", "/api/measurements").map((r) => r.body);

describe("<MeasurementForm> blood pressure", () => {
  it("sends systolic, diastolic and pulse as one batch at the chosen instant", async () => {
    const { screen, save, onSuccess } = await mount({
      defaultType: "BLOOD_PRESSURE",
    });
    await screen.getByLabelText(/^Systolic/).fill("128");
    await screen.getByLabelText(/^Diastolic/).fill("84");
    await screen.getByLabelText(/^Pulse/).fill("66");
    await screen.getByLabelText(/^Note/).fill("after the stairs");
    await save.click();

    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    const at = NOW;
    expect(posted()).toEqual([
      [
        {
          type: "BLOOD_PRESSURE_SYS",
          value: 128,
          measuredAt: at,
          notes: "after the stairs",
        },
        {
          type: "BLOOD_PRESSURE_DIA",
          value: 84,
          measuredAt: at,
          notes: "after the stairs",
        },
        { type: "PULSE", value: 66, measuredAt: at, notes: "after the stairs" },
      ],
    ]);
    // Only the write: nothing else in the cache needed refetching.
    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/measurements",
    ]);
    await expect.element(screen.getByLabelText(/^Systolic/)).toHaveValue(null);
  });

  it("leaves the pulse out when it was not typed", async () => {
    const { screen, save, onSuccess } = await mount({
      defaultType: "BLOOD_PRESSURE",
    });
    await screen.getByLabelText(/^Systolic/).fill("118");
    await screen.getByLabelText(/^Diastolic/).fill("76");
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    const [batch] = posted() as Array<Array<{ type: string }>>;
    expect(batch.map((e) => e.type)).toEqual([
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ]);
  });

  it("sends nothing while a required reading is missing", async () => {
    const { screen, save, onSuccess } = await mount({
      defaultType: "BLOOD_PRESSURE",
    });
    await screen.getByLabelText(/^Diastolic/).fill("80");
    await save.click();
    const sys = screen
      .getByLabelText(/^Systolic/)
      .element() as HTMLInputElement;
    expect(sys.validity.valueMissing).toBe(true);
    expect(writes()).toEqual([]);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("holds Save and the menu while the write is pending", async () => {
    const pending = api.deferred("POST", "/api/measurements");
    const { screen, save, onSuccess } = await mount({
      defaultType: "BLOOD_PRESSURE",
    });
    await screen.getByLabelText(/^Systolic/).fill("120");
    await screen.getByLabelText(/^Diastolic/).fill("80");
    await save.click();

    await expect.element(save).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "More options" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Cancel" }))
      .toBeDisabled();
    expect(onSuccess).not.toHaveBeenCalled();

    pending.release({ status: 201, data: {} });
    await expect.element(save).toBeEnabled();
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("names a refused write in the reader's words and keeps what was typed", async () => {
    api.on("POST", "/api/measurements", {
      status: 409,
      error: "Duplicate measurement",
      meta: { errorCode: "measurement.duplicate_timestamp" },
    });
    const { screen, save, onSuccess } = await mount({
      defaultType: "BLOOD_PRESSURE",
    });
    await screen.getByLabelText(/^Systolic/).fill("120");
    await screen.getByLabelText(/^Diastolic/).fill("80");
    await save.click();

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("A measurement already exists for this time.");
    await expect
      .element(screen.getByLabelText(/^Systolic/))
      .toHaveAttribute("aria-invalid", "true");
    await expect.element(screen.getByLabelText(/^Systolic/)).toHaveValue(120);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("<MeasurementForm> units on the way out", () => {
  it("asks an imperial reader for lb and stores kg", async () => {
    const { screen, save, onSuccess } = await mount(
      { defaultType: "WEIGHT" },
      { unitPreference: "imperial" },
    );
    const field = screen.getByLabelText("Value (lb)");
    // No reading yet: no stranger's example number either.
    await expect.element(field).not.toHaveAttribute("placeholder");
    await field.fill("210");
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    expect(posted()).toEqual([
      { type: "WEIGHT", value: 95.25, measuredAt: NOW },
    ]);
  });

  it("reads a decimal comma for a metric reader", async () => {
    const { screen, save, onSuccess } = await mount({ defaultType: "WEIGHT" });
    const field = screen.getByLabelText("Value (kg)");
    await field.fill("75,5");
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    expect(posted()).toEqual([
      { type: "WEIGHT", value: 75.5, measuredAt: NOW },
    ]);
  });

  it("asks in mg/dL for an account that never chose a glucose unit", async () => {
    const { screen, save, onSuccess } = await mount({
      defaultType: "BLOOD_GLUCOSE",
    });
    const field = screen.getByLabelText("Value (mg/dL)");
    await field.fill("104");
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    expect(posted()).toEqual([
      {
        type: "BLOOD_GLUCOSE",
        value: 104,
        measuredAt: NOW,
        // The context follows the hour of the reading, not a fixed default.
        glucoseContext: defaultGlucoseContext(new Date(NOW)),
      },
    ]);
  });

  it("asks a mmol/L reader in mmol/L, stores mg/dL and sends the meal context", async () => {
    const { screen, save, onSuccess } = await mount(
      { defaultType: "BLOOD_GLUCOSE" },
      { glucoseUnit: "mmol/L" },
    );
    const field = screen.getByLabelText("Value (mmol/L)");
    await field.fill("5.5");
    await screen.getByRole("combobox", { name: /^Context/ }).click();
    await screen
      .getByRole("option", { name: "Post-meal (2h after eating)" })
      .click();
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    expect(posted()).toEqual([
      {
        type: "BLOOD_GLUCOSE",
        value: 99,
        measuredAt: NOW,
        glucoseContext: "POSTPRANDIAL",
      },
    ]);
  });

  it("reads a sleep typed as hours and minutes and stores minutes", async () => {
    const { screen, save, onSuccess } = await mount({
      defaultType: "SLEEP_DURATION",
    });
    await screen.getByLabelText("Value (hours)").fill("7:30");
    await expect.element(screen.getByText("Read as 7 h 30 min")).toBeVisible();
    await save.click();
    await expect.poll(() => onSuccess.mock.calls.length).toBe(1);
    expect(posted()).toEqual([
      { type: "SLEEP_DURATION", value: 450, measuredAt: NOW },
    ]);
  });

  it("refuses a duration it cannot read, under the field", async () => {
    const { screen, save } = await mount({ defaultType: "SLEEP_DURATION" });
    const field = screen.getByLabelText("Value (hours)");
    await field.fill("most of the night");
    await save.click();
    await expect
      .element(screen.getByText("Enter a duration like 7.5, 7:30 or 7h 30m."))
      .toBeVisible();
    await expect.element(field).toHaveAttribute("aria-invalid", "true");
    expect(writes()).toEqual([]);
    await field.fill("7.5");
    await expect
      .element(screen.getByText("Enter a duration like 7.5, 7:30 or 7h 30m."))
      .not.toBeInTheDocument();
  });
});

describe("<MeasurementForm> type", () => {
  it("relabels the value field when the type changes", async () => {
    const { screen } = await mount({ defaultType: "WEIGHT" });
    await screen.getByRole("combobox", { name: /^Type/ }).click();
    await screen.getByRole("option", { name: "Body temperature" }).click();
    await expect.element(screen.getByLabelText("Value (°C)")).toBeVisible();
    await screen.getByRole("combobox", { name: /^Type/ }).click();
    await screen.getByRole("option", { name: "Blood pressure" }).click();
    await expect.element(screen.getByLabelText(/^Systolic/)).toBeVisible();
  });

  it("does not open on, or offer, a type whose module is off", async () => {
    const { screen } = await mount(
      { defaultType: "BLOOD_GLUCOSE" },
      { modules: { glucose: false } },
    );
    const type = screen.getByRole("combobox", { name: /^Type/ });
    await expect.element(type).toHaveTextContent("Blood pressure");
    await type.click();
    await expect
      .element(screen.getByRole("option", { name: "Weight" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("option", { name: "Blood glucose" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
  });

  it("opens on the type saved last by hand when no type is asked for", async () => {
    api.on("GET", /^\/api\/measurements\?sourceEq=MANUAL/, {
      data: {
        measurements: [
          reading("WEIGHT", 82.3, "kg", "2026-09-15T07:00:00.000Z"),
          reading("BLOOD_GLUCOSE", 95, "mg/dL", "2026-09-14T07:00:00.000Z"),
        ],
      },
    });
    const { screen } = await mount();
    await expect
      .element(screen.getByRole("combobox", { name: /^Type/ }))
      .toHaveTextContent("Weight");
    // Read from the person's readings, never kept in browser storage.
    expect(Object.values(window.localStorage)).not.toContain("WEIGHT");
  });

  it("clears every field from the menu's Reset", async () => {
    const { screen } = await mount({ defaultType: "BLOOD_PRESSURE" });
    await screen.getByLabelText(/^Systolic/).fill("120");
    await screen.getByLabelText(/^Note/).fill("left arm");
    await screen.getByRole("button", { name: "More options" }).click();
    await screen.getByRole("menuitem", { name: "Reset form" }).click();
    await expect.element(screen.getByLabelText(/^Systolic/)).toHaveValue(null);
    await expect.element(screen.getByLabelText(/^Note/)).toHaveValue("");
  });
});

describe("<MeasurementForm> the person's own habits", () => {
  it("focuses the value field, or systolic, when it opens", async () => {
    const weight = await mount({ defaultType: "WEIGHT" });
    await expect
      .element(weight.screen.getByLabelText("Value (kg)"))
      .toHaveFocus();
    await weight.screen.unmount();
    const bp = await mount({ defaultType: "BLOOD_PRESSURE" });
    await expect.element(bp.screen.getByLabelText(/^Systolic/)).toHaveFocus();
  });

  it("shows the last reading as the placeholder, and a check only when far off", async () => {
    api.on("GET", /^\/api\/measurements\?type=WEIGHT/, {
      data: {
        measurements: [
          reading("WEIGHT", 82.3, "kg", "2026-09-12T08:00:00.000Z"),
        ],
      },
    });
    const { screen } = await mount({ defaultType: "WEIGHT" });
    const field = screen.getByLabelText("Value (kg)");
    await expect.element(field).toHaveAttribute("placeholder", "82.3");
    // No line of its own under the field: add and edit look the same.
    await expect
      .element(screen.getByText(/Last 82\.3 kg/))
      .not.toBeInTheDocument();
    await field.fill("8.23");
    await expect
      .element(screen.getByText(/Quite different from your last reading/))
      .toBeVisible();
    await field.fill("82.9");
    await expect
      .element(screen.getByText(/Quite different from your last reading/))
      .not.toBeInTheDocument();
  });

  it("lists recently logged types first and saves on to the next one", async () => {
    api.on("GET", /^\/api\/measurements\?sourceEq=MANUAL/, {
      data: {
        measurements: [
          reading("WEIGHT", 82.3, "kg", "2026-09-15T07:00:00.000Z"),
          reading(
            "BLOOD_PRESSURE_SYS",
            120,
            "mmHg",
            "2026-09-14T07:00:00.000Z",
          ),
          reading("BLOOD_PRESSURE_DIA", 80, "mmHg", "2026-09-14T07:00:00.000Z"),
        ],
      },
    });
    const { screen, onSuccess } = await mount({
      defaultType: "WEIGHT",
      chain: true,
    });
    const type = screen.getByRole("combobox", { name: /^Type/ });
    await type.click();
    const options = screen.getByRole("option").elements();
    expect(options.slice(0, 2).map((o) => o.textContent)).toEqual([
      "Weight",
      "Blood pressure",
    ]);
    await userEvent.keyboard("{Escape}");

    await screen.getByLabelText("Value (kg)").fill("82.1");
    await screen.getByTestId("measurement-save-next").click();
    await expect.element(screen.getByLabelText(/^Systolic/)).toBeVisible();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(posted()).toEqual([
      { type: "WEIGHT", value: 82.1, measuredAt: NOW },
    ]);
  });

  it("offers no next value outside a capture sheet", async () => {
    const { screen } = await mount({ defaultType: "WEIGHT" });
    await expect
      .element(screen.getByTestId("measurement-save-next"))
      .not.toBeInTheDocument();
  });
});
