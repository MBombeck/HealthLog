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
    const html = render({ at: new Date(SLOT), earlyFrom: null });
    expect(html).toMatch(/Take \([^)]*, \d{1,2}:00( AM)?\)/);
  });

  it("keeps the plain label without a slot", () => {
    expect(render(null)).toMatch(/>Take<\/button>|Take<\/button>/);
  });
});
