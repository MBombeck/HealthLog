/**
 * The overview's cards: one anatomy, the server's values, the two-button
 * foot. Rendered rather than described.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canWriteDomain: () => true,
    canManageDomain: () => true,
    inSharedRecord: false,
  }),
  holdsGuardianSurfaces: () => true,
  useActiveRecordName: () => null,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", timezone: "UTC", timeFormat: "H24" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { IntakeCard } from "@/components/medications/detail/overview/intake-card";
import { PlanCard } from "@/components/medications/detail/overview/plan-card";
import type { OverviewCompliance } from "@/components/medications/detail/overview/anatomy";
import type { LedgerRow } from "@/components/medications/dose-history-ledger-compute";
import type { MedicationDetailSnapshot } from "@/components/medications/detail/medication-detail-tabs";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const slot = (
  day: string,
  time: string,
  status: LedgerRow["status"],
): LedgerRow => ({
  kind: "slot",
  at: `${day}T${time}:00.000Z`,
  timeOfDay: time,
  status,
  intake:
    status === "taken_on_time" || status === "taken_late"
      ? {
          id: `${day}-${time}`,
          scheduledFor: `${day}T${time}:00.000Z`,
          takenAt: `${day}T${time}:10.000Z`,
          skipped: false,
          autoMissed: false,
        }
      : null,
});

const compliance: OverviewCompliance = {
  applicable: true,
  notApplicableReason: null,
  compliance7: { rate: 96, streak: 3 },
  compliance30: { rate: 96 },
  complianceDisplay: {
    shortDays: 7,
    longDays: 30,
    expectedShort: 14,
    expectedLong: 60,
    minStableDoses: 6,
    short: { rate: 100, taken: 14, expected: 14, missed: 0, streak: 7 },
    long: { rate: 98, taken: 59, expected: 60, missed: 1 },
    currentCycle: {
      state: "on_track",
      nextDueAt: null,
      graceUntil: null,
      hasClosedCycles: true,
    },
    currentDose: {
      status: "upcoming",
      targetAt: null,
      state: null,
      takenLate: false,
      dueAt: null,
      overdueSince: null,
      missedAfter: null,
      lateTakeCounts: false,
    },
  },
};

describe("intake card", () => {
  const byDay = new Map<string, LedgerRow[]>([
    [
      "2026-11-26",
      [
        slot("2026-11-26", "08:00", "taken_on_time"),
        slot("2026-11-26", "20:00", "missed"),
      ],
    ],
    [
      "2026-11-27",
      [
        slot("2026-11-27", "08:00", "taken_late"),
        slot("2026-11-27", "20:00", "upcoming"),
      ],
    ],
  ]);

  it("leads with the server's rate and one sentence about the misses", () => {
    const html = render(
      <IntakeCard
        asNeeded={false}
        recordOnly={false}
        compliance={compliance}
        byDay={byDay}
        todayKey="2026-11-27"
        loading={false}
        onBackfill={() => {}}
        onHistory={() => {}}
      />,
    );
    expect(html).toContain('data-slot="medication-overview-adherence"');
    expect(html).toContain("98%");
    expect(html).toContain("You missed one dose in 30 days.");
    // One grid row per dose time, the legend counting the grid's cells.
    expect(html.match(/data-tone=/g)).toHaveLength(28);
    expect(html).toContain("1 taken");
    expect(html).toContain("1 late");
    expect(html).toContain("1 missed");
    expect(html.match(/data-tone="missed"/g)).toHaveLength(1);
    expect(html.match(/data-tone="open"/g)).toHaveLength(1);
  });

  it("ends in two equal buttons, secondary first", () => {
    const html = render(
      <IntakeCard
        asNeeded={false}
        recordOnly={false}
        compliance={compliance}
        byDay={byDay}
        todayKey="2026-11-27"
        loading={false}
        onBackfill={() => {}}
        onHistory={() => {}}
      />,
    );
    const pair = html.slice(html.indexOf('data-slot="action-pair"'));
    expect(pair.indexOf("medication-overview-intake-backfill")).toBeLessThan(
      pair.indexOf("medication-overview-intake-history"),
    );
    expect(html).toContain("auto-cols-fr");
  });

  it("counts takes for an as-needed medication, with no rate", () => {
    const html = render(
      <IntakeCard
        asNeeded
        recordOnly={false}
        compliance={null}
        byDay={
          new Map([
            [
              "2026-11-27",
              [
                {
                  kind: "ad_hoc",
                  at: "2026-11-27T14:00:00.000Z",
                  timeOfDay: null,
                  status: "ad_hoc",
                  intake: {
                    id: "x",
                    scheduledFor: "2026-11-27T14:00:00.000Z",
                    takenAt: "2026-11-27T14:00:00.000Z",
                    skipped: false,
                    autoMissed: false,
                  },
                } as LedgerRow,
              ],
            ],
          ])
        }
        todayKey="2026-11-27"
        loading={false}
      />,
    );
    expect(html).toContain("Taken once in 14 days.");
    expect(html).not.toContain("medication-overview-adherence");
  });
});

describe("plan card", () => {
  const medication = {
    id: "m1",
    name: "Ramipril",
    dose: "5 mg",
    category: "CARDIOVASCULAR",
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    startsOn: "2023-10-24T00:00:00.000Z",
    endsOn: null,
    note: "With food\nNot with milk",
    schedules: [
      {
        id: "s1",
        windowStart: "08:00",
        windowEnd: "10:00",
        label: null,
        dose: null,
        daysOfWeek: null,
        timesOfDay: ["08:00", "20:00"],
        reminderGraceMinutes: 30,
      },
    ],
  } as MedicationDetailSnapshot;

  it("lists period, reminder and the person's own note, not the cadence the header says", () => {
    const html = render(
      <PlanCard
        medication={medication}
        recordOnly={false}
        asNeeded={false}
        onEdit={() => {}}
      />,
    );
    expect(html).not.toContain("medication-overview-plan-intake");
    expect(html).toContain("since ");
    expect(html).toContain("on, 30 minutes");
    expect(html).toContain('data-slot="medication-overview-plan-edit"');
    // The note is the person's own words: foreground, line breaks kept.
    expect(html).toMatch(
      /data-slot="medication-detail-note"[^>]*>With food\nNot with milk/,
    );
    expect(html).not.toMatch(/medication-detail-note"[^>]*muted/);
  });
});
