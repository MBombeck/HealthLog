/**
 * The one intake form. The medications page, the dose history and the
 * capture sheet render the same fields, and the form says where a dose will
 * count before it is saved instead of asking afterwards.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
  useActiveRecordName: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  IntakeFormFields,
  useIntakeFormState,
  type IntakeFormMedication,
} from "@/components/medications/intake-form/intake-form";
import {
  attributeIntake,
  classifyTake,
  nearestSlotForTake,
  slotFieldsOf,
} from "@/components/medications/intake-form/slot-attribution";

describe("nearestSlotForTake / classifyTake", () => {
  it("finds the closest slot on the take's own day with the gap in minutes", () => {
    const near = nearestSlotForTake("2026-06-01T08:30", ["07:00", "19:00"]);
    expect(near?.slotHm).toBe("07:00");
    expect(near?.gapMinutes).toBe(90);
  });

  it("returns null for a medication without dose times", () => {
    expect(nearestSlotForTake("2026-06-01T08:30", [])).toBeNull();
  });

  it("classifies exact, near and extra takes", () => {
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T07:30", ["07:00"])),
    ).toBe("exact");
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T09:00", ["07:00"])),
    ).toBe("near");
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T14:00", ["07:00"])),
    ).toBe("extra");
    expect(classifyTake(null)).toBe("extra");
  });
});

describe("attributeIntake", () => {
  it("binds a take in the window to its slot", () => {
    const a = attributeIntake({
      takenAtLocal: "2026-06-01T07:20",
      times: ["07:00"],
      skipped: false,
      countNear: true,
    });
    expect(a.kind).toBe("slot");
    expect(Object.keys(slotFieldsOf(a))).toEqual(["scheduledFor"]);
  });

  it("pins a near take to the slot as late, unless switched off", () => {
    const late = attributeIntake({
      takenAtLocal: "2026-06-01T09:30",
      times: ["07:00"],
      skipped: false,
      countNear: true,
    });
    expect(late.kind).toBe("late");
    expect(Object.keys(slotFieldsOf(late))).toEqual(["forceSlotInstant"]);
    const extra = attributeIntake({
      takenAtLocal: "2026-06-01T09:30",
      times: ["07:00"],
      skipped: false,
      countNear: false,
    });
    expect(extra.kind).toBe("extra");
    expect(slotFieldsOf(extra)).toEqual({});
  });

  it("names the slot a skip skips", () => {
    const a = attributeIntake({
      takenAtLocal: "2026-06-01T18:00",
      times: ["07:00", "19:00"],
      skipped: true,
      countNear: true,
    });
    expect(a.kind).toBe("skip");
    expect(a.kind === "skip" && a.slot.slotHm).toBe("19:00");
  });
});

const MED: IntakeFormMedication = {
  id: "m1",
  name: "Ramipril",
  dose: "5 mg",
  schedules: [{ timesOfDay: ["07:00"], windowStart: "07:00" }],
};

function Harness({
  takenAt,
  picker,
  medication = MED,
}: {
  takenAt: string;
  picker?: boolean;
  medication?: IntakeFormMedication;
}) {
  const form = useIntakeFormState({ medication, initialTakenAt: takenAt });
  return (
    <IntakeFormFields
      form={form}
      medication={medication}
      medications={picker ? [medication] : undefined}
      onMedicationChange={picker ? () => {} : undefined}
      idPrefix="t"
      maxTakenAt="2030-01-01T00:00"
    />
  );
}

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("IntakeFormFields", () => {
  it("shows the same fields everywhere: outcome, time, dose, where it counts", () => {
    const html = render(<Harness takenAt="2026-06-01T07:10" picker />);
    for (const slot of [
      "intake-form-medication",
      "intake-form-outcome",
      "intake-form-dose",
      "intake-form-counts-for",
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain(">Time<");
    expect(html).toContain("Counts for the 07:00 AM dose");
  });

  it("drops the picker when opened from one medication", () => {
    const html = render(<Harness takenAt="2026-06-01T07:10" />);
    expect(html).not.toContain('data-slot="intake-form-medication"');
    expect(html).toContain('data-slot="intake-form-dose"');
  });

  it("offers the switch for a take near a slot and says it counts as late", () => {
    const html = render(<Harness takenAt="2026-06-01T09:30" />);
    expect(html).toContain('data-slot="intake-form-count-near"');
    expect(html).toContain('data-kind="late"');
  });

  it("offers no skip for a medication without dose times", () => {
    const html = render(
      <Harness
        takenAt="2026-06-01T09:30"
        medication={{ ...MED, schedules: [] }}
      />,
    );
    expect(html).not.toContain('data-slot="intake-form-outcome"');
    expect(html).toContain('data-kind="extra"');
  });
});
