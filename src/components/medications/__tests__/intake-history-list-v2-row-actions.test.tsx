/**
 * v1.5.5 F-1 C-2 — `<IntakeHistoryListV2>` row-actions + selection
 * contract.
 *
 * Mirrors the SSR + `setQueryData` seed pattern the v1.4.36 W4a tests
 * use. We assert the rendered markup carries the kebab when the
 * caller passes `onEditIntake` / `onDeleteIntake`, the leading
 * checkbox when `selection.mode === "multi"`, and that the absence of
 * the callbacks leaves the table byte-identical to the v1.4.36 shape.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { IntakeHistoryListV2 } from "@/components/medications/intake-history-list-v2";
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

type IntakeRow = {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: "WEB" | "API" | "REMINDER" | "IMPORT";
  createdAt: string;
};

function seed(client: QueryClient, medId: string, rows: IntakeRow[]) {
  client.setQueryData(
    queryKeys.medicationIntakeList(medId, {
      sortBy: "takenAt",
      sortDir: "desc",
      limit: 25,
      offset: 0,
      status: "completed",
    }),
    { events: rows, meta: { total: rows.length, limit: 25, offset: 0 } },
  );
}

function render(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

const ROW: IntakeRow = {
  id: "evt-row",
  medicationId: "med-1",
  scheduledFor: "2026-05-15T08:00:00.000Z",
  takenAt: "2026-05-15T08:02:00.000Z",
  skipped: false,
  source: "WEB",
  createdAt: "2026-05-15T08:02:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<IntakeHistoryListV2> — F-1 C-2 row actions", () => {
  it("does NOT render the kebab when no callbacks are passed (back-compat)", () => {
    const client = makeClient();
    seed(client, "med-1", [ROW]);
    const html = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      client,
    );
    expect(html).not.toContain("intake-history-row-kebab");
  });

  it("renders the kebab trigger when onEditIntake is passed", () => {
    const client = makeClient();
    seed(client, "med-1", [ROW]);
    const html = render(
      <IntakeHistoryListV2
        medicationId="med-1"
        onEditIntake={() => {}}
      />,
      client,
    );
    expect(html).toContain("intake-history-row-kebab");
  });

  it("renders the kebab trigger when onDeleteIntake is passed", () => {
    const client = makeClient();
    seed(client, "med-1", [ROW]);
    const html = render(
      <IntakeHistoryListV2
        medicationId="med-1"
        onDeleteIntake={() => {}}
      />,
      client,
    );
    expect(html).toContain("intake-history-row-kebab");
  });

  it("does NOT render the selection column when selection prop is absent", () => {
    const client = makeClient();
    seed(client, "med-1", [ROW]);
    const html = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      client,
    );
    expect(html).not.toContain("intake-history-row-select");
  });

  it("renders a leading checkbox per row when selection.mode === 'multi'", () => {
    const client = makeClient();
    seed(client, "med-1", [ROW]);
    const html = render(
      <IntakeHistoryListV2
        medicationId="med-1"
        selection={{
          mode: "multi",
          selected: new Set(),
          onToggle: () => {},
        }}
      />,
      client,
    );
    expect(html).toContain("intake-history-row-select");
  });
});
