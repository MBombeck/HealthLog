import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationCard } from "@/components/medications/medication-card";

/**
 * v1.8.4 — the generic medication card must render the server-computed
 * `nextDueAt` (canonical recurrence engine, anchored on the last intake)
 * as the "next intake" timestamp, NOT a client-side daysOfWeek walker.
 *
 * The legacy walker only read `daysOfWeek` + `windowStart` and ignored
 * rolling / RRULE / one-shot cadences, so a rolling medication (e.g.
 * `rollingIntervalDays = 35`) wrongly read "tomorrow" and never
 * re-anchored after an intake. These tests pin that the card now
 * surfaces the server value, while the day-label / window-range
 * rendering for ordinary single-time schedules is unchanged.
 */

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function render(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

// v1.16.8 — the cards read ONE batched summary key and `select` their
// own row, so seeding merges into the shared array.
function seedCompliance(client: QueryClient, medId: string) {
  const key = ["medications", "compliance-summary"];
  const existing =
    (client.getQueryData(key) as Array<{ medicationId: string }>) ?? [];
  client.setQueryData(key, [
    ...existing.filter((row) => row.medicationId !== medId),
    {
      medicationId: medId,
      compliance7: { rate: 90, streak: 0, totalExpected: 7, taken: 6 },
      compliance30: { rate: 88 },
    },
  ]);
}

// A schedule whose window has already passed for today (01:00–02:00) so
// the card surfaces the "next intake" line rather than the take-now
// pill, regardless of host clock.
const pastWindow = {
  windowStart: "01:00",
  windowEnd: "02:00",
  label: null,
  daysOfWeek: null,
  dose: null,
};

// Pin the clock to a fixed mid-day instant so window-status ("take now"
// vs "next intake") and relative day labels are deterministic regardless
// of the CI host clock + timezone. The 01:00–02:00 windows below read as
// inactive at noon in every timezone; an unpinned run that happened to
// fall inside that window (e.g. 01:01 CEST) flipped the card to the
// take-now pill and broke these assertions.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-06-02T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("<MedicationCard> — next-due reads from server nextDueAt", () => {
  it("renders the server nextDueAt date for a rolling medication, not a today/tomorrow walker value", () => {
    // Rolling cadence: server anchors the next dose 35 days out. The
    // card must surface that calendar date — the legacy walker would
    // have produced "tomorrow" off the schedule window alone.
    const now = new Date();
    const due = new Date(now);
    due.setDate(due.getDate() + 35);
    // Midday so the Berlin display can't cross a day boundary regardless
    // of the host timezone.
    due.setHours(12, 0, 0, 0);

    const rollingMed = {
      id: "med-rolling-1",
      name: "Mounjaro",
      dose: "7.5 mg",
      category: "OTHER",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      nextDueAt: due.toISOString(),
      schedules: [{ id: "s-rolling-1", ...pastWindow }],
    };

    const client = makeClient();
    seedCompliance(client, rollingMed.id);

    const html = render(
      <MedicationCard
        medication={rollingMed}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    // The next-intake line surfaces.
    expect(html).toContain("Next intake:");
    // 35 days out is past the 5-day threshold, so the card renders the
    // full weekday-anchored short date (e.g. "Mon, 07/06") derived from
    // the SERVER instant — NOT a today/tomorrow walker value. Pin the
    // day-of-month + month of the SERVER date (Berlin-rendered), proving
    // the date tracks `nextDueAt` rather than the schedule window alone.
    const berlin = new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Berlin",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
    }).format(due);
    expect(html).toContain(berlin);
    expect(html).not.toContain("Next intake: Today,");
    expect(html).not.toContain("Next intake: Tomorrow,");
  });

  it("falls back to the schedule window range when nextDueAt is absent", () => {
    // A medication with no server next-due (e.g. ended course) still
    // renders the window-range line off its first schedule; it just
    // omits the day label.
    const med = {
      id: "med-nodue-1",
      name: "Ramipril",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      nextDueAt: null,
      schedules: [{ id: "s-nodue-1", ...pastWindow }],
    };

    const client = makeClient();
    seedCompliance(client, med.id);

    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    expect(html).toContain("Next intake:");
    // No day label is prepended when the server gave no instant — the
    // line goes straight to the window range.
    expect(html).not.toContain("Next intake: Today,");
    expect(html).not.toContain("Next intake: Tomorrow,");
  });

  it("renders the day label for a single-time daysOfWeek medication due tomorrow", () => {
    // A daily / weekly medication whose server next-due is tomorrow
    // still renders the relative "tomorrow" label — proving the ordinary
    // single-time path keeps working. `due` is a fixed UTC instant ~20h
    // after the pinned clock, so it lands on the next calendar day in both
    // UTC and the Berlin default — the relative label is deterministic.
    const now = new Date();
    const due = new Date(now);
    due.setUTCDate(due.getUTCDate() + 1);
    due.setUTCHours(8, 0, 0, 0);

    const med = {
      id: "med-daily-1",
      name: "Ramipril",
      dose: "5 mg",
      category: "BLOOD_PRESSURE",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      nextDueAt: due.toISOString(),
      schedules: [
        {
          id: "s-daily-1",
          windowStart: "08:00",
          windowEnd: "09:00",
          label: null,
          daysOfWeek: null,
          dose: "5 mg",
        },
      ],
    };

    const client = makeClient();
    seedCompliance(client, med.id);

    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    expect(html).toContain("Next intake:");
    // Relative day label from the server instant (capitalised "Tomorrow").
    expect(html).toContain("Tomorrow,");
  });
});

