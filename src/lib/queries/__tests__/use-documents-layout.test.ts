/**
 * The vault presentation switch: field-scoped PUT, optimistic cache flip,
 * rollback and a toast when the save fails. Exercised through the
 * dependency-injected `runSetDocumentsLayout`, without a React render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { apiPut } from "@/lib/api/api-fetch";
import { toast } from "sonner";
import { runSetDocumentsLayout } from "@/lib/queries/use-documents-layout";
import { queryKeys } from "@/lib/query-keys";
import type { DocumentsLayout } from "@/lib/documents/documents-layout";

const t = (key: string) => key;
const key = queryKeys.documentsLayout();
const STORED: DocumentsLayout = {
  version: 1,
  view: "cards",
  arrangement: "stacked",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("runSetDocumentsLayout", () => {
  it("sends only the field that changed and keeps the server's answer", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, STORED);
    const saved: DocumentsLayout = { ...STORED, arrangement: "flow" };
    vi.mocked(apiPut).mockResolvedValue(saved);

    await runSetDocumentsLayout({
      patch: { arrangement: "flow" },
      queryClient,
      t,
    });

    expect(apiPut).toHaveBeenCalledWith("/api/documents/inbound/layout", {
      version: 1,
      arrangement: "flow",
    });
    expect(queryClient.getQueryData(key)).toEqual(saved);
  });

  it("flips the cache before the save lands", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, STORED);
    let settle: (value: DocumentsLayout) => void = () => {};
    vi.mocked(apiPut).mockReturnValue(
      new Promise<DocumentsLayout>((resolve) => {
        settle = resolve;
      }),
    );

    const run = runSetDocumentsLayout({
      patch: { view: "list" },
      queryClient,
      t,
    });
    expect(queryClient.getQueryData<DocumentsLayout>(key)?.view).toBe("list");
    settle({ ...STORED, view: "list" });
    await run;
  });

  it("is not undone by a first read still in flight", async () => {
    const queryClient = new QueryClient();
    let answerRead: (value: DocumentsLayout) => void = () => {};
    const read = queryClient
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<DocumentsLayout>((resolve) => {
            answerRead = resolve;
          }),
      })
      .catch(() => undefined);
    let settle: (value: DocumentsLayout) => void = () => {};
    vi.mocked(apiPut).mockReturnValue(
      new Promise<DocumentsLayout>((resolve) => {
        settle = resolve;
      }),
    );

    const run = runSetDocumentsLayout({
      patch: { view: "list" },
      queryClient,
      t,
    });
    // The read answers with the stored layout while the save is pending.
    answerRead(STORED);
    await read;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queryClient.getQueryData<DocumentsLayout>(key)?.view).toBe("list");

    settle({ ...STORED, view: "list" });
    await run;
    expect(queryClient.getQueryData<DocumentsLayout>(key)?.view).toBe("list");
  });

  it("rolls back and says so when the save fails", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, STORED);
    vi.mocked(apiPut).mockRejectedValue(new Error("offline"));

    await runSetDocumentsLayout({ patch: { view: "list" }, queryClient, t });

    expect(queryClient.getQueryData(key)).toEqual(STORED);
    expect(toast.error).toHaveBeenCalledWith("documents.layout.saveFailed");
  });
});
