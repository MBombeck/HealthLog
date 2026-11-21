/**
 * The one intake form. The medications page, the dose history and the
 * capture sheet render the same fields, and the form says where a dose will
 * count before it is saved instead of asking afterwards. The slots it offers
 * are the chosen day's open slots in the server's dose ledger, so a weekly
 * medication's off day offers none and a taken slot is not offered again.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
  useActiveRecordName: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import {
  IntakeFormFields,
  intakeWriteOf,
  useIntakeFormState,
  type IntakeFormMedication,
} from "@/components/medications/intake-form/intake-form";
import {
  attributeIntake,
  classifyTake,
  nearestSlotForTake,
  openSlotsOf,
  slotFieldsOf,
  type DayLedgerRow,
  type DaySlot,
} from "@/components/medications/intake-form/slot-attribution";

/** A slot on 2026-06-01 at `hm`, read in the suite's zone. */
function slot(hm: string): DaySlot {
  return { slotHm: hm, instant: new Date(`2026-06-01T${hm}`) };
}

describe("openSlotsOf", () => {
  const window = {
    dayStart: new Date("2026-06-01T00:00:00Z"),
    dayEnd: new Date("2026-06-02T00:00:00Z"),
  };

  it("keeps the day's open slot rows and drops taken, skipped and ad-hoc rows", () => {
    const rows: DayLedgerRow[] = [
      {
        kind: "slot",
        at: "2026-06-01T19:00:00Z",
        timeOfDay: "19:00",
        state: "upcoming",
      },
      {
        kind: "slot",
        at: "2026-06-01T07:00:00Z",
        timeOfDay: "07:00",
        state: "taken",
      },
      {
        kind: "slot",
        at: "2026-06-01T12:00:00Z",
        timeOfDay: "12:00",
        state: "skipped",
      },
      {
        kind: "slot",
        at: "2026-06-01T09:00:00Z",
        timeOfDay: "09:00",
        state: "missed",
      },
      {
        kind: "ad_hoc",
        at: "2026-06-01T10:00:00Z",
        timeOfDay: null,
        state: null,
      },
      {
        kind: "slot",
        at: "2026-06-02T00:00:00Z",
        timeOfDay: "00:00",
        state: "upcoming",
      },
    ];
    expect(openSlotsOf(rows, window).map((s) => s.slotHm)).toEqual([
      "09:00",
      "19:00",
    ]);
  });
});

describe("nearestSlotForTake / classifyTake", () => {
  it("finds the closest slot on the take's own day with the gap in minutes", () => {
    const near = nearestSlotForTake("2026-06-01T08:30", [
      slot("07:00"),
      slot("19:00"),
    ]);
    expect(near?.slotHm).toBe("07:00");
    expect(near?.gapMinutes).toBe(90);
  });

  it("returns null for a day without an open slot", () => {
    expect(nearestSlotForTake("2026-06-01T08:30", [])).toBeNull();
  });

  it("classifies exact, near and extra takes", () => {
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T07:30", [slot("07:00")])),
    ).toBe("exact");
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T09:00", [slot("07:00")])),
    ).toBe("near");
    expect(
      classifyTake(nearestSlotForTake("2026-06-01T14:00", [slot("07:00")])),
    ).toBe("extra");
    expect(classifyTake(null)).toBe("extra");
  });
});

