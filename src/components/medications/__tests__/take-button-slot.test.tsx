/**
 * The take button names the slot it records, and says when the take would
 * be early: a tap at 06:30 on an 08:00 dose used to read a plain "Take",
 * with nothing to tell that the dose was not open yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { cardTakeSlot } from "@/lib/medications/dose-state/pill";

const SLOT = "2026-11-21T08:00:00.000Z";
const dose = (state: string) => ({
  state,
  targetAt: SLOT,
  dueAt: "2026-11-21T07:00:00.000Z",
  overdueSince: "2026-11-21T09:00:00.000Z",
  missedAfter: "2026-11-21T12:00:00.000Z",
});

function render(slot: ReturnType<typeof cardTakeSlot>) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MedicationIntakeActions
        intakeLoading={null}
        onRecordIntake={() => {}}
        slot={slot}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("TZ", "UTC");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the take button's slot", () => {
  it("names today's slot and says nothing more while the dose is due", () => {
    const now = new Date("2026-11-21T08:10:00.000Z");
    vi.setSystemTime(now);
    const html = render(cardTakeSlot(dose("due"), SLOT, now));
    expect(html).toMatch(/Take \(\d{1,2}:00( AM)?\)/);
    expect(html).not.toContain('data-slot="medication-intake-early"');
  });

  it("says the take would be early before the dose window opens", () => {
    const now = new Date("2026-11-21T06:30:00.000Z");
    vi.setSystemTime(now);
    const slot = cardTakeSlot(dose("upcoming"), SLOT, now);
    expect(slot?.earlyFrom?.toISOString()).toBe("2026-11-21T07:00:00.000Z");
    const html = render(slot);
    expect(html).toContain('data-slot="medication-intake-early"');
    expect(html).toContain("Early: this dose is due from");
  });

  it("is not early once the window opened, even on a fetched pending dose", () => {
    const now = new Date("2026-11-21T07:30:00.000Z");
    expect(cardTakeSlot(dose("upcoming"), SLOT, now)?.earlyFrom).toBeNull();
  });

  it("names the day of a slot that is not today", () => {
    const now = new Date("2026-11-20T20:00:00.000Z");
    vi.setSystemTime(now);
    const html = render({
      at: new Date(SLOT),
      earlyFrom: null,
      binding: "pinned",
    });
    expect(html).toMatch(/Take \([^)]*, \d{1,2}:00( AM)?\)/);
  });

  it("keeps the plain label without a slot", () => {
    expect(render(null)).toMatch(/>Take<\/button>|Take<\/button>/);
  });
});

/**
 * The slot on the button is the slot the take counts for, across a day.
 * At noon "Take (07:00 PM)" posted the evening slot as `scheduledFor`; the
 * server does not bind a named slot ahead of the take, filed an extra dose,
 * and the card said "taken" while the 19:00 dose stayed open. Every take
 * now carries a binding the server honours, and the one that would not
 * count says so on the button.
 */
describe("the take button counts for the slot it names", () => {
  const EVENING = "2026-11-21T19:00:00.000Z";
  const evening = (state: string) => ({
    state,
    targetAt: EVENING,
    dueAt: "2026-11-21T18:00:00.000Z",
    overdueSince: "2026-11-21T20:00:00.000Z",
    missedAfter: "2026-11-21T23:00:00.000Z",
  });
  const at = (hhmm: string) => new Date(`2026-11-21T${hhmm}:00.000Z`);

  it.each([
    // [clock, binding]: an extra dose more than six hours ahead (the reach of
    // the server's nearest-slot rule), pinned to the slot within them, the
    // named slot once the dose is open.
    ["11:59", "extra"],
    ["12:59", "extra"],
    ["13:00", "pinned"],
    ["15:00", "pinned"],
    ["17:30", "pinned"],
    ["18:10", "slot"],
    ["21:00", "slot"],
    ["23:30", "slot"],
  ])("at %s the take binds as %s", (clock, binding) => {
    const now = at(clock);
    const slot = cardTakeSlot(evening("upcoming"), EVENING, now);
    expect(slot?.at.toISOString()).toBe(EVENING);
    expect(slot?.binding).toBe(binding);
  });

  it("sends the field the server binds by, for each binding", async () => {
    const { cardIntakeBody } =
      await import("@/components/medications/use-medication-intake");
    const slotAt = new Date(EVENING);
    expect(
      cardIntakeBody(false, { at: slotAt, earlyFrom: null, binding: "slot" }),
    ).toEqual({ skipped: false, scheduledFor: EVENING });
    expect(
      cardIntakeBody(false, { at: slotAt, earlyFrom: null, binding: "pinned" }),
    ).toEqual({ skipped: false, forceSlotInstant: EVENING });
    expect(
      cardIntakeBody(false, { at: slotAt, earlyFrom: null, binding: "extra" }),
    ).toEqual({ skipped: false, extraDose: true });
    // A skip names the slot it skips, whatever a take would do.
    expect(
      cardIntakeBody(true, { at: slotAt, earlyFrom: null, binding: "extra" }),
    ).toEqual({ skipped: true, scheduledFor: EVENING });
  });

  it("says a take far ahead logs an extra dose, before the tap", () => {
    const now = at("11:59");
    vi.setSystemTime(now);
    const html = render(cardTakeSlot(evening("upcoming"), EVENING, now));
    expect(html).toContain("Take an extra dose");
    expect(html).toContain('data-slot="medication-intake-extra"');
    expect(html).not.toMatch(/Take \(/);
  });

  it("names the slot and the early opening when the take is pinned to it", () => {
    const now = at("16:00");
    vi.setSystemTime(now);
    const html = render(cardTakeSlot(evening("upcoming"), EVENING, now));
    expect(html).toMatch(/Take \(\d{1,2}:00( PM)?\)/);
    expect(html).toContain("Early: this dose is due from");
  });
});
