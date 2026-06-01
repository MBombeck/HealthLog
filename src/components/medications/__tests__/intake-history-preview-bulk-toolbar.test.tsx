/**
 * v1.5.5 F-1 C-2 — `<IntakeHistoryPreview>` smoke tests.
 *
 * The preview mounts in SSR with an empty selection so the bulk-
 * delete toolbar stays hidden by default. Selection / dialog flips
 * are interactive surfaces and are exercised by the e2e suite.
 *
 * The kebab + selection wiring is covered by
 * `intake-history-list-v2-row-actions.test.tsx`; this file pins the
 * wrapper-level contract (no toolbar by default, wired through the
 * v1.5.5 endpoints).
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { IntakeHistoryPreview } from "@/components/medications/sections/intake-history-preview";
import { queryKeys } from "@/lib/query-keys";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "test-user", username: "tester", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
}

function seed(client: QueryClient) {
  client.setQueryData(
    queryKeys.medicationIntakeList("med-1", {
      sortBy: "takenAt",
      sortDir: "desc",
      limit: 14,
      offset: 0,
      status: "completed",
    }),
    {
      events: [
        {
          id: "evt-1",
          medicationId: "med-1",
          scheduledFor: "2026-05-15T08:00:00.000Z",
          takenAt: "2026-05-15T08:02:00.000Z",
          skipped: false,
          source: "WEB",
          createdAt: "2026-05-15T08:02:00.000Z",
        },
      ],
      meta: { total: 1, limit: 14, offset: 0 },
    },
  );
}

function render(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<IntakeHistoryPreview> — F-1 C-2", () => {
  it("hides the bulk-delete toolbar when nothing is selected (initial render)", () => {
    const client = makeClient();
    seed(client);
    const html = render(
      <IntakeHistoryPreview
        medicationId="med-1"
        importOpen={false}
        onImportOpenChange={() => {}}
      />,
      client,
    );
    expect(html).not.toContain("intake-history-bulk-delete-toolbar");
  });

  it("renders the row-action kebab and selection checkbox on every row", () => {
    const client = makeClient();
    seed(client);
    const html = render(
      <IntakeHistoryPreview
        medicationId="med-1"
        importOpen={false}
        onImportOpenChange={() => {}}
      />,
      client,
    );
    // Per-row affordances feature 15 + 16 — the row carries both.
    expect(html).toContain("intake-history-row-kebab");
    expect(html).toContain("intake-history-row-select");
    // The import header CTA stays alongside the new affordances.
    expect(html).toContain("intake-history-import");
  });
});
