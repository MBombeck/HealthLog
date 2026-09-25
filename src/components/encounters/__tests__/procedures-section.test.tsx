import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The procedure history's designed states, pinned by single-pass static
 * renders (the repository's component-test convention; typing into the filter
 * is driven in the browser check, not here).
 *
 *   - an account with no procedure gets an empty state that says how to make
 *     one — including switching a visit already on file — and one action;
 *   - a history lists what the server sent, in the server's order, each row
 *     naming its body site with the side;
 *   - the body sites are offered as filter choices, with "All" pressed while
 *     nothing is filtered;
 *   - a failed read is an error with a retry, never the empty state.
 *
 * Mutation checks (each run, each seen red):
 *   - render `procedures.length === 0` as the account-empty state instead of
 *     keying it on `total` → "keeps the filter when nothing matches" goes red;
 *   - drop the side from `bodySiteText` → "names the site with its side" goes
 *     red.
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
    apiGet: () => new Promise(() => {}),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { EncounterDTO, ProcedureListDTO } from "@/lib/encounters/dto";
import { ProceduresSection } from "../procedures-section";

function procedure(over: Partial<EncounterDTO> & { id: string }): EncounterDTO {
  return {
    occurredAt: "2011-03-14T09:00:00.000Z",
    status: "DONE",
    kind: "PROCEDURE",
    practitioner: null,
    reason: null,
    outcome: null,
    bodySite: null,
    laterality: null,
    reminderNextDueAt: null,
    createdAt: "2011-03-14T09:00:00.000Z",
    updatedAt: "2011-03-14T09:00:00.000Z",
    ...over,
  };
}

function render(data: ProcedureListDTO | "error") {
  const queryClient = new QueryClient({
    // `retryOnMount: false` so a seeded error stays an error through the
    // render instead of being reported as a fresh fetch.
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  const key = queryKeys.encounterProcedures("", null);
  if (data === "error") {
    queryClient
      .getQueryCache()
      .build(queryClient, { queryKey: key })
      .setState({
        status: "error",
        error: new Error("boom"),
        fetchStatus: "idle",
      });
  } else {
    queryClient.setQueryData(key, data);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <ProceduresSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<ProceduresSection>", () => {
  it("explains how to get a first procedure, including switching a visit", () => {
    const html = render({ procedures: [], bodySites: [], total: 0 });
    expect(html).toContain("No procedure recorded yet");
    expect(html).toContain("switch an existing visit to it");
    expect(html).toContain('data-slot="procedures-add"');
    expect(html).not.toContain('data-slot="procedures-filter"');
    expect(html).not.toContain("Procedures could not be loaded.");
  });

  it("lists the history in the server's order and names the site with its side", () => {
    const html = render({
      procedures: [
        procedure({
          id: "newer",
          occurredAt: "2019-07-02T09:00:00.000Z",
          reason: "Cholecystectomy",
          bodySite: "Gallbladder",
        }),
        procedure({
          id: "older",
          reason: "Meniscus repair",
          bodySite: "Knee",
          laterality: "LEFT",
        }),
      ],
      bodySites: [
        { bodySite: "Gallbladder", laterality: null, count: 1 },
        { bodySite: "Knee", laterality: "LEFT", count: 1 },
      ],
      total: 2,
    });
    expect(html.indexOf('data-encounter-id="newer"')).toBeLessThan(
      html.indexOf('data-encounter-id="older"'),
    );
    expect(html).toContain("Meniscus repair");
    expect(html).toContain("Knee · Left");
    expect(html).toContain("2 of 2");
  });

  it("heads a procedure with what was done, and keeps the practice on its own line", () => {
    const html = render({
      procedures: [
        procedure({
          id: "p1",
          reason: "Meniscus repair",
          practitioner: {
            id: "pr1",
            name: "Sample clinic",
            specialty: null,
            practice: null,
            location: null,
            phone: null,
            note: null,
            createdAt: "2011-01-01T00:00:00.000Z",
            updatedAt: "2011-01-01T00:00:00.000Z",
          },
        }),
      ],
      bodySites: [],
      total: 1,
    });
    expect(html).toMatch(/font-medium">Meniscus repair</);
    expect(html).toContain("Sample clinic");
    expect(html.match(/Meniscus repair/g)).toHaveLength(1);
  });

  it("offers every body site as a filter, with All pressed while nothing is filtered", () => {
    const html = render({
      procedures: [
        procedure({ id: "p1", bodySite: "Knee", laterality: "LEFT" }),
      ],
      bodySites: [{ bodySite: "Knee", laterality: "LEFT", count: 1 }],
      total: 1,
    });
    expect(html).toContain('data-slot="procedures-filter"');
    expect(html).toMatch(
      /data-slot="procedures-site-all"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-slot="procedures-site-all"/,
    );
    expect(html).toMatch(
      /aria-pressed="false"[^>]*>Knee · Left|data-slot="procedures-site"[^>]*aria-pressed="false"/,
    );
  });

  it("keeps the filter when nothing matches, and offers to clear it", () => {
    const html = render({
      procedures: [],
      bodySites: [{ bodySite: "Knee", laterality: null, count: 1 }],
      total: 1,
    });
    expect(html).toContain("Nothing matches this filter");
    expect(html).toContain('data-slot="procedures-filter"');
    expect(html).not.toContain("No procedure recorded yet");
  });

  it("paints an error with a retry, never the empty state", () => {
    const html = render("error");
    expect(html).toContain("Procedures could not be loaded.");
    expect(html).not.toContain("No procedure recorded yet");
  });
});
