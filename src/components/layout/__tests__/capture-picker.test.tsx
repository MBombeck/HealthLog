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
    canManage: true,
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
}));

// The record's resolved module map; each test sets what it needs.
const modulesRef: { value: Record<string, boolean> | undefined } = {
  value: undefined,
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { modules: modulesRef.value } }),
}));

vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? <section>{children}</section> : null),
  sheetBodyHasUnsavedInput: () => false,
}));

vi.mock("@/components/dashboard/quick-entry-forms.lazy", () => ({
  MeasurementForm: () => <div data-testid="measurement-form" />,
  MoodForm: () => <div data-testid="mood-form" />,
  MedicationIntakeQuickAdd: () => <div data-testid="medication-form" />,
  ManualWorkoutForm: () => <div data-testid="workout-form" />,
  SymptomEntryForm: () => <div data-testid="symptom-form" />,
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
    modulesRef.value = undefined;
    const html = render();

    expect(html).toContain('data-testid="capture-picker-measurement"');
    expect(html).toContain('data-testid="capture-picker-medication"');
    expect(html).toContain('data-testid="capture-picker-mood"');
    // Water logging was removed from the app; the picker offers no water
    // entry (water arrives by sync only).
    expect(html).not.toContain('data-testid="capture-picker-water"');
  });
});

describe("<CapturePicker> — switched-off modules", () => {
  it("drops Mood with the mood module off and Medication with medications off", () => {
    modulesRef.value = { mood: false, medications: false };
    const html = render();
    expect(html).toContain('data-testid="capture-picker-measurement"');
    expect(html).not.toContain('data-testid="capture-picker-mood"');
    expect(html).not.toContain('data-testid="capture-picker-medication"');
  });

  it("keeps both while their modules are on", () => {
    modulesRef.value = { mood: true, medications: true };
    const html = render();
    expect(html).toContain('data-testid="capture-picker-mood"');
    expect(html).toContain('data-testid="capture-picker-medication"');
  });
});
