import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const moduleGate = vi.hoisted(() => ({ nutrientsEnabled: true }));

vi.mock("@/hooks/use-module-enabled", () => ({
  useModuleEnabled: (moduleKey: string) =>
    moduleKey === "nutrients" ? moduleGate.nutrientsEnabled : true,
}));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <section>{children}</section> : null),
}));

vi.mock("@/components/measurements/measurement-form", () => ({
  MeasurementForm: () => <div data-testid="measurement-form" />,
}));

vi.mock("@/components/mood/mood-form", () => ({
  MoodForm: () => <div data-testid="mood-form" />,
}));

vi.mock("@/components/dashboard/medication-intake-quick-add", () => ({
  MedicationIntakeQuickAdd: () => <div data-testid="medication-form" />,
}));

vi.mock("@/components/insights/nutrients/water-quick-add-sheet", () => ({
  WaterQuickAddSheet: () => <div data-testid="water-quick-add-sheet" />,
}));

import { CapturePicker } from "../capture-picker";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CapturePicker open onOpenChange={() => undefined} />
    </I18nProvider>,
  );
}

describe("<CapturePicker> — nutrients module gate", () => {
  it("hides and unmounts only water capture when nutrients are disabled", () => {
    moduleGate.nutrientsEnabled = false;

    const html = render();

    expect(html).not.toContain('data-testid="capture-picker-water"');
    expect(html).not.toContain('data-testid="water-quick-add-sheet"');
    expect(html).toContain('data-testid="capture-picker-measurement"');
    expect(html).toContain('data-testid="capture-picker-medication"');
    expect(html).toContain('data-testid="capture-picker-mood"');
  });

  it("keeps water capture available when nutrients are enabled", () => {
    moduleGate.nutrientsEnabled = true;

    const html = render();

    expect(html).toContain('data-testid="capture-picker-water"');
    expect(html).not.toContain('data-testid="water-quick-add-sheet"');
  });
});
