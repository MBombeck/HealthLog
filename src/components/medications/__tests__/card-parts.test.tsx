import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MedicationCard } from "@/components/medications/medication-card";
import {
  Glp1MedicationCard,
  type Glp1Medication,
} from "@/components/medications/glp1-medication-card";
import {
  MedicationComplianceBars,
  MedicationComplianceError,
  MedicationComplianceSkeleton,
} from "@/components/medications/card-parts/medication-compliance-bars";
import { MedicationStatusPill } from "@/components/medications/card-parts/medication-status-pill";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { MedicationStateBadges } from "@/components/medications/card-parts/medication-state-badges";
import { MedicationCycleStatus } from "@/components/medications/card-parts/medication-cycle-status";
import { MedicationCardBody } from "@/components/medications/card-parts/medication-card-body";
import type { CurrentCycle, DoseStatus } from "@/lib/analytics/compliance";

/**
 * v1.7.2 — the medication-card status pill, compliance bars, intake-action
 * row, and state badges are shared presentational components consumed by
 * both the generic `<MedicationCard>` and the `<Glp1MedicationCard>`. The
 * symmetry between the two variants is now structural (one component, two
 * call sites) rather than two hand-synced JSX blocks.
 *
 * These tests pin the load-bearing seams of the extracted parts and the
 * unified streak/warning token so a regression can't reopen the drift.
 */

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function render(node: React.ReactNode, client?: QueryClient) {
  // v1.36.x — every card part now asks what the record on screen allows
  // before it renders a control, and that answer rides the account query.
  // The parts that carry no query of their own were rendered here without a
  // provider; they need one now. Fixtures are the caller's own record, which
  // is every capability — the delegation cases live in
  // `src/components/__tests__/delegated-write-affordances.test.tsx`.
  const tree = (
    <QueryClientProvider client={client ?? makeClient()}>
      {node}
    </QueryClientProvider>
  );
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{tree}</I18nProvider>,
  );
}

describe("medication card-parts — shared presentational components", () => {
  it("compliance bars render the 7d / 30d labels and the day-streak flame", () => {
    const html = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={5} />,
    );
    expect(html).toContain("Adherence (7 days)");
    expect(html).toContain("Adherence (30 days)");
    expect(html).toContain("90%");
    expect(html).toContain("88%");
    expect(html).toContain("lucide-flame");
    // v1.12.2 — semantic warning token, NOT the Tailwind-stock drift nor the
    // raw Dracula palette token.
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-orange-400");
    expect(html).not.toContain("text-dracula-orange");
  });

  it("compliance bars scale the row labels to the chosen windows", () => {
    // v1.8.6 — a sparse cadence steps both windows up; the labels follow.
    const html = render(
      <MedicationComplianceBars
        rate7={75}
        rate30={80}
        streak={0}
        shortDays={90}
        longDays={365}
      />,
    );
    expect(html).toContain("Adherence (90 days)");
    expect(html).toContain("Adherence (365 days)");
    expect(html).not.toContain("Adherence (7 days)");
    expect(html).not.toContain("Adherence (30 days)");
  });

  it("compliance bars hide the streak flame when streak is zero", () => {
    const html = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={0} />,
    );
    expect(html).not.toContain("lucide-flame");
  });

  it("compliance bars reserve the streak row across loaded, zero-streak, skeleton, and error states", () => {
    // A streak arriving used to ADD a row, growing the card and shifting
    // the grid; the `min-h-4` slot is now always mounted in every state so
    // the card height is invariant to the streak.
    const withStreak = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={5} />,
    );
    const withoutStreak = render(
      <MedicationComplianceBars rate7={90} rate30={88} streak={0} />,
    );
    const skeleton = render(<MedicationComplianceSkeleton />);
    const error = render(
      <MedicationComplianceError onRetry={() => undefined} />,
    );
    for (const html of [withStreak, withoutStreak, skeleton, error]) {
      expect(html).toContain("min-h-4");
    }
  });

  it("compliance bars render the percentage only — no dose count beside it", () => {
    // v1.15.9 — the operator does not want a count next to the percentage.
    // The auto-miss engine now makes the two windows' percentages genuinely
    // diverge, so the per-row count (`· 12 / 12`) is gone: percentage + bar
    // + window-days label only.
    const html = render(
      <MedicationComplianceBars rate7={100} rate30={92} streak={3} />,
    );
    expect(html).toContain("100%");
    expect(html).toContain("92%");
    // No middle-dot separator and no "doses" count caption anywhere.
    expect(html).not.toContain("·");
    expect(html).not.toContain("doses");
    // The bar + the window-days label survive.
    expect(html).toContain("Adherence (7 days)");
    expect(html).toContain("Adherence (30 days)");
  });

  it("status pill stamps the success token + take-now glyph in window", () => {
    const html = render(
      <MedicationStatusPill
        status="in_window"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("Take now");
    expect(html).toContain("text-success");
    expect(html).toContain("lucide-circle-check");
  });

  it("status pill stamps the warning token + glyph when late (semantic, not Dracula yellow)", () => {
    // v1.12.2 — the middle "late" tier converged off the lone
    // `text-dracula-yellow` stray onto the semantic warning token.
    const html = render(
      <MedicationStatusPill
        status="late"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-dracula-yellow");
    expect(html).toContain("lucide-circle-alert");
  });

  it("status pill stamps the destructive token + glyph when very late", () => {
    // v1.12.2 — very-late is the most-urgent tier; it reads as destructive
    // (red) so the pill is a clean success → warning → destructive ramp.
    const html = render(
      <MedicationStatusPill
        status="very_late"
        windowStart="08:00"
        windowEnd="20:00"
      />,
    );
    expect(html).toContain("text-destructive");
    expect(html).toContain("lucide-triangle-alert");
  });

  it("intake actions row carries exactly the take + skip buttons", () => {
    const html = render(
      <MedicationIntakeActions
        intakeLoading={null}
        onRecordIntake={() => {}}
      />,
    );
    expect(html).toContain("lucide-check");
    expect(html).toContain("lucide-skip-forward");
    expect(html).toContain("min-h-11");
  });

  it("state badges surface the without-notification + paused labels", () => {
    const html = render(
      <MedicationStateBadges
        notificationsEnabled={false}
        active={false}
        pausedAt="2026-05-01T08:00:00.000Z"
      />,
    );
    expect(html).toContain("Without notification");
    expect(html).toContain("Paused since");
  });
});

