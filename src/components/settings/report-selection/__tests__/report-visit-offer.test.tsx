import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The report's reason, pinned on the two properties that make it trustworthy:
 *
 *   - it appears for an appointment inside the horizon and for nothing else;
 *   - it NEVER auto-applies. Applying is a press, and the component calls
 *     nothing on render — a window control that moves on its own is what makes
 *     an export panel untrustworthy.
 *
 * The fixtures are relative to the moment the test runs, so the horizon cannot
 * rot out from under them as the calendar moves.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: {} },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return { ...actual, apiGet: () => new Promise(() => {}) };
});

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { EncounterDTO } from "@/lib/encounters/dto";
import { ReportVisitOffer, visitReportWindow } from "../report-visit-offer";

const DAY_MS = 24 * 60 * 60 * 1000;

function visit(over: Partial<EncounterDTO> & { id: string }): EncounterDTO {
  return {
    occurredAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
    status: "PLANNED",
    kind: "SPECIALIST",
    practitioner: null,
    reason: null,
    outcome: null,
    bodySite: null,
    laterality: null,
    reminderNextDueAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function render(upcoming: EncounterDTO[], onUse = () => {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    queryKeys.encounterList(null, null, undefined, undefined),
    {
      upcoming,
      past: [],
    },
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <ReportVisitOffer onUseVisitWindow={onUse} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<ReportVisitOffer>", () => {
  it("offers an appointment five days out, naming its own source", () => {
    const html = render([visit({ id: "soon" })]);
    expect(html).toContain('data-slot="report-visit-offer"');
    expect(html).toContain("An appointment is coming up");
    expect(html).toContain('data-slot="report-visit-offer-apply"');
  });

  it("stays silent for an appointment thirty days out", () => {
    const html = render([
      visit({
        id: "far",
        occurredAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      }),
    ]);
    expect(html).not.toContain('data-slot="report-visit-offer"');
  });

  it("stays silent when there is no appointment at all", () => {
    expect(render([])).not.toContain('data-slot="report-visit-offer"');
  });

  it("ignores a cancelled appointment inside the horizon", () => {
    const html = render([visit({ id: "off", status: "CANCELLED" })]);
    expect(html).not.toContain('data-slot="report-visit-offer"');
  });

  it("changes the window only when pressed", () => {
    const onUse = vi.fn();
    const html = render([visit({ id: "soon" })], onUse);
    // The offer rendered — so the assertion below is about restraint, not
    // about a component that produced nothing.
    expect(html).toContain('data-slot="report-visit-offer-apply"');
    expect(onUse).not.toHaveBeenCalled();
  });

  // The issue behind this: an internist a week ago, a dermatologist next. The
  // start used to be whatever the panel held, typically the last visit of any
  // kind; it is now the server's window before this visit, and says why.
  it("names where the report would start, and why there", () => {
    const html = render([
      visit({
        id: "derm",
        preparation: {
          from: "2026-03-02",
          to: "2026-12-01",
          basis: "specialty",
          since: {
            id: "old-derm",
            occurredAt: "2026-03-02T09:00:00.000Z",
            kind: "SPECIALIST",
            practitionerName: "Former skin practice",
            specialty: "Dermatology",
          },
          capped: false,
        },
      }),
    ]);
    expect(html).toContain('data-slot="report-visit-offer-window"');
    expect(html).toContain("Since your last Dermatology visit on");
    expect(html).toContain("Use this window");
  });

  it("says why on the default window", () => {
    const html = render([
      visit({
        id: "first",
        preparation: {
          from: "2026-07-23",
          to: "2026-12-01",
          basis: "default",
          since: null,
          capped: false,
        },
      }),
    ]);
    expect(html).toContain("The last 90 days");
    expect(html).toContain(
      "No earlier visit with the same practice, specialty or kind.",
    );
  });

  it("says the last two years on a window capped at the longest report", () => {
    const html = render([
      visit({
        id: "derm",
        preparation: {
          from: "2024-12-02",
          to: "2026-12-01",
          basis: "practitioner",
          since: {
            id: "old-derm",
            occurredAt: "2022-03-02T09:00:00.000Z",
            kind: "SPECIALIST",
            practitionerName: "Skin practice",
            specialty: "Dermatology",
          },
          capped: true,
        },
      }),
    ]);
    expect(html).toContain("The last two years");
    expect(html).toContain("a report covers two years at most");
    // Not "since your last visit", which would promise the whole stretch.
    expect(html).not.toContain("Since your last visit");
  });

  it("applies the server's start and the appointment's day on a press", () => {
    const at = new Date(Date.now() + 5 * DAY_MS);
    const window = visitReportWindow(
      visit({
        id: "derm",
        occurredAt: at.toISOString(),
        preparation: {
          from: "2026-03-02",
          to: "2026-12-01",
          basis: "default",
          since: null,
          capped: false,
        },
      }),
      "Europe/Berlin",
    );
    expect(window.from).toBe("2026-03-02");
    expect(window.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Without a window from the server, only the end moves.
    expect(
      visitReportWindow(visit({ id: "plain" }), "Europe/Berlin").from,
    ).toBeNull();
  });

  it("ends on the record's day the server cut, not the reader's", () => {
    // 04:30 on the 12th in Berlin is still the evening of the 11th in New
    // York. A guardian in New York viewing a Berlin record gets the record's
    // day: both ends come from the server, on the record's calendar.
    const early = visit({
      id: "early",
      occurredAt: "2026-11-12T03:30:00.000Z",
      preparation: {
        from: "2026-08-12",
        to: "2026-11-12",
        basis: "default",
        since: null,
        capped: false,
      },
    });
    expect(visitReportWindow(early, "America/New_York")).toEqual({
      from: "2026-08-12",
      to: "2026-11-12",
    });
    // Without a preparation the zone handed in decides.
    const plain = visit({
      id: "plain",
      occurredAt: "2026-11-12T03:30:00.000Z",
    });
    expect(visitReportWindow(plain, "America/New_York").to).toBe("2026-11-11");
  });
});
