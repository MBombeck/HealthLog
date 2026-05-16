import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// The user bubble pulls `useAuth().user.gravatarUrl` to mirror the
// Coach avatar (v1.4.22 B3). SSR rendering through `renderToStaticMarkup`
// has no TanStack-Query provider, so we mock the hook the same way
// `recommendation-feedback.test.tsx` does — returning a tester user
// with no Gravatar so we exercise the initials fallback path by
// default, and override per-test where needed.
const useAuthMock = vi.fn<
  () => {
    user: {
      id: string;
      username: string;
      role: string;
      gravatarUrl: string | null;
    };
    isAuthenticated: boolean;
    isLoading: boolean;
  }
>(() => ({
  user: {
    id: "test-user",
    username: "tester",
    role: "USER",
    gravatarUrl: null,
  },
  isAuthenticated: true,
  isLoading: false,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => useAuthMock(),
}));

// v1.4.23 H4 — message-thread reads `useQuery(["coach-prefs"])` so the
// evidence disclosure honours `showEvidenceByDefault`. SSR has no
// QueryClientProvider; stub the hook to return the legacy defaults so
// the existing assertions on the closed-by-default disclosure stay
// representative.
//
// v1.4.23 H7 — also stubs `useMutation` for the per-message thumbs
// feedback row inside the assistant bubble.
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  }),
}));

import { MessageThread } from "../message-thread";
import type { CoachConversationDetailDTO } from "@/lib/ai/coach/types";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const baseConversation: CoachConversationDetailDTO = {
  id: "conv-1",
  title: "Why was BP higher on Monday?",
  createdAt: "2026-05-10T09:00:00.000Z",
  updatedAt: "2026-05-10T09:01:00.000Z",
  messageCount: 2,
  messages: [
    {
      id: "m1",
      role: "user",
      content: "Why was BP higher on Monday?",
      createdAt: "2026-05-10T09:00:00.000Z",
      metricSource: null,
      providerType: null,
      promptVersion: null,
    },
    {
      id: "m2",
      role: "assistant",
      content:
        "Looking at your last 6 Mondays, the morning systolic averaged …",
      createdAt: "2026-05-10T09:00:30.000Z",
      metricSource: {
        windows: ["last30days"],
        metrics: ["bp"],
        counts: { bp: 26 },
      },
      providerType: "admin-openai",
      promptVersion: "4.20.0",
    },
  ],
};

