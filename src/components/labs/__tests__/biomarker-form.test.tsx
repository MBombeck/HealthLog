import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { ApiError } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { queryKeys } from "@/lib/query-keys";
import en from "../../../../messages/en.json";

/**
 * The marker editor says, before a save, that a marker's unit stays as it is
 * once readings exist, and the refusal the server sends for such a change
 * reads as that sentence rather than the generic save error.
 */

vi.mock("@/lib/api/api-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/api-fetch")>()),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

import { BiomarkerForm } from "../biomarker-form";
import type { BiomarkerDto } from "../types";

const MARKER: BiomarkerDto = {
  id: "bm-1",
  name: "Glucose",
  unit: "mg/dL",
  lowerBound: 70,
  upperBound: 99,
  panel: null,
  analyteKey: null,
  hasContext: false,
  context: null,
  hidden: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function render(node: React.ReactNode, customPanels: string[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.biomarkers(), {
    biomarkers: [],
    customPanels,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<BiomarkerForm> unit lock", () => {
  const hint = en.labs.biomarker.form.unitLockedHint;

  it("tells the editor of an existing marker that the unit is locked by readings", () => {
    const html = render(<BiomarkerForm existing={MARKER} />);
    expect(hint.length).toBeGreaterThan(0);
    expect(html).toContain(hint.replace(/'/g, "&#x27;"));
    expect(html).toMatch(/aria-describedby="[^"]*-unit-hint"/);
  });

  it("says nothing of a lock while a new marker is defined", () => {
    const html = render(<BiomarkerForm />);
    expect(html).not.toContain(hint.replace(/'/g, "&#x27;"));
  });

  it("reads the server's refusal as its own sentence, not the save error", () => {
    const err = new ApiError("locked", 422, {
      errorCode: "biomarkers.unit.locked",
      readingCount: 2,
    });
    const t = (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === "object"
              ? (node as Record<string, unknown>)[part]
              : undefined,
          en,
        );
      return typeof value === "string" ? value : key;
    };
    expect(localizedApiError(err, t, "labs.biomarker.form.saveError")).toBe(
      en.apiErrors.biomarkers.unit.locked,
    );
  });
});

describe("<BiomarkerForm> panel suggestions", () => {
  it("suggests every catalog panel and the person's own panels", () => {
    const html = render(<BiomarkerForm />, ["Annual check"]);
    const list = html.match(
      /<datalist[^>]*data-slot="biomarker-panel-suggestions"[^>]*>(.*?)<\/datalist>/,
    );
    expect(list).not.toBeNull();
    const values = [...list![1].matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toContain("Lipids");
    expect(values).toContain("Blood count");
    expect(values).toContain("Annual check");
    expect(values).toHaveLength(11);
    const id = /<datalist[^>]*id="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`list="${id}"`);
  });
});
