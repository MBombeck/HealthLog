import type { Page, Request, Route } from "@playwright/test";

/**
 * A Coach chat stream the spec drives frame by frame.
 *
 * `route.fulfill` hands the browser the whole event stream at once, so the
 * live states of a turn (the status line moving from "Thinking…" to
 * "Fetching…" to "Summarising…", an interim table before the first token)
 * would flash by unobserved. This replaces `fetch` in the page for the chat
 * POST only: the response body is a stream the spec feeds with
 * `feed(page, frames)` and closes with `end(page)`. Every other request goes
 * through untouched, so `page.route` mocks keep working.
 *
 * The POST bodies are recorded in the page (`posts(page)`).
 */
export async function installLiveCoachStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __coachPosts: unknown[];
      __coachFeed: (frames: unknown[]) => void;
      __coachEnd: () => void;
    };
    const original = window.fetch.bind(window);
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    w.__coachPosts = [];
    w.__coachFeed = (frames) => {
      for (const frame of frames) {
        controller?.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
      }
    };
    w.__coachEnd = () => {
      controller?.close();
      controller = null;
    };
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (
        method === "POST" &&
        new URL(url, window.location.href).pathname === "/api/insights/chat"
      ) {
        w.__coachPosts.push(JSON.parse(String(init?.body ?? "{}")));
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        init?.signal?.addEventListener("abort", () => {
          try {
            controller?.error(new DOMException("aborted", "AbortError"));
          } catch {
            // already closed
          }
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return original(input, init);
    };
  });
}

export async function feed(page: Page, frames: unknown[]): Promise<void> {
  await page.evaluate((f) => {
    (window as unknown as { __coachFeed: (x: unknown[]) => void }).__coachFeed(
      f,
    );
  }, frames);
}

export async function end(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __coachEnd: () => void }).__coachEnd();
  });
}

export async function posts(
  page: Page,
): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(
    () =>
      (window as unknown as { __coachPosts: Array<Record<string, unknown>> })
        .__coachPosts,
  );
}

export function tokens(text: string) {
  return text.split(/(?<= )/).map((token) => ({ type: "token", token }));
}

function fulfilJson(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data, error: null }),
  });
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  metricSource?: Record<string, unknown> | null;
  providerType?: string | null;
}

/**
 * The conversation as the stubbed server holds it. The spec pushes the
 * persisted turn before it sends `done`, so the refetch after `done` finds
 * the copy that replaces the streamed reply.
 */
export interface StubConversation {
  id: string;
  title: string;
  messages: StoredMessage[];
  /** `…/messages/{id}/results`, by message id. */
  results: Record<string, unknown[]>;
  /** `…/messages/{id}/trail`, by message id. */
  trails: Record<string, unknown>;
}

export async function serveConversation(
  page: Page,
  conversation: StubConversation,
): Promise<void> {
  const at = (index: number) =>
    new Date(Date.UTC(2026, 9, 6, 9, 0, index)).toISOString();
  const summary = () => ({
    id: conversation.id,
    title: conversation.title,
    createdAt: at(0),
    updatedAt: at(conversation.messages.length),
    messageCount: conversation.messages.length,
    fenced: false,
    attachments: [],
    documentTitle: null,
  });
  await page.route(
    /\/api\/insights\/chat(?:\/[^?]+)?(?:\?.*)?$/,
    async (route: Route, request: Request) => {
      const url = new URL(request.url());
      const base = `/api/insights/chat/${conversation.id}`;
      const message = url.pathname.match(
        /\/messages\/([^/]+)\/(results|trail)$/,
      );
      if (message) {
        const [, id, kind] = message;
        return kind === "results"
          ? fulfilJson(route, { results: conversation.results[id] ?? [] })
          : fulfilJson(route, {
              trail: conversation.trails[id] ?? null,
              ai: { available: true, reason: null },
            });
      }
      if (url.pathname === base) {
        return fulfilJson(route, {
          ...summary(),
          attachmentCount: 0,
          summary: null,
          messages: conversation.messages.map((m, index) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: at(index + 1),
            metricSource: m.metricSource ?? null,
            providerType:
              m.role === "assistant" ? (m.providerType ?? "mock") : null,
            promptVersion: null,
            tokensUsed: m.role === "assistant" ? 420 : null,
            model: m.role === "assistant" ? "mock" : null,
          })),
        });
      }
      if (url.pathname === "/api/insights/chat" && request.method() === "GET") {
        return fulfilJson(route, {
          conversations: conversation.messages.length > 0 ? [summary()] : [],
          nextCursor: null,
        });
      }
      return route.fallback();
    },
  );
  await page.route("**/api/insights/coach/nudge-status*", (route) =>
    fulfilJson(route, { nudgedAt: null, unread: false }),
  );
  await page.route("**/api/coach/about-me/questions*", (route) =>
    fulfilJson(route, { questions: [] }),
  );
}

export function done(conversationId: string, messageId: string) {
  return {
    type: "done",
    conversationId,
    messageId,
    usage: { totalTokens: 420 },
  };
}

export async function applyTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((value: string) => {
    window.localStorage.setItem("healthlog-theme", value);
  }, theme);
}

/** Midday, so no "today / yesterday" boundary moves a label. */
export const FIXED_NOW = new Date("2026-10-06T12:00:00+02:00");
