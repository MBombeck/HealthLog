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
 * 1. `deriveDueMedications` — the due set mirrors the cards by
 *    construction: only ACTIVE, UNPAUSED medications whose server-resolved
 *    open dose is due, overdue or missed, read exactly like the cards.
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
    schedules: [{ windowStart: "12:00", timesOfDay: ["12:00"], dose: null }],
    ...overrides,
  };
}

/** A server-resolved open dose for a slot at `hours` UTC today. */
function openDose(hours: number, state = "due") {
  const at = todayAtUtc(hours);
  const h = 60 * 60 * 1000;
  return {
    state,
    targetAt: at.toISOString(),
    dueAt: new Date(at.getTime() - h).toISOString(),
    overdueSince: new Date(at.getTime() + h).toISOString(),
    missedAfter: new Date(at.getTime() + 5 * h).toISOString(),
  };
}

describe("deriveDueMedications — the server-resolved open dose, active and unpaused", () => {
  // Noon UTC today: the 12:00 dose is due (window 11:00 to 13:00), the
  // 08:00 dose is overdue until 13:00, the 20:00 dose is pending.
  const now = todayAtUtc(12, 0);
  const doses = new Map([
    ["a", openDose(12)],
    ["b", openDose(8, "overdue")],
    ["evening", openDose(20, "upcoming")],
    ["inactive", openDose(12)],
    ["paused", openDose(12)],
    ["ended", openDose(8, "missed")],
    ["prn", openDose(12)],
    ["covered", { ...openDose(12), state: "taken" }],
  ]);
  const opts = { now, tz: "UTC", currentDoseById: doses };

  it("carries the medication's own note into the confirm list (#1371)", () => {
    const [withNote] = deriveDueMedications(
      [makeMed({ id: "a", note: "With food" })],
      opts,
    );
    expect(withNote?.note).toBe("With food");
  });

  it("includes a due medication with the server's window and slot", () => {
    const due = deriveDueMedications([makeMed({ id: "a" })], opts);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      id: "a",
      name: "Med a",
      dose: "10 mg",
      window: { start: "11:00", end: "13:00" },
    });
    expect(due[0].scheduledFor?.toISOString()).toBe(
      todayAtUtc(12, 0).toISOString(),
    );
  });

  it("includes an overdue dose, with the dose of the schedule on that slot", () => {
    const due = deriveDueMedications(
      [
        makeMed({
          id: "b",
          schedules: [
            { windowStart: "08:00", timesOfDay: ["08:00"], dose: "5 mg" },
          ],
        }),
      ],
      opts,
    );
    expect(due).toHaveLength(1);
    expect(due[0].dose).toBe("5 mg");
    expect(due[0].scheduledFor?.toISOString()).toBe(
      todayAtUtc(8, 0).toISOString(),
    );
  });

  it("excludes inactive, paused, ended, as-needed, pending and taken doses", () => {
    const pausedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const due = deriveDueMedications(
      [
        makeMed({ id: "inactive", active: false }),
        makeMed({ id: "paused", pausedAt }),
        makeMed({ id: "ended", intakeActionable: false }),
        makeMed({ id: "prn", asNeeded: true, schedules: [] }),
        makeMed({ id: "evening" }),
        makeMed({ id: "covered" }),
        makeMed({ id: "a" }),
      ],
      opts,
    );
    expect(due.map((d) => d.id)).toEqual(["a"]);
  });

  it("is empty for a medication whose compliance row has not loaded", () => {
    expect(deriveDueMedications([makeMed({ id: "nope" })], opts)).toEqual([]);
  });

  it("moves a fetched dose along its instants: a pending dose turns due on time", () => {
    const due = deriveDueMedications([makeMed({ id: "evening" })], {
      ...opts,
      now: todayAtUtc(19, 30),
    });
    expect(due.map((d) => d.id)).toEqual(["evening"]);
  });

  it("includes a missed dose (a late take still counts) without a window", () => {
    const due = deriveDueMedications([makeMed({ id: "b" })], {
      ...opts,
      now: todayAtUtc(14, 0),
    });
    expect(due).toHaveLength(1);
    expect(due[0].window).toBeNull();
    expect(due[0].scheduledFor?.toISOString()).toBe(
      todayAtUtc(8, 0).toISOString(),
    );
  });

  it("preserves the input (page) order", () => {
    const due = deriveDueMedications(
      [makeMed({ id: "b" }), makeMed({ id: "a" })],
      opts,
    );
    expect(due.map((d) => d.id)).toEqual(["b", "a"]);
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
    // One Undo for the whole sweep, as a single take has one.
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'medications.takeAllDue.successToast:{"count":2}',
      expect.objectContaining({
        action: expect.objectContaining({ onClick: expect.any(Function) }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("its one Undo removes exactly the rows the sweep wrote", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse("evt-a"))
      .mockResolvedValueOnce(okResponse("evt-b"))
      .mockResolvedValue(okResponse("deleted"));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = fakeQueryClient();
    vi.mocked(toast.success).mockClear();

    await runTakeAllDue({ medications: dueTwo, t, queryClient });
    const options = vi.mocked(toast.success).mock.calls[0][1] as unknown as {
      action: { onClick: () => void };
    };
    options.action.onClick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/medications/med-a/intake/evt-a",
    );
    expect(fetchMock.mock.calls[3][0]).toBe(
      "/api/medications/med-b/intake/evt-b",
    );
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
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