describe("<MessageThread>", () => {
  it("shows the empty hint when no conversation and no streaming", () => {
    const html = render(<MessageThread conversation={null} />);
    expect(html).toContain('data-slot="coach-message-thread"');
    expect(html).toContain(
      "Ask anything about your trends, medications, or readings",
    );
  });

  it("renders user + assistant bubbles for a persisted conversation", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-bubble-user"');
    expect(html).toContain('data-slot="coach-bubble-assistant"');
    expect(html).toContain("Why was BP higher on Monday?");
    expect(html).toContain(
      "Looking at your last 6 Mondays, the morning systolic averaged",
    );
  });

  it("renders source chips below an assistant bubble that carries provenance", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-source-chips"');
    expect(html).toContain('data-metric="bp"');
    expect(html).toContain("last 30 days");
    expect(html).toContain("n=26");
  });

  it("renders an in-flight streaming bubble alongside persisted history", () => {
    const html = render(
      <MessageThread
        conversation={baseConversation}
        streaming={{
          content: "Looking at your data ",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    // 1 persisted user + 1 persisted assistant + 1 streaming assistant.
    const userBubbles = (html.match(/data-slot="coach-bubble-user"/g) ?? [])
      .length;
    const assistantBubbles = (
      html.match(/data-slot="coach-bubble-assistant"/g) ?? []
    ).length;
    expect(userBubbles).toBe(1);
    expect(assistantBubbles).toBe(2);
    expect(html).toContain("Looking at your data");
  });

  it("shows the streaming-only bubble when no conversation is loaded yet", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "Drafting…",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    expect(html).toContain("Drafting…");
    expect(html).toContain('data-slot="coach-bubble-assistant"');
  });

  it("renders the 'thinking' placeholder when content is empty but inProgress", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    expect(html).toContain("Thinking");
  });

  it("surfaces the provider error copy when an error frame fired", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: "errorProvider",
        }}
      />,
    );
    // v1.4.33 IW7 — copy rewritten from "AI provider" to "Insights
    // provider" per the Marc-Voice rule (no "KI"/"AI" prefix in
    // user-facing strings).
    expect(html).toContain("could not reach an Insights provider");
  });

  it("hides the streaming bubble once its persisted twin lands by id", () => {
    // After the SSE `done` frame the hook keeps `streaming.content`
    // populated AND fires a TanStack invalidate. When the invalidated
    // refetch resolves, the persisted message lands inside
    // `conversation.messages` while `streaming.messageId` matches
    // exactly. Without de-dup the user sees the assistant reply twice.
    const conv: CoachConversationDetailDTO = {
      ...baseConversation,
      messages: [
        ...baseConversation.messages,
        {
          id: "m3-streaming",
          role: "assistant",
          content: "Looking at your data fresh persisted",
          createdAt: "2026-05-10T09:01:30.000Z",
          metricSource: null,
          providerType: "admin-openai",
          promptVersion: "4.20.0",
        },
      ],
    };

    const html = render(
      <MessageThread
        conversation={conv}
        streaming={{
          content: "Looking at your data ",
          metricSource: null,
          inProgress: false,
          messageId: "m3-streaming",
          errorCode: null,
        }}
      />,
    );
    // 1 persisted user + 2 persisted assistant + 0 streaming → 2.
    const assistantBubbles = (
      html.match(/data-slot="coach-bubble-assistant"/g) ?? []
    ).length;
    expect(assistantBubbles).toBe(2);
    // The persisted text shows; the older streaming sketch does not
    // appear as a separate bubble.
    expect(html).toContain("fresh persisted");
  });

  it("still renders the streaming bubble while inProgress and id is null", () => {
    // Mid-stream — `messageId` is null, persisted twin can't exist
    // yet. Confirm the streaming branch survives the v1.4.20.1
    // de-dup logic.
    const html = render(
      <MessageThread
        conversation={baseConversation}
        streaming={{
          content: "Looking at your data ",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    const assistantBubbles = (
      html.match(/data-slot="coach-bubble-assistant"/g) ?? []
    ).length;
    expect(assistantBubbles).toBe(2);
  });

  it("uses German empty hint when locale is 'de'", () => {
    const html = render(<MessageThread conversation={null} />, "de");
    expect(html).toContain(
      "Frag mich etwas zu deinen Trends, Medikamenten oder Messwerten",
    );
  });

  it("renders the evidence-block disclosure when keyValues is non-empty (EN)", () => {
    // v1.4.22 — the Coach surfaces load-bearing numbers in a
    // collapsible "What I'm looking at" disclosure under the assistant
    // bubble. Verify the structure renders correctly and the entries
    // show label / value / unit / window.
    const withKeyValues: CoachConversationDetailDTO = {
      ...baseConversation,
      messages: [
        baseConversation.messages[0],
        {
          ...baseConversation.messages[1],
          metricSource: {
            windows: ["last30days"],
            metrics: ["bp"],
            keyValues: [
              {
                label: "avg7 systolic",
                value: "138",
                unit: "mmHg",
                window: "last7days",
              },
              {
                label: "avg30 systolic",
                value: "134",
                unit: "mmHg",
                window: "last30days",
              },
            ],
          },
        },
      ],
    };
    const html = render(<MessageThread conversation={withKeyValues} />);
    expect(html).toContain('data-slot="coach-evidence"');
    expect(html).toContain("What I&#x27;m looking at");
    expect(html).toContain('data-slot="coach-evidence-list"');
    const rows = (html.match(/data-slot="coach-evidence-row"/g) ?? []).length;
    expect(rows).toBe(2);
    // v1.4.25 W5 — per-row source labels were dropped. The values +
    // units + window framing stay; the redundant `kv.label` prefix
    // (e.g. "avg7 systolic:") does not appear.
    expect(html).not.toContain("avg7 systolic");
    expect(html).not.toContain("avg30 systolic");
    expect(html).toContain("138 mmHg");
    expect(html).toContain("(last7days)");
    expect(html).toContain("134 mmHg");
    // Disclosure is collapsed by default (no `open` attribute).
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });

  it("renders the evidence-block label in German under 'de' locale", () => {
    const withKeyValues: CoachConversationDetailDTO = {
      ...baseConversation,
      messages: [
        baseConversation.messages[0],
        {
          ...baseConversation.messages[1],
          metricSource: {
            windows: ["last30days"],
            metrics: ["bp"],
            keyValues: [
              {
                label: "avg30 systolisch",
                value: "138",
                unit: "mmHg",
                window: "last30days",
              },
            ],
          },
        },
      ],
    };
    const html = render(<MessageThread conversation={withKeyValues} />, "de");
    expect(html).toContain("Worauf bezieht sich das?");
  });

  it("renders entries without unit or window cleanly", () => {
    const withKeyValues: CoachConversationDetailDTO = {
      ...baseConversation,
      messages: [
        baseConversation.messages[0],
        {
          ...baseConversation.messages[1],
          metricSource: {
            windows: [],
            metrics: ["compliance"],
            keyValues: [{ label: "30-day adherence", value: "96" }],
          },
        },
      ],
    };
    const html = render(<MessageThread conversation={withKeyValues} />);
    // v1.4.25 W5 — `kv.label` no longer renders; only the value
    // bubbles up. The row still mounts so the value is visible.
    expect(html).not.toContain("30-day adherence");
    expect(html).toContain('data-slot="coach-evidence-row"');
    expect(html).toMatch(/<strong[^>]*>\s*96\s*<\/strong>/);
  });

  it("hides the disclosure entirely when keyValues is empty or absent", () => {
    // baseConversation.messages[1].metricSource has no `keyValues`
    // field — the source chips still render but the disclosure does
    // not appear at all.
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).not.toContain('data-slot="coach-evidence"');
    expect(html).not.toContain("What I&#x27;m looking at");
  });

  it("renders the user bubble with a Gravatar when one is set (B3 parity)", () => {
    // v1.4.22 B3 — the user-bubble avatar uses the same dimensions
    // as the Coach avatar and pulls the Gravatar URL from useAuth.
    useAuthMock.mockReturnValueOnce({
      user: {
        id: "u-1",
        username: "marc",
        role: "USER",
        gravatarUrl: "https://www.gravatar.com/avatar/abc123?s=64&d=mp",
      },
      isAuthenticated: true,
      isLoading: false,
    });
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-bubble-user-avatar"');
    expect(html).toMatch(
      /<img[^>]+src="https:\/\/www\.gravatar\.com\/avatar\/abc123/,
    );
    expect(html).toMatch(
      /data-slot="coach-bubble-user-avatar"[^>]*class="[^"]*size-8/,
    );
  });

  it("falls back to initials when no Gravatar URL is present", () => {
    // Default mock returns gravatarUrl: null → initials path.
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-bubble-user-avatar"');
    expect(html).toMatch(/data-slot="coach-bubble-user-avatar"[^>]*>TE</);
  });

  // v1.4.25 W5 — optimistic user bubble appears before the "Thinking…"
  // placeholder so the visible order matches the user's mental model.
  it("renders the optimistic user bubble before the streaming Thinking placeholder", () => {
    const html = render(
      <MessageThread
        conversation={null}
        optimisticUser={{
          localId: "local-1",
          content: "Wie ist mein Blutdruck letzte Woche?",
          conversationId: null,
        }}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    expect(html).toContain("Wie ist mein Blutdruck letzte Woche?");
    expect(html).toContain("Thinking");
    // The user bubble appears before the assistant bubble in the DOM.
    const userIdx = html.indexOf('data-slot="coach-bubble-user"');
    const assistantIdx = html.indexOf('data-slot="coach-bubble-assistant"');
    expect(userIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(assistantIdx);
  });

  // v1.4.25 W5 — distinct daily-limit vs provider-rate-limit copy.
  it("surfaces the daily-limit copy for coach.budget.exceeded", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: "coach.budget.exceeded",
        }}
      />,
    );
    expect(html).toContain("Daily limit reached; resets at 00:00 UTC.");
    // v1.4.33 IW7 — fallback copy rewritten ("AI provider" -> "Insights
    // provider"). Both old and new strings should be absent here when
    // the budget-exceeded error takes precedence.
    expect(html).not.toContain("could not reach an Insights provider");
  });

  it("surfaces the provider rate-limit copy for coach.provider.rate_limited", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: "coach.provider.rate_limited",
        }}
      />,
    );
    expect(html).toContain(
      "Provider temporarily rate-limited; retry in ~5 min.",
    );
  });

  it("suppresses the optimistic user bubble once its persisted twin lands", () => {
    // baseConversation already carries a user message "Why was BP
    // higher on Monday?". Passing the same content as the optimistic
    // bubble simulates the post-`done` invalidate-refetch landing the
    // persisted user message — the optimistic copy must drop so the
    // user never sees their bubble twice.
    const html = render(
      <MessageThread
        conversation={baseConversation}
        optimisticUser={{
          localId: "local-2",
          content: "Why was BP higher on Monday?",
          conversationId: "conv-1",
        }}
        streaming={{
          content: "",
          metricSource: null,
          inProgress: false,
          messageId: null,
          errorCode: null,
        }}
      />,
    );
    const userBubbles = (html.match(/data-slot="coach-bubble-user"/g) ?? [])
      .length;
    expect(userBubbles).toBe(1);
  });
});