describe("attributeIntake", () => {
  it("binds a take in the window to its slot", () => {
    const a = attributeIntake({
      takenAtLocal: "2026-06-01T07:20",
      slots: [slot("07:00")],
      skipped: false,
      countNear: true,
    });
    expect(a.kind).toBe("slot");
    expect(Object.keys(slotFieldsOf(a))).toEqual(["scheduledFor"]);
  });

  it("pins a near take to the slot as late, unless switched off", () => {
    const late = attributeIntake({
      takenAtLocal: "2026-06-01T09:30",
      slots: [slot("07:00")],
      skipped: false,
      countNear: true,
    });
    expect(late.kind).toBe("late");
    expect(Object.keys(slotFieldsOf(late))).toEqual(["forceSlotInstant"]);
    const extra = attributeIntake({
      takenAtLocal: "2026-06-01T09:30",
      slots: [slot("07:00")],
      skipped: false,
      countNear: false,
    });
    expect(extra.kind).toBe("extra");
    expect(slotFieldsOf(extra)).toEqual({});
  });

  it("names the slot a skip skips", () => {
    const a = attributeIntake({
      takenAtLocal: "2026-06-01T18:00",
      slots: [slot("07:00"), slot("19:00")],
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

/** The day ledger the form reads, as the server sends it. */
type Ledger = { rows: DayLedgerRow[] } | "error" | "loading";

const SLOT_0700: DayLedgerRow = {
  kind: "slot",
  at: "2026-06-01T07:00:00.000Z",
  timeOfDay: "07:00",
  state: "due",
};

function clientWith(takenAt: string, ledger: Ledger, medId = MED.id) {
  const client = new QueryClient({
    // A failed read stays failed on mount, as it does after its retries.
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  const key = queryKeys.medicationDoseHistoryDay(
    medId,
    userDayKey(new Date(takenAt), DEFAULT_TIMEZONE),
    DEFAULT_TIMEZONE,
  );
  if (ledger === "error") {
    client
      .getQueryCache()
      .build(client, { queryKey: key })
      .setState({ status: "error", error: new Error("boom") });
  } else if (ledger !== "loading") {
    client.setQueryData(key, ledger);
  }
  return client;
}

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
  const write = intakeWriteOf(form);
  return (
    <>
      <IntakeFormFields
        form={form}
        medication={medication}
        medications={picker ? [medication] : undefined}
        onMedicationChange={picker ? () => {} : undefined}
        idPrefix="t"
        maxTakenAt="2030-01-01T00:00"
      />
      <output
        data-write-scheduled-for={write.scheduledFor ?? ""}
        data-write-force-slot={write.forceSlotInstant ?? ""}
      />
    </>
  );
}

/** The slot fields the form would send, read off the harness's output. */
function writeOf(html: string): {
  scheduledFor?: string;
  forceSlotInstant?: string;
} {
  const attr = (name: string) =>
    html.match(new RegExp(`${name}="([^"]*)"`))?.[1] || undefined;
  return {
    scheduledFor: attr("data-write-scheduled-for"),
    forceSlotInstant: attr("data-write-force-slot"),
  };
}

function render(
  props: {
    takenAt: string;
    picker?: boolean;
    medication?: IntakeFormMedication;
  },
  ledger: Ledger = { rows: [SLOT_0700] },
) {
  return renderToStaticMarkup(
    <QueryClientProvider
      client={clientWith(props.takenAt, ledger, props.medication?.id)}
    >
      <I18nProvider initialLocale="en">
        <Harness {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("IntakeFormFields", () => {
  it("shows the same fields everywhere: outcome, time, dose, where it counts", () => {
    const html = render({ takenAt: "2026-06-01T07:10", picker: true });
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
    const html = render({ takenAt: "2026-06-01T07:10" });
    expect(html).not.toContain('data-slot="intake-form-medication"');
    expect(html).toContain('data-slot="intake-form-dose"');
  });

  it("offers the switch for a take near a slot and says it counts as late", () => {
    const html = render({ takenAt: "2026-06-01T09:30" });
    expect(html).toContain('data-slot="intake-form-count-near"');
    expect(html).toContain('data-kind="late"');
    expect(writeOf(html).forceSlotInstant).toBe(SLOT_0700.at);
  });
});

describe("IntakeFormFields on a weekly medication", () => {
  const WEEKLY: IntakeFormMedication = {
    ...MED,
    id: "weekly",
    schedules: [{ timesOfDay: ["08:00"], windowStart: "08:00" }],
  };
  // Monday 2026-06-01 is the dose day; Tuesday is not.
  const MONDAY_SLOT: DayLedgerRow = {
    kind: "slot",
    at: "2026-06-01T08:00:00.000Z",
    timeOfDay: "08:00",
    state: "overdue",
  };

  it("offers no slot on an off day: a late take is an extra dose without a forced slot", () => {
    const html = render(
      { takenAt: "2026-06-02T10:30", medication: WEEKLY },
      { rows: [] },
    );
    expect(html).toContain('data-kind="extra"');
    expect(html).toContain('data-slots="ready"');
    expect(html).not.toContain('data-slot="intake-form-count-near"');
    expect(html).not.toContain('data-slot="intake-form-outcome"');
    const write = writeOf(html);
    expect(write.forceSlotInstant).toBeUndefined();
    expect(write.scheduledFor).toBeUndefined();
  });

  it("offers the day's slot on a dose day", () => {
    const html = render(
      { takenAt: "2026-06-01T10:30", medication: WEEKLY },
      { rows: [MONDAY_SLOT] },
    );
    expect(html).toContain('data-kind="late"');
    expect(html).toContain('data-slot="intake-form-outcome"');
    expect(writeOf(html).forceSlotInstant).toBe(MONDAY_SLOT.at);
  });

  it("does not offer a slot already taken", () => {
    const html = render(
      { takenAt: "2026-06-01T10:30", medication: WEEKLY },
      {
        rows: [
          { ...MONDAY_SLOT, state: "taken" },
          { kind: "ad_hoc", at: "2026-06-01T07:55:00.000Z", timeOfDay: null },
        ],
      },
    );
    expect(html).toContain('data-kind="extra"');
    expect(html).not.toContain('data-slot="intake-form-count-near"');
    expect(writeOf(html).forceSlotInstant).toBeUndefined();
  });

  it("offers no slot while the day's ledger loads", () => {
    const html = render(
      { takenAt: "2026-06-01T08:05", medication: WEEKLY },
      "loading",
    );
    expect(html).toContain('data-kind="pending"');
    expect(html).toContain('data-slots="loading"');
    const write = writeOf(html);
    expect(write.scheduledFor).toBeUndefined();
    expect(write.forceSlotInstant).toBeUndefined();
  });

  it("falls back to an extra dose and says so when the ledger read fails", () => {
    const html = render(
      { takenAt: "2026-06-01T08:05", medication: WEEKLY },
      "error",
    );
    expect(html).toContain('data-kind="extra"');
    expect(html).toContain('data-slots="error"');
    expect(html).toContain("Could not read that day&#x27;s schedule");
    const write = writeOf(html);
    expect(write.scheduledFor).toBeUndefined();
    expect(write.forceSlotInstant).toBeUndefined();
  });
});
