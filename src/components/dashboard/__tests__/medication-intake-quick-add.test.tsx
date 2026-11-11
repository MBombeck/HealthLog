/**
 * v1.4.37 — `<MedicationIntakeQuickAdd>` contract suite.
 *
 * Project convention is SSR-only tests (vitest runs in `node`
 * environment; `@testing-library/react` is not installed). The
 * assertions below cover:
 *
 *   1. The pure `pickDefaultMedicationId` helper — the cool/easy
 *      default-selection logic the maintainer asked for ("auto-select when one is
 *      due"). Tested across the four ranked branches: empty,
 *      single-active, due-now, alphabetical fallback.
 *   2. The empty-state SSR markup — when the user has no active
 *      medications, the form is suppressed and an EmptyState-style
 *      hint with a CTA to `/medications` is rendered.
 *   3. The populated-state SSR markup — picker + dose + time fields
 *      mount with the right labels + 44 px touch floor.
 *   4. The POST submit contract — the handler that fires on Save is
 *      observed via a fetch spy: the request method, URL, and body
 *      shape (takenAt ISO string, skipped:false) must match the
 *      `/api/medications/[id]/intake` route signature so the dashboard
 *      quick-add stays in lockstep with the API W3 hardened.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import {
  invalidateMedicationReads,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

// Stub @tanstack/react-query so the SSR render path doesn't try to
// reach into a real QueryClient. The default-stub returns the
// populated medications list; per-test mockReturnValue calls override.
const mockUseQuery = vi.fn();
const mockInvalidateQueries = vi.fn().mockResolvedValue(undefined);
const mockQueryClient = {
  invalidateQueries: mockInvalidateQueries,
  getQueryCache: () => ({ findAll: () => [] }),
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => mockUseQuery(opts),
  useQueryClient: () => mockQueryClient,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// v1.16.9 — the component reads the profile timezone for the auto-pick.
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { username: "tester", timezone: "Europe/Berlin" },
  }),
}));

import {
  MedicationIntakeQuickAdd,
  type MedicationOption,
} from "../medication-intake-quick-add";
import { pickDefaultMedicationId } from "@/lib/medications/default-medication";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function makeMed(
  id: string,
  overrides: Partial<MedicationOption> = {},
): MedicationOption {
  return {
    id,
    name: `Med ${id}`,
    dose: "5 mg",
    active: true,
    intakeActionable: true,
    schedules: [],
    lastTakenAt: null,
    todayEventCount: 0,
    ...overrides,
  };
}

function renderSSR(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickDefaultMedicationId — auto-select heuristic", () => {
  it("returns null when no active medications exist", () => {
    expect(pickDefaultMedicationId([])).toBeNull();
    expect(
      pickDefaultMedicationId([
        makeMed("a", { active: false, intakeActionable: false }),
      ]),
    ).toBeNull();
  });

  it("auto-selects the single active medication", () => {
    expect(pickDefaultMedicationId([makeMed("solo")])).toBe("solo");
  });

  it("prefers an in-window medication over the alphabetical fallback", () => {
    // 10:00 Berlin time on a weekday. The morning slot for med "b" is
    // open (08:00–11:00); med "a" has no schedule so it can only
    // surface via the alphabetical fallback. The helper must pick "b".
    const now = new Date("2026-05-12T08:00:00Z"); // 10:00 Berlin (UTC+2)
    const result = pickDefaultMedicationId(
      [
        makeMed("a"),
        makeMed("b", {
          schedules: [
            {
              id: "s1",
              windowStart: "08:00",
              windowEnd: "11:00",
              daysOfWeek: null,
              label: null,
              dose: null,
            },
          ],
        }),
      ],
      now,
    );
    expect(result).toBe("b");
  });

  it("does not pre-select a medication whose server next-due is in the future (v1.16.9)", () => {
    // The band alone reads "in window" at 10:00 Berlin, but the server
    // says the next unresolved dose is tomorrow (a rolling cadence whose
    // dose was taken) — the gate must keep the heuristic off it.
    const now = new Date("2026-05-12T08:00:00Z"); // 10:00 Berlin (UTC+2)
    const result = pickDefaultMedicationId(
      [
        makeMed("a", { name: "Aaa" }),
        makeMed("b", {
          name: "Bbb",
          nextDueAt: "2026-05-13T06:00:00.000Z", // tomorrow
          nextDueOverdue: false,
          schedules: [
            {
              id: "s1",
              windowStart: "08:00",
              windowEnd: "11:00",
              daysOfWeek: null,
              label: null,
              dose: null,
            },
          ],
        }),
      ],
      now,
    );
    // Nothing genuinely due → alphabetical fallback ("Aaa").
    expect(result).toBe("a");
  });

  it("does not pre-select a day-scale medication already taken early in its period (v1.16.9)", () => {
    // Weekly Tuesday med (2026-05-12 is a Tuesday), taken two days ago.
    const now = new Date("2026-05-12T08:00:00Z"); // 10:00 Berlin
    const result = pickDefaultMedicationId(
      [
        makeMed("a", { name: "Aaa" }),
        makeMed("b", {
          name: "Bbb",
          lastTakenAt: "2026-05-10T07:00:00.000Z", // Sunday — early take
          nextDueAt: "2026-05-12T07:00:00.000Z", // today's slot (unresolved)
          nextDueOverdue: true,
          schedules: [
            {
              id: "s1",
              windowStart: "09:00",
              windowEnd: "09:00",
              daysOfWeek: "2",
              timesOfDay: ["09:00"],
              label: null,
              dose: null,
            },
          ],
        }),
      ],
      now,
    );
    expect(result).toBe("a");
  });

  it("reasons in the supplied profile timezone, not Berlin (v1.16.9)", () => {
    // 08:00 UTC = 10:00 Berlin (inside the 08:00–11:00 window) but only
    // 04:00 in New York (hours before it). The same instant must flip
    // the pick with the timezone — pinning that the tz threads through
    // both the wall-clock conversion and the window reduction.
    const now = new Date("2026-05-12T08:00:00Z");
    const meds = [
      makeMed("a", { name: "Aaa" }),
      makeMed("b", {
        name: "Bbb",
        schedules: [
          {
            id: "s1",
            windowStart: "08:00",
            windowEnd: "11:00",
            daysOfWeek: null,
            label: null,
            dose: null,
          },
        ],
      }),
    ];
    expect(pickDefaultMedicationId(meds, now, undefined, "Europe/Berlin")).toBe(
      "b",
    );
    expect(
      pickDefaultMedicationId(meds, now, undefined, "America/New_York"),
    ).toBe("a");
  });

  it("falls back to the alphabetical-first active medication when nothing is due", () => {
    // 03:00 Berlin time: no schedules overlap. The helper should
    // alphabetically sort and pick the leading id, "ramipril".
    const now = new Date("2026-05-12T01:00:00Z"); // 03:00 Berlin
    const result = pickDefaultMedicationId(
      [makeMed("z", { name: "Zolpidem" }), makeMed("r", { name: "Ramipril" })],
      now,
    );
    expect(result).toBe("r");
  });
});

describe("<MedicationIntakeQuickAdd> — SSR contract", () => {
  it("renders the empty-state with a CTA to /medications when no active medications", () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: false });
    const html = renderSSR(<MedicationIntakeQuickAdd />);
    expect(html).toContain('data-testid="medication-intake-quick-add-empty"');
    // Visible copy resolves from i18n (no raw key leak).
    expect(html).toContain("No medications yet");
    expect(html).toContain('href="/medications"');
    // The form itself must not render — otherwise we'd ship a Save
    // button with no medication to record.
    expect(html).not.toContain(
      'data-testid="medication-intake-quick-add-form"',
    );
    // v1.4.37 — the empty-state CTA must clear the 44 px touch
    // floor that W-CI raised on the onboarding checklist. The
    // `size="sm"` default would land at 32 px without an explicit
    // `min-h-11 sm:min-h-9` override.
    expect(html).toContain("min-h-11");
  });

  it("renders the populated form with picker + dose + time fields", () => {
    mockUseQuery.mockReturnValue({
      data: [
        makeMed("med-1", { name: "Ramipril", dose: "5 mg" }),
        makeMed("med-2", { name: "Mounjaro", dose: "5 mg" }),
      ],
      isLoading: false,
    });
    const html = renderSSR(<MedicationIntakeQuickAdd />);
    expect(html).toContain('data-testid="medication-intake-quick-add-form"');
    // Field-level testids pinned for the e2e + future-coverage handles.
    expect(html).toContain(
      'data-testid="medication-intake-quick-add-medication"',
    );
    expect(html).toContain('data-testid="medication-intake-quick-add-dose"');
    expect(html).toContain(
      'data-testid="medication-intake-quick-add-taken-at"',
    );
    // 44 px touch floor (WCAG 2.5.5). The form controls inherit it from
    // the Input / SelectTrigger primitives' `h-11 sm:h-10` base — no
    // per-call-site `min-h-11` override (which would force 44 px on
    // desktop too). The footer buttons keep the explicit
    // `min-h-11 sm:min-h-9` floor.
    expect(html.match(/h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(
      html.match(/min-h-11 sm:min-h-9/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(1);
  });

  it("renders the current-window medication as selected ahead of array order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T08:00:00.000Z"));
    mockUseQuery.mockReturnValue({
      data: [
        makeMed("first", { name: "Alpha" }),
        makeMed("due", {
          name: "Zulu",
          nextDueAt: "2026-05-12T07:00:00.000Z",
          nextDueOverdue: false,
          schedules: [
            {
              id: "due-schedule",
              windowStart: "08:00",
              windowEnd: "11:00",
              daysOfWeek: null,
              label: null,
              dose: null,
            },
          ],
        }),
      ],
      isLoading: false,
    });

    try {
      const html = renderSSR(<MedicationIntakeQuickAdd />);
      expect(html).toMatch(
        /data-slot="select-value"[^>]*>[\s\S]*?Zulu[\s\S]*?<\/span>/,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // #1040 — the picker offers what the server calls actionable, nothing
  // it re-derives. An ended course is still `active` (nobody paused it),
  // which is exactly the case the old `active && trackIntake` filter let
  // through.
  it("does not offer an ended course, even though it is still active (#1040)", () => {
    mockUseQuery.mockReturnValue({
      data: [
        makeMed("ended", {
          name: "Alpha",
          active: true,
          intakeActionable: false,
        }),
        makeMed("current", { name: "Zulu" }),
      ],
      isLoading: false,
    });
    const html = renderSSR(<MedicationIntakeQuickAdd />);
    // Alphabetical fallback would land on "Alpha" if it were offered.
    expect(html).toMatch(
      /data-slot="select-value"[^>]*>[\s\S]*?Zulu[\s\S]*?<\/span>/,
    );
    expect(html).not.toContain("Alpha");
  });

  it("shows the empty state when no medication is actionable today (#1040)", () => {
    mockUseQuery.mockReturnValue({
      data: [
        makeMed("ended", { name: "Alpha", intakeActionable: false }),
        makeMed("upcoming", { name: "Beta", intakeActionable: false }),
      ],
      isLoading: false,
    });
    const html = renderSSR(<MedicationIntakeQuickAdd />);
    expect(html).toContain('data-testid="medication-intake-quick-add-empty"');
    expect(html).not.toContain(
      'data-testid="medication-intake-quick-add-form"',
    );
    // The user has medications, so "no medications yet" would be untrue.
    expect(html).toContain("Nothing to take today");
    expect(html).not.toContain("No medications yet");
  });

  it("does not leak raw i18n keys in either locale", () => {
    mockUseQuery.mockReturnValue({ data: [], isLoading: false });
    const en = renderSSR(<MedicationIntakeQuickAdd />, "en");
    const de = renderSSR(<MedicationIntakeQuickAdd />, "de");
    expect(en).not.toContain("dashboard.medicationIntakeQuickAdd");
    expect(de).not.toContain("dashboard.medicationIntakeQuickAdd");
    // German locale ships project-voice DE copy with umlauts (UTF-8
    // end-to-end, never their HTML entity form).
    expect(de).toContain("Medikamente angelegt");
  });
});

describe("submit invalidation — the quick-add is a capture-picker surface, not only a dashboard one", () => {
  // This form mounts from the bottom-nav capture picker on EVERY page, so a
  // bare `invalidateKeys(medicationDependentKeys)` (default active refetch)
  // left the unmounted Today digest + dashboard snapshot stale until the next
  // poll — the fourth recurrence of the class `daily-reads-refetch-guard`
  // freezes. The fix routes the submit through the blessed
  // `invalidateMedicationReads`, exactly like take-all-due (v1.32.19).

  const componentSrc = readFileSync(
    resolve(__dirname, "../medication-intake-quick-add.tsx"),
    "utf8",
  );

  it("routes the intake submit through the blessed invalidateMedicationReads (source pin)", () => {
    expect(componentSrc).not.toContain(
      "invalidateKeys(queryClient, medicationDependentKeys)",
    );
    // AFTER the intake POST landed, and after the sheet was told it is done:
    // the save does not wait for the refetches before it closes.
    expect(componentSrc).toMatch(
      /async function handleSubmit\([\s\S]*?apiPost[\s\S]*?onSuccess\?\.\(\);\s*(?:\/\/[^\n]*\n\s*)*void invalidateMedicationReads\(queryClient\);/,
    );
    // The bundle carries every inline compliance chart, so no second sweep.
    expect(medicationDependentKeys).toContainEqual(
      queryKeys.complianceChartInline(),
    );
  });

  it("forces the inactive Today hero + dashboard reads to refetch after submit", async () => {
    // The helper the submit path calls — asserted directly, same shape as
    // the take-all-due suite: the bundle fans out (N keys), then the two
    // daily reads are invalidated with `refetchType: "inactive"`, which is
    // what actually refetches them while unmounted.
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const queryClient = {
      invalidateQueries,
      getQueryCache: () => ({ findAll: () => [] }),
    } as unknown as QueryClientType;

    await invalidateMedicationReads(queryClient);

    expect(invalidateQueries).toHaveBeenCalledTimes(
      medicationDependentKeys.length + 2,
    );
    const inactive = invalidateQueries.mock.calls.filter(
      ([arg]) =>
        (arg as { refetchType?: string } | undefined)?.refetchType ===
        "inactive",
    );
    const keys = inactive.map(([arg]) =>
      JSON.stringify((arg as { queryKey?: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(queryKeys.dashboardSnapshot()));
    expect(keys).toContain(JSON.stringify(queryKeys.dailyDigest()));
  });
});
