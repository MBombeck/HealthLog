/**
 * "Remind me later" on the medication card: one snooze length for every
 * surface, named in the label, offered while a dose is due or overdue, and
 * replaced by the snoozed state once the reminder is held.
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
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import {
  pickSnoozeRows,
  type TodayDoseRow,
} from "@/components/medications/card-parts/use-dose-snooze";

function row(overrides: Partial<TodayDoseRow>): TodayDoseRow {
  return {
    id: "r1",
    medicationId: "m1",
    status: "pending",
    snoozedUntil: null,
    state: "due",
    ...overrides,
  };
}

function render(
  snooze: Parameters<typeof MedicationIntakeActions>[0]["snooze"],
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MedicationIntakeActions
        intakeLoading={null}
        onRecordIntake={() => {}}
        snooze={snooze}
      />
    </I18nProvider>,
  );
}

describe("pickSnoozeRows", () => {
  it("snoozes the medication's due or overdue row, never another's", () => {
    const rows = [
      row({ id: "other", medicationId: "m2" }),
      row({ id: "pending", state: "upcoming" }),
      row({ id: "open", state: "overdue" }),
    ];
    expect(pickSnoozeRows(rows, "m1")).toEqual({
      open: rows[2],
      snoozed: null,
    });
  });

  it("reads a held reminder as snoozed and offers no second snooze", () => {
    const held = row({
      status: "snoozed",
      snoozedUntil: "2026-11-21T09:12:00.000Z",
    });
    expect(pickSnoozeRows([held], "m1")).toEqual({ open: null, snoozed: held });
  });
});

describe("the card's snooze", () => {
  it("names the length in the label", () => {
    const html = render({
      minutes: 30,
      snoozedUntil: null,
      canSnooze: true,
      busy: false,
      snooze: () => {},
    });
    expect(html).toContain('data-slot="medication-intake-snooze"');
    expect(html).toContain("Remind me later (30 min)");
  });

  it("shows the snoozed state instead of the action", () => {
    const html = render({
      minutes: 30,
      snoozedUntil: "2026-11-21T09:12:00.000Z",
      canSnooze: false,
      busy: false,
      snooze: () => {},
    });
    expect(html).toContain('data-slot="medication-snoozed"');
    expect(html).toContain("Reminder snoozed until");
    expect(html).not.toContain('data-slot="medication-intake-snooze"');
  });

  it("offers nothing when no dose is open", () => {
    const html = render({
      minutes: 30,
      snoozedUntil: null,
      canSnooze: false,
      busy: false,
      snooze: () => {},
    });
    expect(html).not.toContain("Remind me later");
  });
});
