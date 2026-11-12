/**
 * The sheet's fallback dirty check on two real capture forms, rendered in
 * Chromium: untouched, neither may ask "Discard?" when the sheet closes, and
 * each reads as edited once something is changed.
 *
 *   - The symptom form's intensity slider sits in a `<form>`, so Radix adds
 *     an input of its own for it, which carries a value before anyone moves
 *     the slider.
 *   - The medication dose starts as the preselected medication's own dose.
 *
 * All data invented.
 */
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { SymptomEntryForm } from "@/components/symptoms/symptom-entry-form";
import { MedicationIntakeQuickAdd } from "@/components/dashboard/medication-intake-quick-add";
import { queryKeys } from "@/lib/query-keys";

import { stubFetch } from "../../../../tests/browser/fetch-stub";
import {
  renderWithApp,
  testQueryClient,
} from "../../../../tests/browser/render";
import { sheetBodyHasUnsavedInput } from "../responsive-sheet";

const bodyOf = (element: Element) => element as HTMLElement;

describe("the sheet's dirty check on capture forms", () => {
  it("reads an untouched symptom form as clean, a moved slider as input", async () => {
    stubFetch().on("GET", /\/api\/symptoms\/definitions/, {
      data: { definitions: [] },
    });
    const { screen } = await renderWithApp(
      <div data-testid="body">
        <SymptomEntryForm />
      </div>,
    );
    const slider = screen.getByRole("slider");
    await expect.element(slider).toBeInTheDocument();
    const body = bodyOf(screen.getByTestId("body").element());

    expect(sheetBodyHasUnsavedInput(body)).toBe(false);

    await userEvent.click(slider);
    await userEvent.keyboard("{ArrowRight}");
    expect(sheetBodyHasUnsavedInput(body)).toBe(true);
  });

  it("reads the preselected medication's dose as clean, an edited dose as input", async () => {
    const queryClient = testQueryClient();
    queryClient.setQueryData(queryKeys.medications(), [
      {
        id: "med-1",
        name: "Example tablet",
        dose: "500 mg",
        active: true,
        intakeActionable: true,
        schedules: [],
        lastTakenAt: null,
      },
    ]);
    stubFetch().on("GET", "/api/settings/reminder-thresholds", {
      data: { lateMinutes: 60, missedMinutes: 240, lowStockRunwayDays: null },
    });
    const { screen } = await renderWithApp(
      <div data-testid="body">
        <MedicationIntakeQuickAdd />
      </div>,
      { queryClient },
    );
    const dose = screen.getByTestId("medication-intake-quick-add-dose");
    await expect.element(dose).toHaveValue("500 mg");
    const body = bodyOf(screen.getByTestId("body").element());

    expect(sheetBodyHasUnsavedInput(body)).toBe(false);

    await dose.fill("250 mg");
    expect(sheetBodyHasUnsavedInput(body)).toBe(true);
  });
});
