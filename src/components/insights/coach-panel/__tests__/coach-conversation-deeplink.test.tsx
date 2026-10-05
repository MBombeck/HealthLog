import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// v1.21.4 (B) — the page surface routes "Conversations" to the dedicated
// `/coach/conversations` page via the app router, so the shared surface now
// reads `useRouter`. Stub it for the static-markup render.
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { CoachConversation } from "../coach-conversation";
import type {
  CoachConversationsPage,
  CoachConversationDetailDTO,
} from "@/lib/ai/coach/types";

/**
 * v1.18.11 (W11, #67) — the Coach page is a deep-link target INTO a
 * conversation. These tests pin the selection contract on the shared
 * `<CoachConversation>` page surface:
 *
 *   - `initialConversationId` opens that exact thread on mount (the `?c=`
 *     deep-link the dashboard Coach entry carries).
 *   - `autoOpenMostRecent` opens the server-authoritative most-recent thread
 *     (the `updatedAt desc` head of the rail list) when no id is pinned.
 *   - With neither, the surface keeps the new-chat hero.
 *
 * Selection is observed through the rendered output: an open thread paints
 * the docked page composer (`coach-page-composer`) and NOT the new-chat hero
 * (`coach-hero`). The cache is seeded so SSR renders the resolved state in a
 * single pass — no real network call.
 */

const RAIL: CoachConversationsPage = {
  conversations: [
    {
      id: "recent",
      title: "Most recent thread",
      createdAt: "2026-06-20T08:00:00.000Z",
      updatedAt: "2026-06-20T09:00:00.000Z",
      messageCount: 3,
      fenced: false,
    },
    {
      id: "older",
      title: "Older thread",
      createdAt: "2026-06-18T08:00:00.000Z",
      updatedAt: "2026-06-18T08:05:00.000Z",
      messageCount: 2,
      fenced: false,
    },
  ],
  nextCursor: null,
};

function detail(id: string, title: string): CoachConversationDetailDTO {
  return {
    id,
    title,
    createdAt: "2026-06-20T08:00:00.000Z",
    updatedAt: "2026-06-20T09:00:00.000Z",
    messages: [
      {
        id: `${id}-m1`,
        role: "user",
        content: `question in ${title}`,
        createdAt: "2026-06-20T08:00:00.000Z",
        metricSource: null,
        tokensUsed: null,
      },
    ],
  } as unknown as CoachConversationDetailDTO;
}

function makeClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["coachConversations"], RAIL);
  client.setQueryData(
    ["coachConversation", "recent"],
    detail("recent", "Most recent thread"),
  );
  client.setQueryData(
    ["coachConversation", "older"],
    detail("older", "Older thread"),
  );
  // The composer's pending-questions query — keep it empty so the hero gate
  // is decided purely by the active conversation id.
  client.setQueryData(["coach-about-me", "questions"], { questions: [] });
  return client;
}

function render(node: React.ReactNode, client: QueryClient): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<CoachConversation> page deep-link (#67)", () => {
  it("opens a specific thread when initialConversationId is set", () => {
    const html = render(
      <CoachConversation surface="page" initialConversationId="older" />,
      makeClient(),
    );
    // The pinned thread is open: docked composer, no new-chat hero.
    expect(html).toContain('data-slot="coach-page-composer"');
    expect(html).not.toContain('data-slot="coach-hero"');
  });

  it("keeps the clarification live region mounted before any question arrives", () => {
    // A region that mounts together with its content is not announced; the
    // empty region has to be in the page first.
    const html = render(
      <CoachConversation surface="page" initialConversationId="older" />,
      makeClient(),
    );
    expect(html).toMatch(
      /<div[^>]*data-slot="coach-clarification-live"[^>]*aria-live="polite"[^>]*class="sr-only"[^>]*><\/div>/,
    );
  });

  it("auto-opens the most-recent thread when none is pinned", () => {
    const html = render(
      <CoachConversation surface="page" autoOpenMostRecent />,
      makeClient(),
    );
    // Resolves to the rail's updatedAt-desc head — thread open, hero gone.
    expect(html).toContain('data-slot="coach-page-composer"');
    expect(html).not.toContain('data-slot="coach-hero"');
  });

  it("keeps the new-chat hero when there is nothing to open", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["coachConversations"], {
      conversations: [],
      nextCursor: null,
    });
    client.setQueryData(["coach-about-me", "questions"], { questions: [] });
    const html = render(
      <CoachConversation surface="page" autoOpenMostRecent />,
      client,
    );
    expect(html).toContain('data-slot="coach-hero"');
  });

  it("does not auto-open when autoOpenMostRecent is off (new chat)", () => {
    const html = render(<CoachConversation surface="page" />, makeClient());
    // No pin, no auto-open → the surface stays on the new-chat hero even
    // though recent conversations exist in the cache.
    expect(html).toContain('data-slot="coach-hero"');
  });

  // The page carries no toolbar and the composer no `+` menu: New chat, the
  // conversation list and the settings gear live in the conversations panel.
  // On the server the panel is closed (it docks only once the client knows
  // the viewport), so the SSR markup holds the conversation column alone.
  it("renders the conversation column with no toolbar and no composer menu", () => {
    const html = render(<CoachConversation surface="page" />, makeClient());
    expect(html).toContain('data-slot="coach-page-main"');
    expect(html).not.toContain('data-slot="coach-page-settings"');
    expect(html).not.toContain('data-slot="coach-page-toolbar"');
    expect(html).not.toContain('data-slot="coach-input-actions"');
    expect(html).not.toContain('href="/coach/conversations"');
  });
});
