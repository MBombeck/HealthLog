import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { IntakeHistoryListV2 } from "@/components/medications/intake-history-list-v2";

/**
 * v1.4.36 W4a — IntakeHistoryListV2 SSR smoke tests.
 *
 * Mirrors the project convention: `renderToStaticMarkup` +
 * react-query data seeded via `QueryClient.setQueryData()`. Sort-toggle
 * is a useState interaction and cannot fire through SSR, so the
 * toggle test exercises the seeded sortDir/sortBy variants and pins
 * the rendered indicator markup.
 */

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

function seedIntake(
  client: QueryClient,
  medId: string,
  rows: IntakeRow[],
  total: number = rows.length,
  opts: {
    sortBy?: "takenAt" | "scheduledFor";
    sortDir?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {},
) {
  const sortBy = opts.sortBy ?? "takenAt";
  const sortDir = opts.sortDir ?? "desc";
  const limit = opts.limit ?? 25;
  const offset = opts.offset ?? 0;
  client.setQueryData(
    [
      "medications",
      medId,
      "intake",
      "list",
      { sortBy, sortDir, limit, offset },
    ],
    { events: rows, meta: { total, limit, offset } },
  );
}

function render(
  node: React.ReactNode,
  client: QueryClient,
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<IntakeHistoryListV2> — empty state", () => {
  it("renders the empty-state title and CTA in English", () => {
    const client = makeClient();
    seedIntake(client, "med-1", []);
    const html = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      client,
    );
    expect(html).toContain("No intakes recorded yet");
    expect(html).toContain("Open daily intake");
    expect(html).toContain('href="/medications"');
  });

  it("renders the empty-state title and CTA in German", () => {
    const client = makeClient();
    seedIntake(client, "med-1", []);
    const html = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      client,
      "de",
    );
    expect(html).toContain("Noch keine Einnahmen erfasst");
    expect(html).toContain("Zur Tagesübersicht");
  });
});

describe("<IntakeHistoryListV2> — populated rows", () => {
  it("renders one row per intake event with status + source badges", () => {
    const client = makeClient();
    seedIntake(client, "med-1", [
      {
        id: "evt-1",
        medicationId: "med-1",
        scheduledFor: "2026-05-15T08:00:00.000Z",
        takenAt: "2026-05-15T08:02:00.000Z",
        skipped: false,
        source: "WEB",
        createdAt: "2026-05-15T08:02:00.000Z",
      },
      {
        id: "evt-2",
        medicationId: "med-1",
        scheduledFor: "2026-05-14T08:00:00.000Z",
        takenAt: null,
        skipped: true,
        source: "REMINDER",
        createdAt: "2026-05-14T20:00:00.000Z",
      },
    ]);
    const html = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      client,
    );
    expect(html).toContain("Taken");
    expect(html).toContain("Skipped");
    expect(html).toContain("Website");
    expect(html).toContain("Telegram / Reminder");
  });

  it("renders the section title across both locales", () => {
    const client = makeClient();
    seedIntake(client, "med-1", []);
    const enHtml = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      client,
    );
    expect(enHtml).toContain("Intake history");

    const deClient = makeClient();
    seedIntake(deClient, "med-1", []);
    const deHtml = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      deClient,
      "de",
    );
    expect(deHtml).toContain("Einnahme-Verlauf");
  });
});

describe("<IntakeHistoryListV2> — sort indicators", () => {
  it("renders a desc arrow on the active sort column", () => {
    const client = makeClient();
    seedIntake(client, "med-1", [
      {
        id: "evt-1",
        medicationId: "med-1",
        scheduledFor: "2026-05-15T08:00:00.000Z",
        takenAt: "2026-05-15T08:02:00.000Z",
        skipped: false,
        source: "WEB",
        createdAt: "2026-05-15T08:02:00.000Z",
      },
    ]);
    const html = render(
      <IntakeHistoryListV2 medicationId="med-1" />,
      client,
    );
    // Default sort = takenAt desc, so the "taken" header carries the
    // arrow-down icon and the "scheduled" header carries the neutral
    // dual-arrow icon.
    expect(html).toContain("arrow-down");
    expect(html).toContain("arrow-up-down");
  });

  it("applies focus-visible ring + min-h-11 to sort header buttons", () => {
    const client = makeClient();
    seedIntake(client, "med-a11y", [
      {
        id: "evt-1",
        medicationId: "med-a11y",
        scheduledFor: "2026-05-15T08:00:00.000Z",
        takenAt: "2026-05-15T08:02:00.000Z",
        skipped: false,
        source: "WEB",
        createdAt: "2026-05-15T08:02:00.000Z",
      },
    ]);
    const html = render(
      <IntakeHistoryListV2 medicationId="med-a11y" />,
      client,
    );
    expect(html).toContain("focus-visible:ring-ring");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("focus-visible:ring-offset-2");
    expect(html).toContain("min-h-11");
  });

  it("renders pagination controls only when more than one page", () => {
    const client = makeClient();
    // 50 total > pageSize 25 → pagination should render
    seedIntake(
      client,
      "med-2",
      [
        {
          id: "evt-1",
          medicationId: "med-2",
          scheduledFor: "2026-05-15T08:00:00.000Z",
          takenAt: "2026-05-15T08:02:00.000Z",
          skipped: false,
          source: "WEB",
          createdAt: "2026-05-15T08:02:00.000Z",
        },
      ],
      50,
    );
    const html = render(
      <IntakeHistoryListV2 medicationId="med-2" />,
      client,
    );
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
    // a11y: pagination buttons clear the 44 px mobile touch floor and
    // collapse to 36 px from sm+ so the row stays compact on desktop.
    expect(html).toContain("min-h-11");
    expect(html).toContain("sm:min-h-9");
  });

  it("hides pagination when total ≤ pageSize", () => {
    const client = makeClient();
    seedIntake(
      client,
      "med-3",
      [
        {
          id: "evt-1",
          medicationId: "med-3",
          scheduledFor: "2026-05-15T08:00:00.000Z",
          takenAt: "2026-05-15T08:02:00.000Z",
          skipped: false,
          source: "WEB",
          createdAt: "2026-05-15T08:02:00.000Z",
        },
      ],
      1,
    );
    const html = render(
      <IntakeHistoryListV2 medicationId="med-3" />,
      client,
    );
    expect(html).not.toContain(">Previous<");
    expect(html).not.toContain(">Next<");
  });
});