/**
 * v1.14.0 — the open-cycle status line. A calm, rate-decoupled status driven
 * by `currentCycle.state` so a sparse weekly / rolling med between doses
 * surfaces "next dose in N days" / "due today" / "overdue" rather than leaning
 * on a percentage that misreads an on-schedule med as a scary 0%.
 */
describe("medication cycle status — open-cycle line", () => {
  const baseCycle: CurrentCycle = {
    state: "on_track",
    nextDueAt: null,
    graceUntil: null,
    hasClosedCycles: true,
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  // Pin the clock to a stable Berlin-noon instant (12:00 CEST) so the
  // component's Berlin day-bucketing is deterministic regardless of the CI
  // runner's timezone — a UTC runner near midnight would otherwise read
  // "now" as the next Berlin day and drift every count by one.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A future instant exactly N×24 h from the pinned noon, so every offset lands
  // mid-Berlin-day and the whole-day delta is exactly N in any runtime tz.
  function inDays(n: number): Date {
    return new Date(Date.now() + n * DAY_MS);
  }

  it("renders nothing when state is none (PRN / paused / ended)", () => {
    const html = render(
      <MedicationCycleStatus cycle={{ ...baseCycle, state: "none" }} />,
    );
    expect(html).toBe("");
  });

  it("renders the neutral no-closed-cycles state with the dashed glyph", () => {
    const html = render(
      <MedicationCycleStatus
        cycle={{
          ...baseCycle,
          state: "on_track",
          nextDueAt: inDays(3),
          hasClosedCycles: false,
        }}
      />,
    );
    expect(html).toContain("No closed dose cycles yet");
    expect(html).toContain("lucide-circle-dashed");
    expect(html).toContain("text-muted-foreground");
    // never leaks a relative count when there's no closed cycle to anchor.
    expect(html).not.toContain("Next dose in");
  });

  it("on_track renders nothing — the next-dose timing already reads on the card's top slot", () => {
    // The calm on_track "next dose in N days" phrasing duplicates the
    // next-intake slot at the top of the card, so the open-cycle line stays
    // silent for an on-track med; only due / overdue earn a line here.
    for (const nextDueAt of [
      inDays(4),
      inDays(1),
      new Date(Date.now() + 6 * 60 * 60 * 1000),
    ]) {
      const html = render(
        <MedicationCycleStatus
          cycle={{ ...baseCycle, state: "on_track", nextDueAt }}
        />,
      );
      expect(html).toBe("");
    }
  });

  it("due reads the amber due-today line", () => {
    const html = render(
      <MedicationCycleStatus
        cycle={{
          ...baseCycle,
          state: "due",
          nextDueAt: new Date(),
          graceUntil: inDays(0),
        }}
      />,
    );
    expect(html).toContain("Due today");
    expect(html).toContain("text-warning");
    expect(html).toContain("lucide-calendar-clock");
  });

  it("missed renders nothing — the overdue escalation already reads on the next-intake line", () => {
    // v1.27.5 — the card's next-intake value line carries the destructive
    // overdue escalation; a second overdue line below the streak row doubled
    // the signal and is retired.
    const html = render(
      <MedicationCycleStatus
        cycle={{
          ...baseCycle,
          state: "missed",
          nextDueAt: inDays(-3),
          graceUntil: inDays(-3),
        }}
      />,
    );
    expect(html).toBe("");
  });
});

/**
 * Cross-variant streak-token parity: with a positive streak seeded, the
 * flame on BOTH the generic and the GLP-1 card resolves to the semantic
 * `text-warning` token (v1.12.2), and neither carries the legacy
 * `text-orange-400` nor the raw `text-dracula-orange`.
 */
describe("streak-token parity — generic vs GLP-1 card", () => {
  const ramipril = {
    id: "med-ramipril-streak",
    name: "Ramipril",
    dose: "5 mg",
    category: "BLOOD_PRESSURE",
    treatmentClass: undefined as string | undefined,
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    schedules: [
      {
        id: "s-ramipril-streak",
        windowStart: "00:00",
        windowEnd: "23:59",
        label: null,
        daysOfWeek: null,
        dose: "5 mg",
      },
    ],
  };

  const mounjaro: Glp1Medication = {
    id: "med-mounjaro-streak",
    name: "Mounjaro",
    dose: "7.5 mg",
    category: "HORMONE",
    treatmentClass: "GLP1",
    dosesPerUnit: 4,
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    schedules: [
      {
        id: "s-mounjaro-streak",
        windowStart: "00:00",
        windowEnd: "23:59",
        label: null,
        daysOfWeek: null,
        dose: "7.5 mg",
      },
    ],
  };

  // v1.16.8 — the cards read ONE batched summary key and `select` their
  // own row, so seeding merges into the shared array.
  function seedStreak(client: QueryClient, medId: string) {
    const key = ["medications", "compliance-summary"];
    const existing =
      (client.getQueryData(key) as Array<{ medicationId: string }>) ?? [];
    client.setQueryData(key, [
      ...existing.filter((row) => row.medicationId !== medId),
      {
        medicationId: medId,
        compliance7: { rate: 90, streak: 4, totalExpected: 7, taken: 6 },
        compliance30: { rate: 88 },
      },
    ]);
  }

  it("both cards render the flame with the canonical token, never the drift", () => {
    const client = makeClient();
    seedStreak(client, ramipril.id);
    seedStreak(client, mounjaro.id);
    client.setQueryData(["medications", mounjaro.id, "glp1-details"], {
      doseChanges: [],
      recentIntakes: [],
      inventory: null,
    });

    const ramiprilHtml = render(
      <MedicationCard
        medication={ramipril}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );
    const mounjaroHtml = render(
      <Glp1MedicationCard
        medication={mounjaro}
        onEdit={() => {}}
        onOpenHistory={() => {}}
      />,
      client,
    );

    for (const html of [ramiprilHtml, mounjaroHtml]) {
      expect(html).toContain("lucide-flame");
      expect(html).toContain("text-warning");
      expect(html).not.toContain("text-orange-400");
      expect(html).not.toContain("text-dracula-orange");
    }
  });
});

/**
 * v1.15.18 — the ONE shared `<MedicationCardBody>` both cards render. These
 * tests pin that the card surface is a CONSTANT neutral surface — dose status
 * is never expressed as a background / border tint (the maintainer, recurring) — while
 * status is still surfaced via the discreet top line / pill, plus the
 * structural identity that makes the two variants impossible to diverge.
 */
describe("medication card body — shared shell + dose-state presentation", () => {
  function renderBody(
    doseStatus: DoseStatus,
    active = true,
    highlighted = false,
  ) {
    return render(
      <MedicationCardBody
        id="m1"
        highlighted={highlighted}
        name="Ramipril"
        dose="5 mg"
        categoryLabel="Blood Pressure"
        active={active}
        href="/medications/m1"
        linkLabel="Open"
        stateBadges={null}
        headerActions={null}
        windowStatus={
          doseStatus === "on_time_window"
            ? { status: "in_window", windowStart: "08:00", windowEnd: "20:00" }
            : null
        }
        doseStatus={doseStatus}
        nextLine="Tomorrow, 08:00"
        lastLine="Today, 07:30"
        compliance={{
          rate7: 90,
          rate30: 88,
          streak: 0,
          shortDays: 7,
          longDays: 30,
        }}
        currentCycle={null}
        intakeLoading={null}
        onRecordIntake={() => {}}
      />,
    );
  }

  it("never tints the card surface when the dose is in its take-window", () => {
    // The maintainer (recurring): the whole card washing green reads as "take it now"
    // and is a permanent removal. The take-window status survives ONLY as the
    // discreet "Take now" pill, never as a card background / ring tint.
    const html = renderBody("on_time_window");
    expect(html).not.toContain("ring-success/40");
    expect(html).not.toContain("bg-success/5");
    // The discreet status pill still communicates the state.
    expect(html).toContain("Take now");
  });

  it("never tints the card surface across any dose status", () => {
    for (const status of [
      "on_time_window",
      "upcoming",
      "taken_on_time",
      "taken_late",
      "skipped",
      "overdue",
      "missed",
    ] as const) {
      const html = renderBody(status);
      expect(html).not.toContain("ring-success/40");
      expect(html).not.toContain("bg-success/5");
    }
  });

  it("shows a calm 'Overdue' top line for an overdue dose", () => {
    const html = renderBody("overdue");
    expect(html).toContain("Overdue");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("Very overdue");
  });

  it("escalates to 'Very overdue' at / past the miss cutoff", () => {
    const html = renderBody("missed");
    expect(html).toContain("Very overdue");
    expect(html).toContain("text-destructive");
  });

  it("keeps the inactive surface muted without any status tint", () => {
    const html = renderBody("on_time_window", false);
    expect(html).not.toContain("ring-success/40");
    expect(html).not.toContain("bg-success/5");
    expect(html).toContain("opacity-60");
  });

  // v1.29.x — the Today digest's "Log dose" deep-link
  // (`/medications?highlight=<id>`) rings the target card, mirroring
  // `<DocumentCard highlighted>`. Carries the id for the page's
  // scroll-into-view lookup regardless of highlight state.
  it("carries the medication id for the deep-link target lookup", () => {
    const html = renderBody("upcoming");
    expect(html).toContain('data-medication-id="m1"');
  });

  it("rings the card when it is the deep-link highlight target", () => {
    const html = renderBody("upcoming", true, true);
    expect(html).toContain("ring-primary");
    expect(html).toContain("ring-2");
  });

  it("does not ring the card when it is not the highlight target", () => {
    const html = renderBody("upcoming", true, false);
    expect(html).not.toContain("ring-primary");
  });

  it("renders the decisive next + last lines exactly once each", () => {
    const html = renderBody("upcoming");
    expect((html.match(/Next intake:/g) ?? []).length).toBe(1);
    expect((html.match(/Last intake:/g) ?? []).length).toBe(1);
    expect(html).toContain("Tomorrow, 08:00");
    expect(html).toContain("Today, 07:30");
  });

  it("keeps the body shell + spacing tokens that guarantee cross-variant identity", () => {
    const html = renderBody("upcoming");
    // Single shared CardContent body with the canonical spacing rhythm.
    expect(html).toContain("flex h-full flex-col space-y-3.5");
    // Bottom-pinned action wrapper.
    expect(html).toContain("mt-auto");
    // The shared reserved-height next/last slot.
    expect(html).toContain("min-h-[2.75rem] space-y-3.5 text-sm");
  });
});

describe("compliance bars — fixed geometry (v1.16.6)", () => {
  /**
   * The two percentage rows must keep an IDENTICAL, fixed geometry no
   * matter the rates, labels, or any status colouring around them: each
   * label line is pinned to one text line (`h-5` + `truncate`) and each
   * bar to `h-2`. A regression here lets a wrapping label or a
   * status-dependent caption make the two bars sit at unequal heights
   * with stray space below (the v1.16.4 card report).
   */
  function geometrySignature(html: string): {
    labelRows: number;
    bars: number;
    truncated: number;
  } {
    return {
      labelRows: (html.match(/flex h-5 items-center justify-between/g) ?? [])
        .length,
      bars: (html.match(/data-slot="progress"/g) ?? []).length,
      truncated: (html.match(/truncate/g) ?? []).length,
    };
  }

  it("pins both rows to the same fixed-height markup regardless of rates", () => {
    const low = render(
      <MedicationComplianceBars rate7={0} rate30={13} streak={0} />,
    );
    const high = render(
      <MedicationComplianceBars rate7={100} rate30={100} streak={9} />,
    );
    const wide = render(
      <MedicationComplianceBars
        rate7={50}
        rate30={50}
        streak={0}
        shortDays={90}
        longDays={365}
      />,
    );

    for (const html of [low, high, wide]) {
      const sig = geometrySignature(html);
      expect(sig.labelRows).toBe(2);
      expect(sig.bars).toBe(2);
      expect(sig.truncated).toBe(2);
      // Both bars carry the same fixed track height.
      expect(html.match(/data-slot="progress"[^>]*h-2/g) ?? []).toHaveLength(2);
    }
  });

  it("rate / streak changes alter text only, never the geometry classes", () => {
    const a = render(
      <MedicationComplianceBars rate7={0} rate30={0} streak={0} />,
    );
    const b = render(
      <MedicationComplianceBars rate7={100} rate30={42} streak={0} />,
    );
    // Strip text nodes; the remaining tag/class skeleton must be identical
    // between a 0% and a 100% card (transform style varies with the value
    // by design, so it is normalised too — as are the two rate attributes the
    // block publishes, which are the value and not the geometry).
    const skeleton = (html: string) =>
      html
        .replace(/>[^<]+</g, "><")
        .replace(/transform:[^;"]+/g, "transform:X")
        .replace(/aria-valuenow="\d+"/g, 'aria-valuenow="N"')
        .replace(/data-state="[^"]*"/g, 'data-state="S"')
        .replace(/data-value="[^"]*"/g, 'data-value="V"')
        .replace(/data-rate-short="[^"]*"/g, 'data-rate-short="R"')
        .replace(/data-rate-long="[^"]*"/g, 'data-rate-long="R"')
        .replace(/data-max="[^"]*"/g, 'data-max="M"');
    expect(skeleton(a)).toBe(skeleton(b));
  });
});

/**
 * v1.16.8 — when the batched compliance query FAILS (post-retry), the
 * card swaps the loading skeleton for a quiet error fallback: same
 * two-row footprint (no layout jump), no bars (a failed read must not
 * paint a 0 % adherence), one muted notice line + a small retry that
 * refetches the shared query. Without it the swallowed-error path left
 * every card on a permanent skeleton with no recovery affordance.
 */
describe("compliance error fallback (v1.16.8)", () => {
  function renderBodyCompliance(args: {
    compliance: boolean;
    complianceError?: boolean;
  }) {
    return render(
      <MedicationCardBody
        id="m1"
        name="Ramipril"
        dose="5 mg"
        categoryLabel="Blood Pressure"
        active
        href="/medications/m1"
        linkLabel="Open"
        stateBadges={null}
        headerActions={null}
        windowStatus={null}
        doseStatus="upcoming"
        nextLine="Tomorrow, 08:00"
        lastLine="Today, 07:30"
        compliance={
          args.compliance
            ? { rate7: 90, rate30: 88, streak: 0, shortDays: 7, longDays: 30 }
            : null
        }
        complianceError={args.complianceError}
        onRetryCompliance={() => {}}
        currentCycle={null}
        intakeLoading={null}
        onRecordIntake={() => {}}
      />,
    );
  }

  it("renders the notice line and the retry affordance, no progress bars", () => {
    const html = render(<MedicationComplianceError onRetry={() => {}} />);
    expect(html).toContain("Adherence could not be loaded");
    expect(html).toContain("Retry");
    expect(html).not.toContain('data-slot="progress"');
  });

  it("mirrors the skeleton's two-row footprint so the card height holds", () => {
    const error = render(<MedicationComplianceError onRetry={() => {}} />);
    // Two h-5 label lines + two h-2 bar-height slots — exactly the
    // skeleton's reserved geometry, so failed/loading/loaded states all
    // occupy the same space.
    expect((error.match(/flex h-5 items-center/g) ?? []).length).toBe(2);
    expect((error.match(/h-2 rounded/g) ?? []).length).toBe(2);
  });

  it("the body shows the error fallback instead of the skeleton on a failed query", () => {
    const html = renderBodyCompliance({
      compliance: false,
      complianceError: true,
    });
    expect(html).toContain("Adherence could not be loaded");
    expect(html).toContain("Retry");
    // Not the aria-hidden loading skeleton.
    expect(html).not.toContain('aria-hidden="true"><div class="space-y-1.5"');
  });

  it("the body keeps the skeleton while the query is merely in flight", () => {
    const html = renderBodyCompliance({ compliance: false });
    expect(html).not.toContain("Adherence could not be loaded");
  });

  it("resolved data still renders the bars even when a stale error flag lingers", () => {
    // A successful refetch clears the failure visually: data wins.
    const html = renderBodyCompliance({
      compliance: true,
      complianceError: true,
    });
    expect(html).toContain('data-slot="progress"');
    expect(html).not.toContain("Adherence could not be loaded");
  });
});
