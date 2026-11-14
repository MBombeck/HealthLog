import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";

import { toast } from "sonner";
import { I18nProvider } from "@/lib/i18n/context";
import { medicationDependentKeys } from "@/lib/query-keys";
import {
  deriveDueMedications,
  runTakeAllDue,
  type DueDerivationMedication,
  type DueMedication,
} from "@/components/medications/take-all-due";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

/**
 * v1.16.11 (#316) — "take all due at once" coverage.
 *
 * 1. `deriveDueMedications` — the due set mirrors the card pills by
 *    construction: only ACTIVE, UNPAUSED medications with a non-null
 *    current-window status that is not the day-scale taken-early
 *    downgrade, gated on the server display-due exactly like the cards.
 * 2. `runTakeAllDue` — per-medication POST loop with failure isolation:
 *    each due medication posts to ITS OWN intake route with the displayed
 *    slot's `scheduledFor`, the summary toast reports the partial-failure
 *    counts, and the dependent-key bundle invalidates once when at least
 *    one take landed.
 * 3. `<TakeAllDueDialog>` — SSR list rendering (name + dose + window) per
 *    the repo's SSR-only component-test convention, plus source-string
 *    pins for the interactive plumbing static markup can't exercise.
 *
 * Fixtures use relative instants anchored on the host's current date
 * (today at a fixed UTC wall-clock hour) — no hardcoded calendar dates.
 */

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The Radix Dialog portals at runtime, so its body never materialises in
// static markup. Collapse the primitives to plain wrappers (same trick as
// the LogInjectionSiteDialog suite) so the list + footer are reachable.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? <div data-slot="mock-dialog">{children}</div> : null),
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});

const { TakeAllDueDialog } = await import("../take-all-due-dialog");

