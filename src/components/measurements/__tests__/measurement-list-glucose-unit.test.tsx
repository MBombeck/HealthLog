import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The measurements list and the blood-glucose display unit.
 *
 * Glucose is stored in mg/dL and rendered in the unit the account chose.
 * The list is not part of the metric/imperial transform registry, so
 * without a branch of its own a reader on mmol/L would see the dashboard
 * tile say 5.3 and this list say 95 for the same reading.
 *
 * The edit sheet is the half that could do damage: its label follows the
 * same resolution, so the number in the input is in the displayed unit and
 * has to be inverted before the PATCH. Display and inversion are asserted
 * together on purpose — converting one without the other rewrites a
 * 95 mg/dL reading as 5.3 the first time somebody corrects a typo.
 */

const rows = [
  {
    id: "m1",
    type: "BLOOD_GLUCOSE",
    value: 95,
    unit: "mg/dL",
    source: "MANUAL",
    measuredAt: "2026-05-15T10:00:00.000Z",
    notes: null,
  },
];

let glucoseUnit: string | null = null;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { measurements: rows, meta: { total: 1 } },
    isLoading: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/measurements",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "USER", glucoseUnit },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementList } from "../measurement-list";
import type { UnitDisplay } from "@/hooks/use-unit-display";
import { convertGlucose, toCanonicalMgdl } from "@/lib/glucose";
import { getUnitForType } from "@/lib/measurements/unit-map";
import { editSeedValue, storedValueFor } from "../list/use-measurement-edit";
import { rowDisplayFor } from "../list/use-measurement-row-display";

/** A metric reader on the given glucose unit, as the list's row display. */
function displayOn(glucoseUnit: "mg/dL" | "mmol/L") {
  const unitDisplay = {
    preference: "metric",
    isTransformed: () => false,
    toDisplay: (_type: string, v: number) => v,
    fromDisplay: (_type: string, v: number) => v,
    unitFor: (type: string) => getUnitForType(type),
  } as unknown as UnitDisplay;
  return rowDisplayFor(glucoseUnit, unitDisplay);
}

const glucose = (value: number) => ({
  id: "g1",
  type: "BLOOD_GLUCOSE",
  value,
  unit: "mg/dL",
  source: "MANUAL",
  measuredAt: "2026-10-01T08:00:00.000Z",
  notes: null,
});

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementList />
    </I18nProvider>,
  );
}

describe("MeasurementList — blood-glucose display unit", () => {
  it("shows the stored mg/dL reading as it stands for an mg/dL account", () => {
    glucoseUnit = null;
    const html = render();
    expect(html).toContain("95");
    expect(html).toContain("mg/dL");
    expect(html).not.toContain("mmol/L");
  });

  it("converts the same reading for an mmol/L account", () => {
    glucoseUnit = "mmol/L";
    const html = render();
    // 95 mg/dL ÷ 18.0182 = 5.3 mmol/L.
    expect(html).toContain("5.3");
    expect(html).toContain("mmol/L");
    expect(html).not.toContain("95 mg/dL");
  });

  it("inverts an edited glucose value back to mg/dL before the save", () => {
    // The label above the input says mmol/L, so the number in it is mmol/L;
    // sent on unconverted it would rewrite a 95 mg/dL reading as 5.3.
    const stored = storedValueFor(displayOn("mmol/L"), glucose(95), 5.3);
    expect(stored).toBe(toCanonicalMgdl(5.3, "mmol/L"));
    expect(stored).toBeGreaterThan(90);
  });

  it("seeds the edit input in the unit its own label names", () => {
    const display = displayOn("mmol/L");
    expect(editSeedValue(display, glucose(95))).toBe(
      convertGlucose(95, "mmol/L"),
    );
    expect(display.rowDisplay(glucose(95)).unit).toBe("mmol/L");
  });

  it("leaves an mg/dL edit on the identity path so a note fix cannot round the value", () => {
    // `toCanonicalMgdl(v, "mg/dL")` rounds, so routing the mg/dL branch
    // through it would quantise a stored 95.48 on an unrelated edit.
    const display = displayOn("mg/dL");
    expect(display.editsConvertedGlucose(glucose(95.48))).toBe(false);
    expect(editSeedValue(display, glucose(95.48))).toBe(95.48);
    expect(storedValueFor(display, glucose(95.48), 95.48)).toBe(95.48);
  });
});
