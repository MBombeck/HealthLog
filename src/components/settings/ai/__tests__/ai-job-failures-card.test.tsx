import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * #1404 — Settings, AI says which background work stopped and why, links a
 * document's entry to its document, says a failed read as one, and shows no
 * card when nothing stopped.
 */
const state = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: false,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: state.data,
    isError: state.isError,
    error: state.isError ? new Error("boom") : null,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";

import { AiJobFailuresCard } from "../ai-job-failures-card";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AiJobFailuresCard isAuthenticated />
    </I18nProvider>,
  );
}

describe("AiJobFailuresCard", () => {
  it("renders no card when nothing stopped", () => {
    state.isError = false;
    state.data = { failures: [] };
    expect(render()).toBe("");
  });

  it("lists each stopped job with its reason, and links a document", () => {
    state.isError = false;
    state.data = {
      failures: [
        {
          job: "statusText",
          code: "provider_timeout",
          documentId: null,
          providerType: "local",
          failCount: 1,
          firstFailedAt: "2026-11-21T08:00:00.000Z",
          lastFailedAt: "2026-11-21T08:00:00.000Z",
        },
        {
          job: "documentSummary",
          code: "credential_expired",
          documentId: "doc-7",
          providerType: "anthropic",
          failCount: 2,
          firstFailedAt: "2026-11-20T08:00:00.000Z",
          lastFailedAt: "2026-11-21T09:00:00.000Z",
        },
      ],
    };
    const html = render();
    expect(html).toContain("Background AI that stopped");
    expect(html).toContain(
      "Notes on the cards: The AI provider did not answer in time.",
    );
    expect(html).toContain(
      "Document summary: The AI provider refused the key.",
    );
    expect(html).toContain('href="/documents?doc=doc-7"');
    expect(html.match(/Open the document/g)).toHaveLength(1);
  });

  it("says a failed read as one", () => {
    state.isError = true;
    state.data = undefined;
    const html = render();
    expect(html).toContain('data-slot="ai-job-failures-error"');
  });
});