beforeEach(() => {
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Today at the given UTC wall-clock time — relative to the host date. */
function todayAtUtc(hours: number, minutes = 0): Date {
  const d = new Date();
  d.setUTCHours(hours, minutes, 0, 0);
  return d;
}

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;

function fakeQueryClient(): QueryClientType {
  return {
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
    getQueryCache: () => ({ findAll: () => [] }),
  } as unknown as QueryClientType;
}

function makeMed(
  overrides: Partial<DueDerivationMedication> & { id: string },
): DueDerivationMedication {
  return {
    name: `Med ${overrides.id}`,
    dose: "10 mg",
    active: true,
    pausedAt: null,
    lastTakenAt: null,
    todayEventCount: 0,
    schedules: [
      {
        windowStart: "12:00",
        windowEnd: "12:00",
        daysOfWeek: null,
        timesOfDay: ["12:00"],
        dose: null,
      },
    ],
    ...overrides,
  };
}

describe("deriveDueMedications — only currently-due, active, unpaused", () => {
  // Noon UTC today; the 12:00 dose band (±60 min default half-width) is
  // open, the 20:00 band has not opened, the 08:00 band sits in its
  // very_late tail (ended 09:00, missedMinutes 240 → until 13:00).
  const now = todayAtUtc(12, 0);
  const opts = { now, tz: "UTC" };

  it("carries the medication's own note into the confirm list (#1371)", () => {
    const [withNote] = deriveDueMedications(
      [makeMed({ id: "a", note: "With food" })],
      opts,
    );
    expect(withNote?.note).toBe("With food");
    const [without] = deriveDueMedications([makeMed({ id: "b" })], opts);
    expect(without?.note).toBeNull();
  });

  it("includes an in-window medication with its matched band and slot instant", () => {
    const due = deriveDueMedications([makeMed({ id: "a" })], opts);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      id: "a",
      name: "Med a",
      dose: "10 mg",
      window: { start: "11:00", end: "13:00" },
    });
    // The displayed slot instant — today's 12:00 UTC dose, the same value
    // the card's own button would thread as `scheduledFor`.
    expect(due[0].scheduledFor?.toISOString()).toBe(
      todayAtUtc(12, 0).toISOString(),
    );
  });

  it("includes an overdue (very_late) dose still inside its catch-up tail", () => {
    const due = deriveDueMedications(
      [
        makeMed({
          id: "b",
          schedules: [
            {
              windowStart: "08:00",
              windowEnd: "08:00",
              daysOfWeek: null,
              timesOfDay: ["08:00"],
              dose: "5 mg",
            },
          ],
        }),
      ],
      opts,
    );
    expect(due).toHaveLength(1);
    // The matched schedule's dose wins over the medication-level dose.
    expect(due[0].dose).toBe("5 mg");
    expect(due[0].scheduledFor?.toISOString()).toBe(
      todayAtUtc(8, 0).toISOString(),
    );
  });

  it("excludes inactive and paused medications", () => {
    const pausedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const due = deriveDueMedications(
      [
        makeMed({ id: "inactive", active: false }),
        makeMed({ id: "paused", pausedAt }),
        makeMed({ id: "due" }),
      ],
      opts,
    );
    expect(due.map((d) => d.id)).toEqual(["due"]);
  });

  it("excludes a medication whose course has ended, even with an escalated dose (#1040)", () => {
    const due = deriveDueMedications(
      [
        makeMed({ id: "ended", intakeActionable: false }),
        makeMed({ id: "on" }),
      ],
      {
        ...opts,
        doseStatusById: new Map([
          ["ended", "missed" as const],
          ["on", "upcoming" as const],
        ]),
      },
    );
    expect(due.map((d) => d.id)).toEqual(["on"]);
  });

  it("excludes a medication whose dose band is not currently open", () => {
    const due = deriveDueMedications(
      [
        makeMed({
          id: "evening",
          schedules: [
            {
              windowStart: "20:00",
              windowEnd: "20:00",
              daysOfWeek: null,
              timesOfDay: ["20:00"],
              dose: null,
            },
          ],
        }),
      ],
      opts,
    );
    expect(due).toEqual([]);
  });

  it("excludes an as-needed medication (no schedules, never due) — v1.16.11 #316", () => {
    // An as-needed (PRN) medication persists ZERO schedules and the
    // server computes no next-due, so it can NEVER enter the due set —
    // even with a recent ad-hoc intake on record.
    const due = deriveDueMedications(
      [
        makeMed({
          id: "prn",
          schedules: [],
          nextDueAt: null,
          lastTakenAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
          todayEventCount: 1,
        }),
        makeMed({ id: "scheduled" }),
      ],
      opts,
    );
    expect(due.map((m) => m.id)).toEqual(["scheduled"]);
  });

  it("excludes a dose already covered by an actioned intake in its band", () => {
    // Taken 30 minutes ago — inside the open 12:00 band; the in-window
    // suppression (same as the card pill) keeps it out of the due set.
    const due = deriveDueMedications(
      [
        makeMed({
          id: "covered",
          lastTakenAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
          todayEventCount: 1,
        }),
      ],
      opts,
    );
    expect(due).toEqual([]);
  });

  it("honours the server display-due gate: a future non-overdue next-due suppresses", () => {
    const tomorrowNoon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const due = deriveDueMedications(
      [
        makeMed({
          id: "rolling",
          nextDueAt: tomorrowNoon.toISOString(),
          nextDueOverdue: false,
        }),
      ],
      opts,
    );
    expect(due).toEqual([]);
  });

  it("excludes a day-scale dose already taken earlier in its period (taken-early downgrade)", () => {
    // Weekly cadence on today's weekday; the shot landed yesterday — the
    // dose is on board, a "take all" inclusion would prompt a double dose.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const due = deriveDueMedications(
      [
        makeMed({
          id: "weekly",
          lastTakenAt: yesterday.toISOString(),
          schedules: [
            {
              windowStart: "12:00",
              windowEnd: "12:00",
              daysOfWeek: String(now.getUTCDay()),
              timesOfDay: ["12:00"],
              dose: null,
            },
          ],
        }),
      ],
      opts,
    );
    expect(due).toEqual([]);
  });

  it("preserves the input (page) order", () => {
    const due = deriveDueMedications(
      [makeMed({ id: "z" }), makeMed({ id: "a" })],
      opts,
    );
    expect(due.map((d) => d.id)).toEqual(["z", "a"]);
  });
});

