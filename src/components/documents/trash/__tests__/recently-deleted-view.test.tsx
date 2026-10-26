import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Recently deleted and the vault's way into it, pinned via single-pass static
 * renders (the project's component-test convention):
 *
 *   - the page paints a skeleton while the list is out, never the empty copy;
 *   - each row says what the document was, where it came from, when it was
 *     deleted and how long it has left, and offers Restore and Delete now;
 *   - Restore all appears only with more than one document;
 *   - an empty list says so and leads back to the vault;
 *   - the vault header links to Recently deleted with the count, and only
 *     while something is in it.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/documents/deleted",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: { inboundDocuments: true } },
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
    // Never resolves within the synchronous render: an unseeded query stays
    // pending.
    apiGet: () => new Promise(() => {}),
    apiGetList: () => new Promise(() => {}),
    apiPost: vi.fn(),
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { DeletedDocumentDto } from "@/lib/validations/inbound-documents";

import { VaultPageActions } from "../../vault/vault-page-actions";
import { RecentlyDeletedView } from "../recently-deleted-view";

const DAY = 86_400_000;

function doc(over: Partial<DeletedDocumentDto> = {}): DeletedDocumentDto {
  const deletedAt = new Date(Date.now() - 3 * DAY);
  return {
    id: "doc-1",
    kind: "LAB_RESULT",
    title: "Blood panel",
    filename: "blood.pdf",
    mimeType: "application/pdf",
    byteSize: 1234,
    documentDate: "2024-03-04",
    sourceSystem: "PAPERLESS",
    deletedAt: deletedAt.toISOString(),
    purgeAt: new Date(deletedAt.getTime() + 30 * DAY).toISOString(),
    ...over,
  };
}

function render(node: React.ReactNode, seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

function seedList(documents: DeletedDocumentDto[], truncated = false) {
  return (qc: QueryClient) =>
    qc.setQueryData(queryKeys.inboundDocumentsDeleted(), {
      data: { documents, graceDays: 30 },
      cap: { truncated, limit: 200 },
    });
}

describe("<RecentlyDeletedView>", () => {
  it("first load: header and a skeleton, never the empty copy", () => {
    const html = render(<RecentlyDeletedView />);
    expect(html).toContain("Recently deleted");
    expect(html).toContain(
      "Deleted documents stay here for 30 days, then they are removed for good.",
    );
    expect(html).toContain('data-slot="documents-trash-loading"');
    expect(html).toContain('href="/documents"');
    expect(html).not.toContain("Nothing in Recently deleted");
  });

  it("a row: what it was, where it came from, how long it has left, both ways out", () => {
    const html = render(<RecentlyDeletedView />, seedList([doc()]));
    expect(html).toContain('data-slot="documents-trash-card"');
    expect(html).toContain("Deleted documents (1)");
    expect(html).toContain("Blood panel");
    expect(html).toContain("Lab result");
    expect(html).toContain("Imported from Paperless-ngx");
    expect(html).toContain("Removed for good in 27 days.");
    expect(html).toContain('data-slot="documents-trash-restore"');
    expect(html).toContain('data-slot="documents-trash-purge"');
    expect(html).toContain("Delete now");
    // One document: nothing to restore "all" of.
    expect(html).not.toContain('data-slot="documents-trash-restore-all"');
  });

  it("falls back to the file name, and says the last day plainly", () => {
    const html = render(
      <RecentlyDeletedView />,
      seedList([
        doc({
          title: null,
          sourceSystem: null,
          purgeAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      ]),
    );
    expect(html).toContain("blood.pdf");
    expect(html).not.toContain("Imported from");
    expect(html).toContain("Removed for good within a day.");
  });

  it("offers Restore all with more than one document, and the cap notice when cut", () => {
    const html = render(
      <RecentlyDeletedView />,
      seedList([doc(), doc({ id: "doc-2", title: "X-ray" })], true),
    );
    expect(html).toContain('data-slot="documents-trash-restore-all"');
    expect(html).toContain("Restore all");
    expect(html).toContain("Deleted documents (2)");
    expect(html).toContain('data-slot="list-cap-notice"');
  });

  it("empty: says so and leads back to the vault", () => {
    const html = render(<RecentlyDeletedView />, seedList([]));
    expect(html).toContain("Nothing in Recently deleted");
    expect(html).not.toContain('data-slot="documents-trash-card"');
  });
});

describe("<VaultPageActions> — the way into Recently deleted", () => {
  const actions = (inSharedRecord = false) => (
    <VaultPageActions
      canManageDocuments={!inSharedRecord}
      inSharedRecord={inSharedRecord}
      hideUpload={false}
      uploadInputRef={createRef<HTMLInputElement>()}
    />
  );
  const seedUsage = (deletedCount: number) => (qc: QueryClient) =>
    qc.setQueryData(queryKeys.inboundDocumentUsage(), { deletedCount });

  it("links to Recently deleted with the count while something is in it", () => {
    const html = render(actions(), seedUsage(3));
    expect(html).toContain('data-slot="documents-recently-deleted"');
    expect(html).toContain('href="/documents/deleted"');
    expect(html).toContain('aria-label="Recently deleted (3)"');
    expect(html).toContain("(3)");
  });

  it("shows nothing while Recently deleted is empty or the usage is out", () => {
    expect(render(actions(), seedUsage(0))).not.toContain(
      "documents-recently-deleted",
    );
    expect(render(actions())).not.toContain("documents-recently-deleted");
  });

  it("shows nothing inside somebody else's record", () => {
    expect(render(actions(true), seedUsage(3))).not.toContain(
      "documents-recently-deleted",
    );
  });
});
