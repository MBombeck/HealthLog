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
import { ReportVisitOffer } from "../report-visit-offer";

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
        <ReportVisitOffer onUseVisitDate={onUse} />
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
});