describe("deriveDueMedications — compliance-escalated medications (band tail closed)", () => {
  // 14:00 UTC: the 08:00 dose band's catch-up tail closed at 13:00
  // (missedMinutes 240), so the window-derived status is null — but the
  // card still renders the red escalation value with an ACTIVE take
  // button when the batched compliance dose status says overdue/missed.
  const now = todayAtUtc(14, 0);

  const morning = () =>
    makeMed({
      id: "morning",
      schedules: [
        {
          windowStart: "08:00",
          windowEnd: "08:00",
          daysOfWeek: null,
          timesOfDay: ["08:00"],
          dose: null,
        },
      ],
      // The server still serves the open overdue slot as next-due.
      nextDueAt: todayAtUtc(8, 0).toISOString(),
      nextDueOverdue: true,
    });

  it("includes a missed dose past its catch-up tail, recording the card's own displayed slot", () => {
    const due = deriveDueMedications([morning()], {
      now,
      tz: "UTC",
      doseStatusById: new Map([["morning", "missed"]]),
    });
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("morning");
    // Band closed → no matched window for the dialog line.
    expect(due[0].window).toBeNull();
    // EXACTLY what the card's take button records: the same
    // `resolveDisplayedSlotInstant` call resolves (status null) to the
    // server's next-due instant.
    expect(due[0].scheduledFor?.toISOString()).toBe(
      todayAtUtc(8, 0).toISOString(),
    );
  });

  it("matches the count of visible red/due cards: dedupes window-due + escalated, excludes calm doses", () => {
    const inWindow = makeMed({
      id: "in-window",
      schedules: [
        {
          windowStart: "14:00",
          windowEnd: "14:00",
          daysOfWeek: null,
          timesOfDay: ["14:00"],
          dose: null,
        },
      ],
    });
    const evening = makeMed({
      id: "evening",
      schedules: [
        {
          windowStart: "20:00",
          windowEnd: "20:00",
          daysOfWeek: null,
          timesOfDay: ["20:00"],
          dose: null,
        },
      ],
    });
    const due = deriveDueMedications([inWindow, morning(), evening], {
      now,
      tz: "UTC",
      doseStatusById: new Map([
        // The open-window med is ALSO compliance-escalated — it must
        // appear exactly once (the two branches are exclusive).
        ["in-window", "overdue"],
        ["morning", "missed"],
        ["evening", "upcoming"],
      ]),
    });
    expect(due.map((d) => d.id)).toEqual(["in-window", "morning"]);
  });

  it("never includes an as-needed medication, even with a (bogus) escalated compliance row", () => {
    const prn = makeMed({
      id: "prn",
      asNeeded: true,
      schedules: [],
      nextDueAt: null,
    });
    const due = deriveDueMedications([prn], {
      now,
      tz: "UTC",
      doseStatusById: new Map([["prn", "missed"]]),
    });
    expect(due).toEqual([]);
  });

  it("does not escalate without a compliance verdict (window-only derivation stays the floor)", () => {
    const due = deriveDueMedications([morning()], { now, tz: "UTC" });
    expect(due).toEqual([]);
  });
});

