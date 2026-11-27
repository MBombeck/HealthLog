import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { RelatedLink } from "@/lib/links/related";
import { queryKeys } from "@/lib/query-keys";

const captured = vi.hoisted(() => ({
  pickers: null as null | {
    linksPath: string;
    kinds: readonly string[];
    onSaved: () => void;
  },
}));

vi.mock("@/components/links/related-records", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/links/related-records")
  >("@/components/links/related-records");
  return {
    ...actual,
    RelatedRecordsBlock: (
      props: Parameters<typeof actual.RelatedRecordsBlock>[0],
    ) => {
      captured.pickers = props.edit ?? null;
      return <actual.RelatedRecordsBlock {...props} />;
    },
  };
});

import { LabResultRelatedLinks } from "../lab-result-related-links";

const REPORT: RelatedLink = {
  kind: "document",
  id: "doc-1",
  label: "Lab report March",
  date: "2026-03-01T00:00:00.000Z",
  href: "/documents?doc=doc-1",
  via: "direct",
};

function render(qc: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en">
        <LabResultRelatedLinks labResultId="lab-1" takenAt={null} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * A lab reading shows what it relates to where it is shown in detail (its
 * edit sheet), and files the report and the visit through its own links
 * route; a save refreshes every end that lists the reading back.
 */
describe("LabResultRelatedLinks", () => {
  it("renders nothing before the detail read lands", () => {
    expect(render(new QueryClient())).toBe("");
  });

  it("lists the related records and offers the report and visit pickers", () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.labResult("lab-1"), { related: [REPORT] });
    const html = render(qc);
    expect(html).toContain('data-slot="lab-result-related"');
    expect(html).toContain("Lab report March");
    expect(captured.pickers?.linksPath).toBe("/api/labs/lab-1/links");
    expect(captured.pickers?.kinds).toEqual(["document", "encounter"]);
  });

  it("refreshes the reading and every end that lists it after a save", () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.labResult("lab-1"), { related: [] });
    const spy = vi.spyOn(qc, "invalidateQueries");
    render(qc);
    captured.pickers?.onSaved();
    const keys = spy.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        queryKeys.labResult("lab-1"),
        queryKeys.documents(),
        queryKeys.encounters(),
        queryKeys.illness(),
      ]),
    );
  });
});
