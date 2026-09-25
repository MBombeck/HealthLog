import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The body-site field pair suggests the sites the record already holds, across
 * procedures and conditions, as the server resolved them.
 *
 *   - the suggestions are the server's list, in its order;
 *   - the site already typed is not suggested back to itself;
 *   - no list (a refused or failed read) is a plain field, not an empty list.
 *
 * Mutation check (run, seen red): drop the `list` attribute from the input →
 * "offers the sites the record holds" goes red.
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
import { BodySiteFields } from "../body-site-fields";

function render(data: BodySiteListDTO | null, typed = ""): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  if (data) queryClient.setQueryData(queryKeys.bodySites(null, null), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <BodySiteFields
          idPrefix="illness"
          bodySite={typed}
          laterality={null}
          onBodySiteChange={() => {}}
          onLateralityChange={() => {}}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const site = (bodySite: string) => ({
  bodySite,
  procedures: 1,
  conditions: 0,
  sides: [{ laterality: null, count: 1 }],
});

describe("<BodySiteFields>", () => {
  it("offers the sites the record holds, in the server's order", () => {
    const html = render({ sites: [site("Knee"), site("Lower back")] });
    const listId = html.match(/<datalist id="([^"]+)"/)?.[1];
    expect(listId).toBeTruthy();
    expect(html).toContain(`list="${listId}"`);
    expect(html.indexOf('value="Knee"')).toBeLessThan(
      html.indexOf('value="Lower back"'),
    );
    expect(html).toContain('id="illness-body-site"');
    expect(html).toContain('id="illness-laterality"');
  });

  it("does not suggest the site already typed", () => {
    const html = render({ sites: [site("Knee"), site("Hip")] }, "knee");
    expect(html).not.toContain('<option value="Knee"');
    expect(html).toContain('<option value="Hip"');
  });

  it("without a list it is a plain field", () => {
    const html = render(null);
    expect(html).not.toContain("<datalist");
    expect(html).not.toContain(" list=");
  });
});
