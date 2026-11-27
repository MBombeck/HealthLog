import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The condition page's one "Links" tile, pinned via static renders: its
 * documents, visits and related records as chips that open them, no line
 * at all for an absence, and no tile when there is nothing to show and
 * nothing the viewer may add.
 */

let moduleEnabled = true;
let canManage = true;
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: { inboundDocuments: moduleEnabled } },
    isLoading: false,
    isAuthenticated: true,
  }),
}));
vi.mock("@/hooks/use-record-capabilities", async (importOriginal) => ({
  holdsOwnerRights: (
    await importOriginal<typeof import("@/hooks/use-record-capabilities")>()
  ).holdsOwnerRights,
  useRecordCapabilities: () => ({
    inSharedRecord: !canManage,
    canManageDomain: () => canManage,
    canWriteDomain: () => canManage,
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/illness/ep1",
  useSearchParams: () => new URLSearchParams(),
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
import type { RelatedLink } from "@/lib/links/related";
import { EpisodeLinksCard } from "../episode-links-card";

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
    sourceUrl: null,
    createdAt: "2025-10-05T08:00:00.000Z",
    updatedAt: "2025-10-05T08:00:00.000Z",
  };
}

function render(seed?: InboundDocumentDto[], related: RelatedLink[] = []) {
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
        <EpisodeLinksCard episodeId="ep1" related={related} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<EpisodeLinksCard>", () => {
  it("renders nothing with no links and nothing the viewer may add", () => {
    moduleEnabled = false;
    canManage = false;
    expect(render([])).toBe("");
    moduleEnabled = true;
    canManage = true;
  });

  it("writes no line for an absence, only the way to add", () => {
    const html = render([]);
    expect(html).toContain('data-slot="episode-links-card"');
    expect(html).toContain('data-slot="episode-links-add"');
    expect(html).not.toContain("No documents linked");
    expect(html).not.toContain('data-slot="record-link"');
    // Not the vault's teaching empty state either.
    expect(html).not.toContain('data-slot="empty-state"');
  });

  it("shows linked documents as chips deep-linking into the vault", () => {
    const html = render([doc("d1", "MRT Knie"), doc("d2", "Röntgen")]);
    expect(html).toContain("MRT Knie");
    expect(html).toContain("Röntgen");
    expect(html).toContain("/documents?episode=ep1&amp;doc=d1");
    expect(html).toContain('data-kind="document"');
  });

  it("puts the related records in the same row", () => {
    const html = render(
      [doc("d1", "MRT Knie")],
      [
        {
          kind: "medication",
          id: "m1",
          label: "Ibuprofen 400 mg",
          date: null,
          href: "/medications/m1",
          via: "direct",
        },
        // A document the tile already lists from its own read is not shown
        // twice.
        {
          kind: "document",
          id: "d1",
          label: "MRT Knie",
          date: null,
          href: "/documents?doc=d1",
          via: "direct",
        },
      ],
    );
    expect(html).toContain('href="/medications/m1"');
    expect(html.match(/MRT Knie/g)?.length).toBe(1);
  });

  it("offers no way to add inside a record the viewer may only read", () => {
    canManage = false;
    const html = render([doc("d1", "MRT Knie")]);
    canManage = true;
    expect(html).toContain("MRT Knie");
    expect(html).not.toContain('data-slot="episode-links-add"');
  });
});