describe("<MedicationCard> — open overdue slot (v1.16.4)", () => {
  // Server contract: when an unresolved slot's anchor has passed but the
  // catch-up band is still open, the list GET carries THAT slot in
  // `nextDueAt` with `nextDueOverdue: true`. The card must render it as a
  // calm amber "overdue — still takeable" line instead of jumping to the
  // next future slot; with the flag false the regular phrasing returns.
  function makeMed(overrides: Record<string, unknown>) {
    return {
      id: "med-overdue-1",
      name: "Metformin",
      dose: "500 mg",
      category: "OTHER",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      schedules: [{ id: "s-overdue-1", ...pastWindow }],
      ...overrides,
    };
  }

  it("renders the overdue slot as an amber still-takeable line, not a future next-intake", () => {
    // Pinned now is 2026-06-02T12:00:00Z; the slot anchor sits two hours
    // earlier, still inside its catch-up band per the server flag.
    const med = makeMed({
      nextDueAt: "2026-06-02T10:00:00Z",
      nextDueOverdue: true,
    });
    const client = makeClient();
    seedCompliance(client, med.id);

    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    expect(html).toContain("Overdue since");
    expect(html).toContain("can still be taken");
    expect(html).toContain("text-warning");
    expect(html).not.toContain("Next intake: Tomorrow,");
  });

  it("renders the regular upcoming phrasing once the flag is false (band closed, next slot)", () => {
    const due = new Date("2026-06-03T10:00:00Z"); // tomorrow relative to pinned now
    const med = makeMed({
      nextDueAt: due.toISOString(),
      nextDueOverdue: false,
    });
    const client = makeClient();
    seedCompliance(client, med.id);

    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    expect(html).toContain("Next intake:");
    expect(html).toContain("Tomorrow");
    expect(html).not.toContain("Overdue since");
    expect(html).not.toContain("can still be taken");
  });
});

/**
 * v1.16.11 (#316) — as-needed (PRN) card presentation: a calm
 * "As needed" marker where next-due normally sits, no due pill, no
 * overdue escalation, and NO compliance block (neither bars nor an
 * eternal skeleton — the batched compliance read excludes PRN rows).
 * The last-intake line stays: the card is last-taken oriented.
 */
describe("<MedicationCard> — as-needed marker (v1.16.11, #316)", () => {
  function makeAsNeededMed(overrides: Record<string, unknown> = {}) {
    const lastTaken = new Date();
    lastTaken.setHours(lastTaken.getHours() - 3);
    return {
      id: "med-prn-1",
      name: "Ibuprofen",
      dose: "400 mg",
      category: "PAIN_RELIEF",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: lastTaken.toISOString(),
      todayEventCount: 1,
      nextDueAt: null,
      nextDueOverdue: false,
      asNeeded: true,
      schedules: [],
      ...overrides,
    };
  }

  it("renders the calm marker, the last-intake line, and no compliance block", () => {
    const med = makeAsNeededMed();
    const client = makeClient();
    // Deliberately NOT seeding the compliance cache: the batched read
    // excludes as-needed medications, so the card must not fall back to
    // the loading skeleton.
    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    expect(html).toContain('data-slot="medication-as-needed-marker"');
    expect(html).toContain("As needed");
    expect(html).toContain("Last intake:");
    // No due/overdue presentation, ever.
    expect(html).not.toContain("Overdue");
    expect(html).not.toContain("Take now");
    // No compliance bars and no skeleton placeholder for them.
    expect(html).not.toContain("Adherence (");
  });

  it("keeps the quick-log action row (intakes still record)", () => {
    const med = makeAsNeededMed();
    const client = makeClient();
    const html = render(
      <MedicationCard
        medication={med}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );
    // The shared intake actions render (take/skip) — an as-needed dose
    // is loggable from the card exactly like a scheduled one.
    expect(html).toContain("Taken");
  });
});

/**
 * v1.39.4 (#1040) — a medication whose course has ended keeps its card
 * (history, adherence) but offers no taken / skip and names the state.
 */
describe("<MedicationCard> — ended course (#1040)", () => {
  function makeMed(overrides: Record<string, unknown> = {}) {
    return {
      id: "med-course-1",
      name: "Amoxicillin",
      dose: "500 mg",
      category: "ANTIBIOTIC",
      treatmentClass: undefined as string | undefined,
      active: true,
      notificationsEnabled: true,
      pausedAt: null,
      lastTakenAt: null,
      todayEventCount: 0,
      nextDueAt: null,
      nextDueOverdue: false,
      schedules: [{ id: "s1", ...pastWindow }],
      ...overrides,
    };
  }

  it("drops the action row and shows the Ended badge once the course is over", () => {
    const client = makeClient();
    seedCompliance(client, "med-course-1");
    const html = render(
      <MedicationCard
        medication={makeMed({ courseStatus: "ENDED", intakeActionable: false })}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );
    expect(html).not.toContain('data-slot="medication-intake-take"');
    expect(html).not.toContain('data-slot="medication-intake-skip"');
    expect(html).toContain('data-slot="medication-course-ended-badge"');
  });

  it("keeps the action row on the last course day", () => {
    const client = makeClient();
    seedCompliance(client, "med-course-1");
    const html = render(
      <MedicationCard
        medication={makeMed({
          courseStatus: "CURRENT",
          intakeActionable: true,
        })}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );
    expect(html).toContain('data-slot="medication-intake-take"');
    expect(html).not.toContain('data-slot="medication-course-ended-badge"');
  });
});
