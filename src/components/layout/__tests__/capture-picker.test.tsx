import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// v1.36.x — the picker asks what the record allows before it offers a kind.
// These fixtures are the caller's own record, which is every kind; the
// delegation cases are covered in
// `src/components/__tests__/delegated-write-affordances.test.tsx`.
vi.mock("@/hooks/use-record-capabilities", async (importOriginal) => ({
  holdsOwnerRights: (
    await importOriginal<typeof import("@/hooks/use-record-capabilities")>()
  ).holdsOwnerRights,
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

// The types the person logged by hand most recently, newest first.
const recentRef: { value: string[] } = { value: [] };
vi.mock("@/components/measurements/entry/use-entry-recall", () => ({
  useRecentEntryTypes: () => recentRef.value,
}));

import { CapturePicker, captureFormDescription } from "../capture-picker";

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

describe("<CapturePicker> — recently logged types", () => {
  it("offers each recent type as its own row under Measurement", () => {
    modulesRef.value = undefined;
    recentRef.value = ["WEIGHT", "BLOOD_PRESSURE"];
    const html = render();
    const measurement = html.indexOf(
      'data-testid="capture-picker-measurement"',
    );
    const weight = html.indexOf(
      'data-testid="capture-picker-measurement-WEIGHT"',
    );
    const bp = html.indexOf(
      'data-testid="capture-picker-measurement-BLOOD_PRESSURE"',
    );
    const medication = html.indexOf('data-testid="capture-picker-medication"');
    expect(measurement).toBeGreaterThan(-1);
    expect(weight).toBeGreaterThan(measurement);
    expect(bp).toBeGreaterThan(weight);
    expect(medication).toBeGreaterThan(bp);
    expect(html).toContain(">Weight<");
    recentRef.value = [];
  });

  it("offers none before anything was logged", () => {
    modulesRef.value = undefined;
    recentRef.value = [];
    expect(render()).not.toContain("capture-picker-measurement-");
  });
});

describe("the capture form's description", () => {
  it("says what the intake sheet records, like the medications page's sheet", () => {
    const t = (key: string) => key;
    expect(captureFormDescription("medication", t)).toBe(
      "medications.intakeForm.description",
    );
    expect(captureFormDescription("mood", t)).toBeUndefined();
    expect(captureFormDescription(null, t)).toBeUndefined();
  });
});
