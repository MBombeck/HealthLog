/**
 * The settings threshold editor reads glucose in the reader's unit.
 *
 * It used to pass every glucose threshold through the identity path, so an
 * mmol/L account was shown "Default: 70–99 mg/dL" and mg/dL input fields
 * bounded at 40–400, while the insights sheet for the same threshold already
 * spoke mmol/L. The stored value stays canonical mg/dL either way.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const authUser = vi.hoisted(() => ({
  current: { glucoseUnit: "mmol/L", unitPreference: "metric" } as Record<
    string,
    unknown
  >,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: authUser.current, isAuthenticated: true }),
  useAccountOnceMounted: () => authUser.current,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    isLoading: false,
    data: {
      effective: {
        BLOOD_GLUCOSE_FASTING: {
          range: { greenMin: 72, greenMax: 108 },
          isOverride: true,
          default: { greenMin: 70, greenMax: 99 },
          bounds: { min: 40, max: 400, unit: "mg/dL" },
        },
      },
      overrides: { BLOOD_GLUCOSE_FASTING: { min: 72, max: 108 } },
    },
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ThresholdsEditorSection } from "../thresholds-editor-section";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ThresholdsEditorSection id="thresholds" />
    </I18nProvider>,
  );
}

describe("<ThresholdsEditorSection> glucose unit", () => {
  it("states the default, the fields and the bounds in mmol/L", () => {
    authUser.current = { glucoseUnit: "mmol/L", unitPreference: "metric" };
    const html = render();
    // 70–99 mg/dL is 3.9–5.5 mmol/L.
    expect(html).toMatch(/3\.9–5\.5 mmol\/L/);
    expect(html).not.toMatch(/70(\.0)?–99(\.0)? mg\/dL/);
    // The stored 72–108 mg/dL override seeds 4–6 mmol/L.
    expect(html).toContain('value="4"');
    expect(html).toContain('value="6"');
    // Inward-rounded guardrail of 40–400 mg/dL.
    expect(html).toContain('min="2.3"');
    expect(html).toContain('max="22.1"');
  });

  it("keeps mg/dL for an mg/dL reader", () => {
    authUser.current = { glucoseUnit: "mg/dL", unitPreference: "metric" };
    const html = render();
    expect(html).toMatch(/70(\.0)?–99(\.0)? mg\/dL/);
    expect(html).toContain('value="72"');
    expect(html).toContain('min="40"');
  });

  it("prints a whole-number default without a trailing .0", () => {
    // A bound reads at its own precision: the fixed one decimal printed
    // "70.0–99.0 mg/dL" and "8,000.0–15,000.0 steps".
    authUser.current = { glucoseUnit: "mg/dL", unitPreference: "metric" };
    const html = render();
    expect(html).toMatch(/70–99 mg\/dL/);
    expect(html).not.toMatch(/70\.0–99\.0/);
  });
});
