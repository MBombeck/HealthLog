import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The illness page's "Dokumente" section, pinned via static renders:
 * module-gated (renders NOTHING when the account has not opted in), a
 * quiet one-line affordance on an episode without documents (never a
 * teaching empty state), and compact deep-linking rows when links exist.
 */

let moduleEnabled = true;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: { inboundDocuments: moduleEnabled } },
    isLoading: false,
    isAuthenticated: true,
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
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import { EpisodeDocumentsCard } from "../episode-documents-card";

function doc(id: string, title: string): InboundDocumentDto {
  return {
    id,
    kind: "IMAGING",
    title,
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    byteSize: 2048,
    status: "STORED",
    providerType: null,
    reportDate: null,
    documentDate: "2025-10-04",
    errorReason: null,
    factCount: 0,
    pendingCount: 0,
    conditionLinks: [{ episodeId: "ep1", name: "Knee" }],
    encounterLinks: [],
    servingClass: "inline",
    hasContentIndex: false,
    contentIndexSource: null,
    lastIndexAttemptAt: null,
    lastIndexOutcome: null,
    hasThumbnail: false,
    sourceSystem: null,
    sourceId: null,
    createdAt: "2025-10-05T08:00:00.000Z",
    updatedAt: "2025-10-05T08:00:00.000Z",
  };
}

function render(seed?: InboundDocumentDto[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed !== undefined) {
    queryClient.setQueryData(queryKeys.inboundDocumentEpisodePreview("ep1"), {
      documents: seed,
      nextCursor: null,
    });
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <EpisodeDocumentsCard episodeId="ep1" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<EpisodeDocumentsCard>", () => {
  it("renders nothing when the documents module is off", () => {
    moduleEnabled = false;
    expect(render([])).toBe("");
    moduleEnabled = true;
  });

  it("shows a quiet one-line affordance on an episode without documents", () => {
    const html = render([]);
    expect(html).toContain('data-slot="episode-documents-card"');
    expect(html).toContain("No documents linked to this condition yet.");
    expect(html).toContain("Link");
    expect(html).toContain("Upload");
    // Not the vault's teaching empty state.
    expect(html).not.toContain('data-slot="empty-state"');
  });

  it("lists linked documents as rows deep-linking into the vault", () => {
    const html = render([doc("d1", "MRT Knie"), doc("d2", "Röntgen")]);
    expect(html).toContain("MRT Knie");
    expect(html).toContain("Röntgen");
    expect(html).toContain("/documents?episode=ep1&amp;doc=d1");
    // The pre-linked upload deep link carries the episode filter.
    expect(html).toContain('href="/documents?episode=ep1"');
  });
});
