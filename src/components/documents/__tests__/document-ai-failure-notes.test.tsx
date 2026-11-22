import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AiJobFailureDto } from "@/lib/ai/job-failure/types";

import { DocumentAiFailureNotes } from "../document-ai-failure-notes";

/**
 * #1404 — a document whose AI read stopped says why on the document, with a
 * way to start it again, even while the AI actions are hidden.
 */
function render(
  props: Partial<React.ComponentProps<typeof DocumentAiFailureNotes>>,
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentAiFailureNotes
        failures={[]}
        canRetry
        retryPending={false}
        onRetry={() => {}}
        {...props}
      />
    </I18nProvider>,
  );
}

const failure = (over: Partial<AiJobFailureDto>): AiJobFailureDto => ({
  job: "documentIndex",
  code: "chain_no_provider",
  documentId: "doc-1",
  providerType: null,
  failCount: 1,
  firstFailedAt: "2026-11-21T08:00:00.000Z",
  lastFailedAt: "2026-11-21T08:00:00.000Z",
  ...over,
});

describe("DocumentAiFailureNotes", () => {
  it("renders nothing without a read failure", () => {
    expect(render({})).toBe("");
    expect(render({ failures: [failure({ job: "documentSummary" })] })).toBe(
      "",
    );
  });

  it("names the work and the reason, with a retry for the read", () => {
    const html = render({ failures: [failure({})] });
    expect(html).toContain("Reading a document for search:");
    expect(html).toContain("none of its providers is set up");
    expect(html).toContain('data-slot="document-ai-failures-retry"');
  });

  it("offers no retry where the person may not run AI", () => {
    const html = render({ failures: [failure({})], canRetry: false });
    expect(html).toContain("Reading a document for search:");
    expect(html).not.toContain("document-ai-failures-retry");
  });

  it("reads an unknown code as a provider error", () => {
    const html = render({
      failures: [
        {
          ...failure({}),
          code: "from_the_future",
        } as unknown as AiJobFailureDto,
      ],
    });
    expect(html).toContain("The AI provider returned an error.");
  });
});
