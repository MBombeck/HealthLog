import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

const captured = vi.hoisted(() => ({
  onSaved: undefined as (() => void) | undefined,
}));

vi.mock("@/components/links/related-records", () => ({
  RelatedRecordsList: (props: { edit?: { onSaved: () => void } }) => {
    captured.onSaved = props.edit?.onSaved;
    return null;
  },
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ inSharedRecord: false }),
}));

import { MedicationRelatedSection } from "@/components/medications/detail/medication-related-section";

/**
 * A link filed from the medication is listed on the other end too, so a save
 * must stale every detail that reads it back: the medication itself, the
 * episode, the document and the visit.
 */
describe("MedicationRelatedSection", () => {
  it("invalidates every end a saved link is read back on", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <I18nProvider initialLocale="en">
          <MedicationRelatedSection
            medicationId="med-1"
            startsOn={null}
            related={[]}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(captured.onSaved).toBeTypeOf("function");
    captured.onSaved?.();
    const keys = spy.mock.calls.map((call) => call[0]?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        queryKeys.medicationDetail("med-1"),
        queryKeys.illness(),
        queryKeys.documents(),
        queryKeys.encounters(),
      ]),
    );
  });
});