// v1.4.25 W5 — pin the error-code → i18n-key resolver so future code
// changes can't silently demote the daily-limit / rate-limit copy
// back to the generic provider-unavailable fallback.
import { errorCodeToI18nKey } from "../message-thread";

describe("errorCodeToI18nKey", () => {
  it("maps daily-budget exceedance to the dedicated key", () => {
    expect(errorCodeToI18nKey("coach.budget.exceeded")).toBe(
      "insights.coach.dailyLimitBody",
    );
  });

  it("maps provider rate-limit to the dedicated key", () => {
    expect(errorCodeToI18nKey("coach.provider.rate_limited")).toBe(
      "insights.coach.providerRateLimitBody",
    );
  });

  it("maps every other provider failure to the generic copy", () => {
    for (const code of [
      "coach.provider.unavailable",
      "coach.provider.empty",
      "coach.provider.none",
      "coach.network",
      "coach.stream",
    ]) {
      expect(errorCodeToI18nKey(code)).toBe("insights.coach.errorProvider");
    }
  });

  it("forward-compats unknown codes with the namespaced key", () => {
    expect(errorCodeToI18nKey("errorProvider")).toBe(
      "insights.coach.errorProvider",
    );
    expect(errorCodeToI18nKey("brand-new-code")).toBe(
      "insights.coach.brand-new-code",
    );
  });
});
