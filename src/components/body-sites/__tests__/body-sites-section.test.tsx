import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The body-site view's designed states, pinned by single-pass static renders
 * (the repository's component-test convention; tapping a site is driven in the
 * browser check, not here).
 *
 *   - no site anywhere: an empty state that says how a site gets here;
 *   - a site picked: its procedures and conditions, each with what is linked;
 *   - a delegate's answer: a link the grant does not cover renders as a
 *     placeholder naming only its kind, never a label, never a link; and a
 *     condition list the server did not read (`null`) renders no conditions
 *     heading at all rather than an empty one;
 *   - a failed read is an error with a retry, never the empty state.
 *
 * Mutation checks (each run, each seen red):
 *   - render `item.label` for a redacted entry instead of the placeholder →
 *     "a link the grant does not cover" goes red;
 *   - render the conditions block whenever the selection carries the key
 *     (`conditions !== undefined`) → "no conditions heading" goes red.
 */

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return { ...actual, apiGet: () => new Promise(() => {}) };
});

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { BodySiteListDTO } from "@/lib/body-sites/dto";
import type { EncounterDTO } from "@/lib/encounters/dto";
import { BodySitesSection } from "../body-sites-section";

function visit(over: Partial<EncounterDTO> & { id: string }): EncounterDTO {
  return {
    occurredAt: "2026-08-26T09:00:00.000Z",
    status: "DONE",
    kind: "PROCEDURE",
    practitioner: null,
    reason: "Arthroscopy",
    outcome: null,
    bodySite: "Knee",
    laterality: "LEFT",
    reminderNextDueAt: null,
    createdAt: "2026-08-26T09:00:00.000Z",
    updatedAt: "2026-08-26T09:00:00.000Z",
    ...over,
  };
}

const KNEE = {
  bodySite: "Knee",
  procedures: 1,
  conditions: 1,
  sides: [{ laterality: "LEFT" as const, count: 2 }],
};

function render(
  data: BodySiteListDTO | "error",
  site: string | null = "Knee",
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  const key = queryKeys.bodySites(site, null);
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
        <BodySitesSection initialSite={site} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<BodySitesSection>", () => {
  it("explains how a site gets here when there is none", () => {
    const html = render({ sites: [] }, null);
    expect(html).toContain("No body site recorded yet");
    expect(html).toContain("to a procedure or a condition");
    expect(html).not.toContain('data-slot="body-sites-filter"');
    expect(html).not.toContain("Body sites could not be loaded.");
  });

  it("offers the sites and asks for a pick before showing anything", () => {
    const html = render({ sites: [KNEE] }, null);
    expect(html).toContain('data-slot="body-site-chip"');
    expect(html).toContain("Pick a site to see what is filed there.");
    expect(html).not.toContain('data-slot="body-site-selection"');
  });

  it("lists the procedures and conditions at the picked site with their links", () => {
    const html = render({
      sites: [KNEE],
      selection: {
        bodySite: "Knee",
        laterality: null,
        visits: [
          visit({
            id: "v1",
            links: {
              documents: [
                {
                  id: "d1",
                  label: "MRI knee report",
                  date: "2026-08-20T00:00:00.000Z",
                  redacted: false,
                },
              ],
              labResults: [],
              conditions: [],
            },
          }),
        ],
        conditions: [
          {
            id: "c1",
            label: "Meniscus tear",
            type: "INJURY",
            lifecycle: "ACUTE",
            onsetAt: "2026-07-01T00:00:00.000Z",
            resolvedAt: null,
            bodySite: "knee",
            laterality: "LEFT",
            links: {
              documents: [],
              visits: [
                {
                  id: "v1",
                  label: "PROCEDURE",
                  date: "2026-08-26T09:00:00.000Z",
                  redacted: false,
                },
              ],
            },
          },
        ],
      },
    });
    expect(html).toContain("Procedures and visits");
    expect(html).toContain("Arthroscopy");
    expect(html).toContain("Knee · Left");
    expect(html).toContain('href="/documents?doc=d1"');
    expect(html).toContain("MRI knee report");
    expect(html).toContain("Conditions");
    expect(html).toContain('href="/illness/c1"');
    expect(html).toContain("Meniscus tear");
    // A visit's link label is its kind constant, named by the reader.
    expect(html).toContain("Procedure or surgery");
    expect(html).not.toContain(">PROCEDURE<");
  });

  it("a link the grant does not cover is a placeholder, and no conditions heading without conditions", () => {
    const hidden = { label: null, date: null, redacted: true };
    const html = render({
      sites: [{ ...KNEE, conditions: 0 }],
      selection: {
        bodySite: "Knee",
        laterality: null,
        visits: [
          visit({
            id: "v1",
            links: {
              documents: [{ id: "d1", ...hidden }],
              labResults: [{ id: "l1", ...hidden }],
              conditions: [{ id: "c1", ...hidden }],
            },
          }),
        ],
        conditions: null,
      },
    });
    expect(html).toContain("A document not shared with you");
    expect(html).toContain("A lab result not shared with you");
    expect(html).toContain("A condition not shared with you");
    expect(html.match(/data-slot="body-site-link-hidden"/g)).toHaveLength(3);
    // A withheld entry is never a way in.
    expect(html).not.toContain('href="/documents?doc=d1"');
    expect(html).not.toContain('href="/illness/c1"');
    expect(html).not.toContain('data-slot="body-site-conditions"');
    expect(html).not.toContain(">Conditions<");
  });

  it("a failed read is an error with a retry, never the empty state", () => {
    const html = render("error");
    expect(html).toContain("Body sites could not be loaded.");
    expect(html).not.toContain("No body site recorded yet");
  });
});
