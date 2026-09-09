import { describe, expect, it, vi } from "vitest";
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

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { EncounterDTO } from "@/lib/encounters/dto";
import { VisitsSection } from "../visits-section";

function visit(over: Partial<EncounterDTO> & { id: string }): EncounterDTO {
  return {
    occurredAt: "2026-08-01T09:00:00.000Z",
    status: "DONE",
    kind: "ROUTINE",
    practitioner: null,
    reason: null,
    outcome: null,
    reminderNextDueAt: null,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

function render(list: { upcoming: EncounterDTO[]; past: EncounterDTO[] }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
