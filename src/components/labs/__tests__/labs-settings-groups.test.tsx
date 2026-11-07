import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  resolveModuleListLayout,
  type ModuleListPrefs,
} from "@/lib/settings/module-list-layout";

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPut: vi.fn(),
}));

import { LabsSettings } from "../labs-settings";

function render(prefs: Partial<ModuleListPrefs>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(
    queryKeys.moduleListLayout(),
    resolveModuleListLayout({ version: 1, labs: prefs }),
  );
  queryClient.setQueryData(queryKeys.biomarkers(), {
    biomarkers: [],
    customPanels: [],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <LabsSettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<LabsSettings> categories", () => {
  it("hides the open-on-load choice while categories are off", () => {
    const html = render({});
    expect(html).toContain('data-slot="labs-group-by-none"');
    expect(html).not.toContain('data-slot="labs-groups-open"');
  });

  it("offers the three open-on-load choices while categories are on", () => {
    const html = render({ groupBy: "category", groupsOpen: "flagged" });
    expect(html).toContain('data-slot="labs-groups-open"');
    for (const value of ["expanded", "flagged", "collapsed"]) {
      expect(html).toContain(`data-slot="labs-groups-open-${value}"`);
    }
  });

  it("says the manual order applies within each category", () => {
    expect(render({ groupBy: "category", sortDir: "manual" })).toContain(
      "The order applies within each category.",
    );
    expect(render({ sortDir: "manual" })).not.toContain(
      "The order applies within each category.",
    );
  });
});