describe("runTakeAllDue — per-medication loop with failure isolation", () => {
  const slotA = new Date(Date.now() - 60 * 60 * 1000);
  const slotB = new Date(Date.now() - 30 * 60 * 1000);
  const dueTwo: DueMedication[] = [
    {
      id: "med-a",
      name: "A",
      dose: "10 mg",
      window: null,
      scheduledFor: slotA,
    },
    { id: "med-b", name: "B", dose: "5 mg", window: null, scheduledFor: slotB },
  ];

  function okResponse(id: string) {
    return {
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({ data: { id } }),
      text: vi.fn().mockResolvedValue(JSON.stringify({ data: { id } })),
    };
  }

  it("posts each due medication to ITS intake route with the displayed slot, exactly like a card tap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse("evt-a"))
      .mockResolvedValueOnce(okResponse("evt-b"));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = fakeQueryClient();

    const result = await runTakeAllDue({ medications: dueTwo, t, queryClient });

    expect(result).toEqual({ taken: 2, failed: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/medications/med-a/intake");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/medications/med-b/intake");
    const bodyA = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(bodyA).toEqual({
      skipped: false,
      scheduledFor: slotA.toISOString(),
    });
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'medications.takeAllDue.successToast:{"count":2}',
    );
    vi.unstubAllGlobals();
  });

  it("omits scheduledFor for a PRN due entry (null slot), preserving the server now-snap path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("evt-prn"));
    vi.stubGlobal("fetch", fetchMock);

    await runTakeAllDue({
      medications: [
        { id: "med-p", name: "P", dose: "", window: null, scheduledFor: null },
      ],
      t,
      queryClient: fakeQueryClient(),
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ skipped: false });
    expect(body).not.toHaveProperty("scheduledFor");
    vi.unstubAllGlobals();
  });

  it("reports a partial failure ('1 recorded, 1 failed') and still invalidates for the landed take", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse("evt-a"))
      .mockResolvedValueOnce({
        ok: false,
        headers: new Headers(),
        json: vi.fn(),
        text: vi.fn(),
      });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = fakeQueryClient();

    const result = await runTakeAllDue({ medications: dueTwo, t, queryClient });

    expect(result).toEqual({ taken: 1, failed: 1 });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      'medications.takeAllDue.partialToast:{"taken":1,"failed":1}',
    );
    expect(vi.mocked(toast.success)).not.toHaveBeenCalledWith(
      expect.stringContaining("successToast"),
    );
    // The landed take must reach every dependent consumer AND force the two
    // inactive daily reads (dashboard snapshot + Today digest) to refetch —
    // the blessed `invalidateMedicationReads` fans out the bundle (N keys)
    // then invalidates those two with `refetchType: "inactive"`.
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(
      medicationDependentKeys.length + 2,
    );
    vi.unstubAllGlobals();
  });

  it("forces the inactive Today hero + dashboard reads to refetch after a landed take (v1.32.19 stale-hero fix)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse("evt-a"));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = fakeQueryClient();

    await runTakeAllDue({
      medications: [dueTwo[0]],
      t,
      queryClient,
    });

    // The batch button lives on `/medications`, where the digest + snapshot
    // are UNMOUNTED. A bare bundle invalidation (default active refetch) would
    // leave them stale — so the helper MUST invalidate both with
    // `refetchType: "inactive"`, which is what actually refetches them.
    const calls = vi.mocked(queryClient.invalidateQueries).mock.calls;
    const inactive = calls.filter(
      ([arg]) =>
        (arg as { refetchType?: string } | undefined)?.refetchType ===
        "inactive",
    );
    const keys = inactive.map(([arg]) =>
      JSON.stringify((arg as { queryKey?: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(["dashboard", "snapshot"]));
    expect(keys).toContain(JSON.stringify(["daily", "digest"]));
    vi.unstubAllGlobals();
  });

  it("reports total failure without invalidating (nothing changed server-side)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        headers: new Headers(),
        json: vi.fn(),
        text: vi.fn(),
      }),
    );
    const queryClient = fakeQueryClient();

    const result = await runTakeAllDue({ medications: dueTwo, t, queryClient });

    expect(result).toEqual({ taken: 0, failed: 2 });
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "medications.takeAllDue.failedToast",
    );
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("routes the batch invalidation through the blessed invalidateMedicationReads (source pin)", () => {
    // v1.32.19 — the batch take now routes through the one blessed helper,
    // which fans out `medicationDependentKeys` AND forces the inactive digest
    // + snapshot to refetch (the maintainer's stale-hero repro). Pin the
    // source so a revert to a bare bundle invalidation cannot slip through.
    const src = readFileSync(resolve(__dirname, "../take-all-due.ts"), "utf8");
    expect(src).toContain("await invalidateMedicationReads(queryClient)");
    expect(src).not.toContain(
      "invalidateKeys(queryClient, medicationDependentKeys)",
    );
  });
});

