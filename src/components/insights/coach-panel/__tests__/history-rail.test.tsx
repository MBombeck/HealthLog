import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { HistoryRail } from "../history-rail";
import type { CoachConversationsPage } from "@/lib/ai/coach/types";

/**
 * v1.4.20 phase B2b — history-rail render snapshot.
 * v1.30.2 (QoL H1) — the rail now reads `useCoachConversationHistory`
 * (`useInfiniteQuery`), so the seeded cache shape moved from a single
 * `CoachConversationsPage` under the flat `coachConversations()` key to the
 * `{ pages, pageParams }` infinite-query shape under
 * `queryKeys.coachConversationHistory(search)`.
 *
 * The rail mounts a TanStack Query subscription so we have to wrap it
 * in a `<QueryClientProvider>`. We seed the cache with synthetic page(s)
 * so the rail renders the populated state in one pass — server-side
 * rendering doesn't drive a real network call.
 */

function makeClientWithConversations(
  page: CoachConversationsPage,
  search = "",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(queryKeys.coachConversationHistory(search), {
    pages: [page],
    pageParams: [null],
  });
  return client;
}

function makeClientWithPages(pages: CoachConversationsPage[], search = "") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(queryKeys.coachConversationHistory(search), {
    pages,
    pageParams: pages.map((_, i) => (i === 0 ? null : `cursor-${i}`)),
  });
  return client;
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

const samplePage: CoachConversationsPage = {
  conversations: [
    {
      id: "c1",
      title: "Why was BP higher on Monday?",
      createdAt: "2026-05-10T08:00:00.000Z",
      updatedAt: "2026-05-10T08:01:00.000Z",
      messageCount: 2,
      fenced: false,
    },
    {
      id: "c2",
      title: "Compare this week to last month",
      createdAt: "2026-05-09T14:00:00.000Z",
      updatedAt: "2026-05-09T14:05:00.000Z",
      messageCount: 4,
      fenced: false,
    },
  ],
  nextCursor: null,
};

describe("<HistoryRail>", () => {
  it("renders the rail wrapper + label", () => {
    const client = makeClientWithConversations(samplePage);
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    expect(html).toContain('data-slot="coach-history-rail"');
    expect(html).toContain("Conversations");
  });

  it("renders the rail label as a real `<h3>` heading (v1.4.33)", () => {
    // The rail mounts inline on `lg+` desktop where no `SheetTitle`
    // wrapper covers it. Without a real heading element the drawer
    // lost its semantic outline above the message thread — fixed in
    // v1.4.33 by promoting the rail label to `<h3>`.
    const client = makeClientWithConversations(samplePage);
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    expect(html).toMatch(
      /<h3[^>]*data-slot="coach-history-rail-heading"[^>]*>[\s\S]*Conversations[\s\S]*<\/h3>/,
    );
  });

  it("renders one row per conversation", () => {
    const client = makeClientWithConversations(samplePage);
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    const rows = html.match(/data-slot="coach-history-item"/g) ?? [];
    expect(rows.length).toBe(2);
    expect(html).toContain("Why was BP higher on Monday?");
    expect(html).toContain("Compare this week to last month");
  });

  it("flags the active row via data-active", () => {
    const client = makeClientWithConversations(samplePage);
    const html = render(
      <HistoryRail activeId="c2" onSelect={() => {}} />,
      client,
    );
    // c2 is active and gets the data-active flag.
    expect(html).toMatch(/data-slot="coach-history-item" data-active="true"/);
  });

  it("renders the empty-state copy when no conversations are cached", () => {
    const client = makeClientWithConversations({
      conversations: [],
      nextCursor: null,
    });
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    expect(html).toContain('data-slot="coach-history-empty"');
    expect(html).toContain("Your conversations will appear here.");
  });

  it("mounts the search input with the localised placeholder", () => {
    const client = makeClientWithConversations(samplePage);
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    expect(html).toMatch(
      /data-slot="coach-history-search"[^>]*placeholder="Search conversations…"/,
    );
  });

  it("uses German strings when locale is 'de'", () => {
    const client = makeClientWithConversations({
      conversations: [],
      nextCursor: null,
    });
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
      "de",
    );
    expect(html).toContain("Unterhaltungen");
    expect(html).toContain("Deine Unterhaltungen erscheinen hier");
  });

  it("renders the delete button for each conversation row", () => {
    const client = makeClientWithConversations(samplePage);
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    const buttons = html.match(/data-slot="coach-history-delete"/g) ?? [];
    expect(buttons.length).toBe(2);
  });

  it("renders an accessible rename button for each conversation row", () => {
    const client = makeClientWithConversations(samplePage);
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    const buttons = html.match(/data-slot="coach-conversation-rename"/g) ?? [];
    expect(buttons.length).toBe(2);
    expect(html).toContain('aria-label="Rename conversation"');
  });

  // v1.30.2 (QoL H1) — infinite history: reachability beyond the first page.
  it("renders every conversation across multiple cached pages (not just page one)", () => {
    const client = makeClientWithPages([
      samplePage,
      {
        conversations: [
          {
            id: "c3",
            title: "A much older thread",
            createdAt: "2026-01-01T08:00:00.000Z",
            updatedAt: "2026-01-01T08:01:00.000Z",
            messageCount: 1,
            fenced: false,
          },
        ],
        nextCursor: null,
      },
    ]);
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    const rows = html.match(/data-slot="coach-history-item"/g) ?? [];
    expect(rows.length).toBe(3);
    expect(html).toContain("A much older thread");
  });

  it("renders the load-more sentinel when a cached page still carries a nextCursor", () => {
    const client = makeClientWithConversations({
      ...samplePage,
      nextCursor: "c2",
    });
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    // The sentinel div is aria-hidden — IntersectionObserver never fires
    // during a static SSR render, but the element itself must be present
    // for the rail to ever pull the next page in a real browser.
    expect(html).toMatch(/aria-hidden="true"[^>]*class="h-px"/);
  });

  it("does not render the load-more sentinel once the caller has reached the end", () => {
    const client = makeClientWithConversations(samplePage); // nextCursor: null
    const html = render(
      <HistoryRail activeId={null} onSelect={() => {}} />,
      client,
    );
    expect(html).not.toMatch(/class="h-px"/);
  });
});
