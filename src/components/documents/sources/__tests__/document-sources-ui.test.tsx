/**
 * The document picker's client gates (#1038), pinned via static renders:
 *
 *   - the import button exists only for a person in their own record with a
 *     usable connection; a delegate, an unset operator list, no connection, or
 *     a connection whose origin was removed leave no button;
 *   - its label names the one connected system, or stays generic for two;
 *   - the settings card renders nothing unless the operator enabled the
 *     picker, lists the allowed origins, and never puts a token in the markup;
 *   - every error code the routes emit has its own sentence, and an unknown
 *     one falls back to the generic sentence rather than a raw key.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let modules: Record<string, boolean> = { inboundDocuments: true };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

let shared = false;
vi.mock("@/hooks/use-record-capabilities", async (importOriginal) => ({
  holdsOwnerRights: (
    await importOriginal<typeof import("@/hooks/use-record-capabilities")>()
  ).holdsOwnerRights,
  useRecordCapabilities: () => ({
    inSharedRecord: shared,
    canManageDomain: () => !shared,
  }),
}));

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return { ...actual, apiGet: () => new Promise(() => {}) };
});

import { DocumentSourcesCard } from "@/components/settings/integrations/document-sources-card";
import en from "../../../../../messages/en.json";
import { ApiError } from "@/lib/api/api-fetch";
import {
  DOCUMENT_SOURCE_ERROR_CODES,
  type DocumentSourcesStatusDto,
} from "@/lib/documents/sources/types";
import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { ImportFromSourceButton } from "../import-from-source-button";
import { mergeIds } from "../merge-ids";
import { errorCodeOf, sourceErrorMessage } from "../source-errors";

const PAPERLESS = {
  system: "PAPERLESS" as const,
  baseUrl: "http://paperless.lan:8000",
  organizationId: null,
  hasToken: true as const,
  lastVerifiedAt: "2026-09-20T10:00:00.000Z",
  originAllowed: true,
};
const PAPRA = {
  ...PAPERLESS,
  system: "PAPRA" as const,
  baseUrl: "https://papra.example.com",
  organizationId: "org_1",
};

function render(node: React.ReactNode, status?: DocumentSourcesStatusDto) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (status)
    queryClient.setQueryData(queryKeys.documentSourcesStatus(), status);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

const on = (connections: DocumentSourcesStatusDto["connections"]) => ({
  available: true,
  allowedOrigins: ["http://paperless.lan:8000", "https://papra.example.com"],
  connections,
});

describe("<ImportFromSourceButton>", () => {
  it("names the one connected system", () => {
    const html = render(<ImportFromSourceButton />, on([PAPERLESS]));
    expect(html).toContain('data-slot="document-source-open"');
    expect(html).toContain("Import from Paperless-ngx");
  });

  it("stays generic with two", () => {
    const html = render(<ImportFromSourceButton />, on([PAPERLESS, PAPRA]));
    expect(html).toContain("Import from archive");
  });

  it("renders nothing without a usable connection", () => {
    expect(render(<ImportFromSourceButton />, on([]))).toBe("");
    expect(
      render(
        <ImportFromSourceButton />,
        on([{ ...PAPERLESS, originAllowed: false }]),
      ),
    ).toBe("");
    expect(
      render(<ImportFromSourceButton />, {
        available: false,
        allowedOrigins: [],
        connections: [],
      }),
    ).toBe("");
  });

  it("renders nothing for a delegate, even with the owner's data cached", () => {
    shared = true;
    try {
      expect(render(<ImportFromSourceButton />, on([PAPERLESS]))).toBe("");
    } finally {
      shared = false;
    }
  });

  it("renders nothing with the documents module off", () => {
    modules = { inboundDocuments: false };
    try {
      expect(render(<ImportFromSourceButton />, on([PAPERLESS]))).toBe("");
    } finally {
      modules = { inboundDocuments: true };
    }
  });
});

describe("<DocumentSourcesCard>", () => {
  it("renders nothing when the operator has not enabled the picker", () => {
    expect(
      render(<DocumentSourcesCard />, {
        available: false,
        allowedOrigins: [],
        connections: [],
      }),
    ).toBe("");
    expect(render(<DocumentSourcesCard />)).toBe("");
  });

  it("renders nothing for a delegate", () => {
    shared = true;
    try {
      expect(render(<DocumentSourcesCard />, on([PAPERLESS]))).toBe("");
    } finally {
      shared = false;
    }
  });

  it("shows the form, the allowed origins and a saved-token placeholder, never a token", () => {
    const html = render(<DocumentSourcesCard />, on([PAPERLESS]));
    expect(html).toContain('data-testid="document-sources-card"');
    expect(html).toContain("Document archives");
    expect(html).toContain(
      "Allowed on this server: http://paperless.lan:8000, https://papra.example.com",
    );
    expect(html).toContain("Saved for this address. Leave empty to keep it.");
    expect(html).toContain('value="http://paperless.lan:8000"');
    // The password field is empty: the server never sends the token back.
    expect(html).toMatch(/id="document-source-token-paperless"[^>]*value=""/);
    expect(html).toContain("Disconnect");
  });

  it("keeps a stored connection visible and removable once the operator list is gone", () => {
    const html = render(<DocumentSourcesCard />, {
      available: false,
      allowedOrigins: [],
      connections: [{ ...PAPERLESS, originAllowed: false }],
    });
    expect(html).toContain('data-testid="document-sources-card"');
    expect(html).toContain("no longer allows document archives");
    expect(html).toContain("Disconnect");
    expect(html).not.toContain("Save and test");
    expect(html).not.toContain('id="document-source-token-paperless"');
  });

  it("keeps a stored connection removable with the documents module off", () => {
    modules = { inboundDocuments: false };
    try {
      const html = render(<DocumentSourcesCard />, on([PAPERLESS]));
      expect(html).toContain("Documents are switched off");
      expect(html).toContain("Disconnect");
      expect(html).not.toContain("Save and test");
    } finally {
      modules = { inboundDocuments: true };
    }
  });

  it("uses one tab stop for the system switch", () => {
    const html = render(<DocumentSourcesCard />, on([PAPERLESS]));
    expect(html.match(/role="radio"[^>]*tabindex="0"/gi)?.length).toBe(1);
    expect(html.match(/role="radio"[^>]*tabindex="-1"/gi)?.length).toBe(1);
  });

  it("offers no disconnect or test for a system that is not connected", () => {
    const html = render(<DocumentSourcesCard />, on([]));
    expect(html).toContain("Not connected");
    expect(html).not.toContain("Disconnect");
    expect(html).toContain("Save and test");
  });
});

describe("source error sentences", () => {
  const t = (key: string) => {
    let node: unknown = en;
    for (const part of key.split(".")) {
      node = (node as Record<string, unknown> | undefined)?.[part];
    }
    return typeof node === "string" ? node : key;
  };
  const generic = t("documents.sourcePicker.errors.generic");

  it("has its own sentence for every code the routes emit", () => {
    const codes = [
      ...DOCUMENT_SOURCE_ERROR_CODES,
      "documents.sources.browserOnly",
      "documents.sources.invalidAddress",
      "documents.sources.organizationRequired",
      "documents.sources.tokenRequired",
      "documents.inbound.fileTooLarge",
      "documents.inbound.quotaExceeded",
      "documents.inbound.fileType",
      "documents.inbound.rateLimited",
      "documents.inbound.uploadBusy",
      "module.disabled",
    ];
    const sentences = new Set<string>();
    for (const code of codes) {
      const sentence = sourceErrorMessage(t, code);
      expect(sentence, code).not.toBe(generic);
      expect(sentence, code).not.toContain("documents.sourcePicker");
      sentences.add(sentence);
    }
    expect(sentences.size).toBe(codes.length);
    expect(sourceErrorMessage(t, "something.else")).toBe(generic);
    expect(sourceErrorMessage(t, undefined)).toBe(generic);
  });

  it("reads the code off a failed request", () => {
    expect(
      errorCodeOf(
        new ApiError("x", 502, { errorCode: "documents.sources.authRefused" }),
      ),
    ).toBe("documents.sources.authRefused");
    expect(errorCodeOf(new Error("x"))).toBeUndefined();
  });
});

describe("mergeIds", () => {
  it("adds imported ids to a form's selection once, in order", () => {
    expect(mergeIds(["a", "b"], ["b", "c", "c"])).toEqual(["a", "b", "c"]);
  });
});