describe("<TakeAllDueDialog> — confirm dialog lists the due medications", () => {
  const dialogSrc = readFileSync(
    resolve(__dirname, "../take-all-due-dialog.tsx"),
    "utf8",
  );
  const pageSrc = readFileSync(
    resolve(__dirname, "../../../app/medications/page-client.tsx"),
    "utf8",
  );

  function render(node: React.ReactNode): string {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </I18nProvider>,
    );
  }

  const due: DueMedication[] = [
    {
      id: "med-a",
      name: "Metoprolol",
      dose: "47,5 mg",
      window: { start: "07:00", end: "09:00" },
      scheduledFor: new Date(Date.now() - 60 * 60 * 1000),
    },
    {
      id: "med-b",
      name: "Vitamin D",
      dose: "20 000 IE",
      window: { start: "11:00", end: "13:00" },
      scheduledFor: new Date(Date.now() - 5 * 60 * 1000),
    },
  ];

  it("renders each due medication with name, dose and window plus the confirm/cancel footer", () => {
    const html = render(
      <TakeAllDueDialog open onOpenChange={vi.fn()} dueMedications={due} />,
    );
    expect(html).toContain("Metoprolol");
    expect(html).toContain("47,5 mg");
    expect(html).toContain("Vitamin D");
    // DE window formatting via the shared formatter.
    expect(html).toContain("07:00 bis 09:00 Uhr");
    expect(html).toContain("11:00 bis 13:00 Uhr");
    // Title + confirm carrying the count, German du-Form copy.
    expect(html).toContain("Fällige Medikamente einnehmen");
    expect(html).toContain("Alle einnehmen (2)");
    expect(html).toContain("Abbrechen");
  });

  it("lists each medication's own note under its name (#1371)", () => {
    const html = render(
      <TakeAllDueDialog
        open
        onOpenChange={vi.fn()}
        dueMedications={[
          { ...due[0], note: "Vor dem Frühstück" },
          { ...due[1], note: null },
        ]}
      />,
    );
    expect(html.match(/data-slot="take-all-due-note"/g)).toHaveLength(1);
    expect(html).toContain("Vor dem Frühstück");
    expect(html.indexOf("Metoprolol")).toBeLessThan(
      html.indexOf("Vor dem Frühstück"),
    );
  });

  it("does not render when closed", () => {
    const html = render(
      <TakeAllDueDialog
        open={false}
        onOpenChange={vi.fn()}
        dueMedications={due}
      />,
    );
    expect(html).toBe("");
  });

  it("guards the take loop behind a submitting state and refuses to close mid-flight (source pin)", () => {
    expect(dialogSrc).toContain(
      "const [submitting, setSubmitting] = useState(false)",
    );
    expect(dialogSrc).toMatch(
      /async function handleConfirm\(\) \{[\s\S]*setSubmitting\(true\)[\s\S]*await runTakeAllDue\([\s\S]*finally \{[\s\S]*setSubmitting\(false\)/,
    );
    expect(dialogSrc).toContain("if (submitting && !next) return;");
    // 44-px mobile tap floor on both footer actions.
    expect(dialogSrc).toContain('className="min-h-11 sm:min-h-9"');
  });

  it("earns its medications-page header slot only when at least two medications are due (source pin)", () => {
    expect(pageSrc).toContain("dueMeds.length >= 2 && (");
    expect(pageSrc).toContain("deriveDueMedications(activeMeds");
    expect(pageSrc).toContain('t("medications.takeAllDue.button")');
  });
});
