import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// v1.36.x — the picker asks what the record allows before it offers a kind.
// These fixtures are the caller's own record, which is every kind; the
// delegation cases are covered in
// `src/components/__tests__/delegated-write-affordances.test.tsx`.
vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    inSharedRecord: false,
    canWrite: false,
    canAdd: true,
    canManage: true,
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
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

import { CapturePicker } from "../capture-picker";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CapturePicker open onOpenChange={() => undefined} />
    </I18nProvider>,
  );
}

describe("<CapturePicker> — offered kinds", () => {
  it("offers measurement, medication and mood, and no water entry", () => {
    const html = render();

    expect(html).toContain('data-testid="capture-picker-measurement"');
    expect(html).toContain('data-testid="capture-picker-medication"');
    expect(html).toContain('data-testid="capture-picker-mood"');
    // Water logging was removed from the app; the picker offers no water
    // entry (water arrives by sync only).
    expect(html).not.toContain('data-testid="capture-picker-water"');
  });
});
