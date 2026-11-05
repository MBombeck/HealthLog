import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The visits surface's designed states, pinned by single-pass static renders.
 *
 *   - an account with no visits paints the empty state and one action, not an
 *     error and not a teaching wall;
 *   - upcoming sorts above past, in the two lists the SERVER split — the
 *     client renders the order it was given rather than re-deriving one;
 *   - a soft-deleted visit never arrives, so it cannot be rendered. That is a
 *     server property and the API test owns it; what this file pins is that
 *     the section renders exactly what the response carried, with nothing
 *     filtered or re-sorted on this side that could disagree with it.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: {} },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({
    canManage: true,
    canWrite: true,
    canWriteDomain: () => true,
    canManageDomain: () => true,
  }),
}));

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return {
    ...actual,
    // Never resolves inside a synchronous render, so an unseeded query stays
    // pending and cannot accidentally satisfy an assertion.
    apiGet: () => new Promise(() => {}),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import { todayKeyInZone } from "@/components/day/day-url";
import { ApiError } from "@/lib/api/api-fetch";
import type { DayNotableWindowResponse } from "@/lib/day/contract";
import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { EncounterDTO } from "@/lib/encounters/dto";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { VisitsSection } from "../visits-section";

function visit(over: Partial<EncounterDTO> & { id: string }): EncounterDTO {
  return {
    occurredAt: "2026-08-01T09:00:00.000Z",
    status: "DONE",
    kind: "ROUTINE",
    practitioner: null,
    reason: null,
    outcome: null,
    bodySite: null,
    laterality: null,
    reminderNextDueAt: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

function render(
  list: { upcoming: EncounterDTO[]; past: EncounterDTO[] },
  seed?: (queryClient: QueryClient) => void,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  queryClient.setQueryData(
    queryKeys.encounterList(null, null, undefined, undefined),
    list,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <VisitsSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<VisitsSection>", () => {
  it("paints the empty state, with one action, when there is no visit", () => {
    const html = render({ upcoming: [], past: [] });
    expect(html).toContain("No visit recorded yet");
    expect(html).toContain("A date is enough");
    expect(html).toContain('data-slot="visits-add"');
    // An empty account is not an error, and the two states never share copy.
    expect(html).not.toContain("Visits could not be loaded.");
    expect(html).not.toContain('data-slot="visits-upcoming"');
  });

  it("puts the upcoming list above the past one", () => {
    const html = render({
      upcoming: [visit({ id: "later", status: "PLANNED" })],
      past: [visit({ id: "earlier" })],
    });
    const upcomingAt = html.indexOf('data-slot="visits-upcoming"');
    const pastAt = html.indexOf('data-slot="visits-past"');
    expect(upcomingAt).toBeGreaterThan(-1);
    expect(pastAt).toBeGreaterThan(-1);
    expect(upcomingAt).toBeLessThan(pastAt);
    expect(html.indexOf('data-encounter-id="later"')).toBeLessThan(
      html.indexOf('data-encounter-id="earlier"'),
    );
  });

  it("renders the server's order inside a list rather than re-sorting it", () => {
    // Two rows deliberately handed over in an order the client has no reason
    // to like. Re-sorting here would be the second place the ordering lives.
    const html = render({
      upcoming: [],
      past: [
        visit({ id: "second", occurredAt: "2026-07-01T09:00:00.000Z" }),
        visit({ id: "first", occurredAt: "2026-08-01T09:00:00.000Z" }),
      ],
    });
    expect(html.indexOf('data-encounter-id="second"')).toBeLessThan(
      html.indexOf('data-encounter-id="first"'),
    );
  });

  it("counts what a visit produced, from the links the LIST carried", () => {
    // The counts come off `links`, and the list used to omit them — every card
    // then read zero for a visit with three documents. The fixture carries a
    // populated `links` because the response now does.
    const html = render({
      upcoming: [],
      past: [
        visit({
          id: "linked",
          links: {
            documents: [
              { id: "d1", label: "Letter", date: null, redacted: false },
              { id: "d2", label: "Scan", date: null, redacted: false },
            ],
            labResults: [
              { id: "l1", label: "LDL", date: null, redacted: false },
            ],
            conditions: [],
          },
        }),
      ],
    });
    expect(html).toContain("2 linked documents");
    expect(html).toContain("1 linked lab results");
    // The empty family renders no counter rather than a zero.
    expect(html).not.toContain("0 linked conditions");
  });

  it("offers the address book beside the add action", () => {
    const html = render({ upcoming: [], past: [] });
    expect(html).toContain('href="/checkups/practitioners"');
  });
});

/**
 * #1241 — "since the last visit" under the next appointment. The caller used
 * to wrap it in a card, so whenever it had nothing to list (still loading, a
 * quiet window, a failed read) an empty bordered card sat under the visit.
 * It now draws its own card, and only once it has a row.
 *
 * The window is the server's (`preparation` on the booked visit). The section
 * used to start it at the last visit of any kind it found in the past list;
 * the fixtures carry such a visit, newer than the window's start, and the
 * read must not move to it.
 */
describe("<VisitsSection> since the last visit", () => {
  const sameDoctor = {
    id: "derm-before",
    occurredAt: "2026-03-02T09:00:00.000Z",
    kind: "SPECIALIST" as const,
    practitionerName: "Skin practice",
    specialty: "Dermatology",
  };
  const next = visit({
    id: "next",
    status: "PLANNED",
    occurredAt: "2026-09-20T09:00:00.000Z",
    preparation: {
      from: "2026-03-02",
      to: "2026-12-01",
      basis: "practitioner",
      since: sameDoctor,
      capped: false,
    },
  });
  const unprepared = visit({ ...next, preparation: null });
  // A newer visit elsewhere: what the old client rule anchored on.
  const last = visit({ id: "last", occurredAt: "2026-08-01T09:00:00.000Z" });

  /** Cards painted inside the upcoming list. */
  function upcomingCards(html: string): number {
    const start = html.indexOf('data-slot="visits-upcoming"');
    const end = html.indexOf('data-slot="visits-past"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, end).split('data-slot="card"').length - 1;
  }

  function seedWindow(window: DayNotableWindowResponse | null) {
    return (queryClient: QueryClient) => {
      if (!window) return;
      queryClient.setQueryData(
        queryKeys.dayNotable("2026-03-02", todayKeyInZone(DEFAULT_TIMEZONE)),
        window,
      );
    };
  }

  const emptyWindow = {
    observations: [],
    changes: [],
  } as unknown as DayNotableWindowResponse;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws no card while the window is still loading", () => {
    const loading = render({ upcoming: [next], past: [last] });
    const without = render({ upcoming: [unprepared], past: [last] });
    expect(loading).not.toContain('data-slot="since-last-visit"');
    expect(upcomingCards(loading)).toBe(upcomingCards(without));
  });

  it("draws no card when the window holds nothing worth listing", () => {
    const html = render(
      { upcoming: [next], past: [last] },
      seedWindow(emptyWindow),
    );
    const baseline = render({ upcoming: [unprepared], past: [last] });
    expect(html).not.toContain('data-slot="since-last-visit"');
    expect(upcomingCards(html)).toBe(upcomingCards(baseline));
  });

  function seedFailure(error: Error) {
    return (queryClient: QueryClient) => {
      const queryKey = queryKeys.dayNotable(
        "2026-03-02",
        todayKeyInZone(DEFAULT_TIMEZONE),
      );
      // The state the section sees once the real read has given up: a mount
      // does not retry it.
      queryClient.setQueryDefaults(queryKey, { retryOnMount: false });
      queryClient
        .getQueryCache()
        .build(queryClient, { queryKey })
        .setState({ status: "error", error, fetchStatus: "idle" });
    };
  }

  it("says a failed read failed, rather than passing it off as a quiet window", () => {
    const html = render(
      { upcoming: [next], past: [last] },
      seedFailure(new ApiError("window read failed", 500)),
    );
    const baseline = render({ upcoming: [unprepared], past: [last] });
    expect(html).toContain('data-slot="since-last-visit-error"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-slot="since-last-visit"');
    // The failed window keeps its own card and title, so the page does not
    // jump; the visit cards beside it stay as they were.
    expect(upcomingCards(html)).toBe(upcomingCards(baseline) + 1);
    expect(html).toContain("Since your last visit with Skin practice on");
  });

  // Visits need the profile section, the window reads measurements, and a
  // share can carry the first without the second. A refusal is not a failure.
  it("draws nothing when the window read is refused", () => {
    const html = render(
      { upcoming: [next], past: [last] },
      seedFailure(new ApiError("Forbidden", 403)),
    );
    expect(html).not.toContain("since-last-visit-error");
    expect(html).not.toContain('role="alert"');
  });

  it("draws one card with the rows once there is something to list", () => {
    const html = render(
      { upcoming: [next], past: [last] },
      seedWindow({
        ...emptyWindow,
        changes: [
          {
            date: "2026-08-03",
            kind: "doseChange",
            section: "medications",
            id: "d1",
            title: "Example 5 mg",
            count: 1,
            href: null,
          },
        ],
      } as unknown as DayNotableWindowResponse),
    );
    const baseline = render({ upcoming: [unprepared], past: [last] });
    expect(html).toContain('data-slot="since-last-visit"');
    expect(html).toContain('data-slot="since-last-visit-row"');
    expect(upcomingCards(html)).toBe(upcomingCards(baseline) + 1);
    // The title says where the window starts and why; the report starts
    // there too, not at the newer visit elsewhere.
    expect(html).toContain("Since your last visit with Skin practice on");
    expect(html).toContain("reportFrom=2026-03-02&amp;");
    expect(html).not.toContain('data-slot="since-last-visit-reason"');
    // The card heads like every compact card: TileHeader at the small size,
    // a real heading under the section's own, at the compact density.
    const card = html.slice(
      html.lastIndexOf(
        '<div data-slot="card"',
        html.indexOf("since-last-visit-"),
      ),
    );
    expect(card).toMatch(/^<div data-slot="card" data-density="compact"/);
    expect(card).toContain('data-slot="tile-header"');
    expect(card).toMatch(
      /<h3 id="since-last-visit-[^"]+" data-slot="card-title" class="[^"]*text-sm/,
    );
  });

  it("says why on the default window, where the title alone cannot", () => {
    const html = render(
      {
        upcoming: [
          visit({
            ...next,
            preparation: {
              from: "2026-03-02",
              to: "2026-12-01",
              basis: "default",
              since: null,
              capped: false,
            },
          }),
        ],
        past: [last],
      },
      seedWindow({
        ...emptyWindow,
        changes: [
          {
            date: "2026-08-03",
            kind: "doseChange",
            section: "medications",
            id: "d1",
            title: "Example 5 mg",
            count: 1,
            href: null,
          },
        ],
      } as unknown as DayNotableWindowResponse),
    );
    expect(html).toContain("The last 90 days");
    expect(html).toContain('data-slot="since-last-visit-reason"');
    expect(html).toContain(
      "No earlier visit with the same practice, specialty or kind.",
    );
  });
});
