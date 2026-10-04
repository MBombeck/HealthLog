import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";

// The user bubble pulls `useAuth().user.avatarUrl` to mirror the
// Coach avatar (v1.5.5 — self-hosted avatar; replaces v1.4.22 B3
// Gravatar leak). SSR rendering through `renderToStaticMarkup` has
// no TanStack-Query provider, so we mock the hook the same way
// `recommendation-feedback.test.tsx` does — returning a tester user
// with no avatar so we exercise the initials fallback path by
// default, and override per-test where needed.
const useAuthMock = vi.fn<
  () => {
    user: {
      id: string;
      username: string;
      role: string;
      avatarUrl: string | null;
    };
    isAuthenticated: boolean;
    isLoading: boolean;
  }
>(() => ({
  user: {
    id: "test-user",
    username: "tester",
    role: "USER",
    avatarUrl: null,
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
  // The remember-message control resolves the client for its about-me
  // invalidation; these render tests never trigger it.
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

// v1.39.4 — the stored tables of a message, served by the lazy read. Empty
// unless a test hands some in.
const storedResults: { value: CoachResultEntry[] | undefined } = {
  value: undefined,
};
vi.mock("@/hooks/use-coach-message-results", () => ({
  useCoachMessageResults: () => ({
    ref: () => {},
    results: storedResults.value,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));

import {
  MessageThread,
  placeInterleaved,
  type InterleavedThreadItem,
} from "../message-thread";
import type {
  CoachConversationDetailDTO,
  CoachResultEntry,
  CoachResultTable,
} from "@/lib/ai/coach/types";
import type { CoachStreamingMessage } from "../use-coach";

// v1.18.9 — `CoachStreamingMessage` gained a `usage` field for the
// per-message token footer. The fixtures below predate it; this builder
// fills the defaults so each test only spells out the fields it cares
// about.
function streaming(
  partial: Partial<CoachStreamingMessage>,
): CoachStreamingMessage {
  return {
    content: "",
    metricSource: null,
    suggestion: null,
    suggestedAction: null,
    steps: [],
    results: [],
    followUps: [],
    clarification: null,
    inProgress: false,
    messageId: null,
    errorCode: null,
    usage: null,
    ...partial,
  };
}

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
  fenced: false,
  attachmentCount: 0,
  messages: [
    {
      id: "m1",
      role: "user",
      content: "Why was BP higher on Monday?",
      createdAt: "2026-05-10T09:00:00.000Z",
      metricSource: null,
      providerType: null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
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
      tokensUsed: 312,
      model: "gpt-4o",
    },
  ],
};

describe("<MessageThread>", () => {
  it("dates a table copied from an earlier answer by that answer, in the full-width answer column", () => {
    const reused: CoachResultTable = {
      ref: "r1",
      source: {
        tool: "get_metric_table",
        domain: "bp",
        window: "last30days",
        period: "current",
        granularity: "day",
      },
      shape: "timeSeries",
      titleKey: "coach.result.title.byDay",
      title: "Blood pressure by day",
      rowCount: 1,
      chartKind: null,
      displayed: true,
      reusedFrom: { messageId: "m2", ref: "r1" },
      columns: [
        {
          key: "day",
          kind: "period",
          labelKey: "coach.result.column.day",
          label: "Day",
        },
      ],
      rows: [["2026-05-09"]],
      truncated: false,
      chart: null,
    };
    const {
      columns: _c,
      rows: _r,
      truncated: _t,
      chart: _ch,
      ...meta
    } = reused;
    storedResults.value = [reused];
    try {
      const html = render(
        <MessageThread
          conversation={{
            ...baseConversation,
            messages: [
              ...baseConversation.messages,
              {
                ...baseConversation.messages[1],
                id: "m3",
                createdAt: "2026-05-12T09:00:00.000Z",
                metricSource: { windows: [], metrics: [], results: [meta] },
              },
            ],
          }}
        />,
      );
      // m2 was written on 10 May; the copy in m3 names that day.
      expect(html).toMatch(/From an earlier answer \([^)]*10[^)]*\)/);
      expect(html).toMatch(
        /data-slot="coach-answer-column" class="[^"]*\bw-full\b[^"]*"/,
      );
    } finally {
      storedResults.value = undefined;
    }
  });

  it("shows the empty hint when no conversation and no streaming", () => {
    const html = render(<MessageThread conversation={null} />);
    expect(html).toContain('data-slot="coach-message-thread"');
    expect(html).toContain(
      "Ask anything about your trends, medications, or readings",
    );
  });

  it("announces the empty-thread hero as a polite live region", () => {
    // v1.11.3 D5 — the bespoke empty-state hero stays (gradient avatar),
    // but it must carry `role="status"` + `aria-live="polite"` so screen
    // readers announce the hint when the thread first mounts.
    const html = render(<MessageThread conversation={null} />);
    const threadTag = html.match(
      /<div[^>]*data-slot="coach-message-thread"[^>]*>/,
    );
    expect(threadTag?.[0]).toContain('role="status"');
    expect(threadTag?.[0]).toContain('aria-live="polite"');
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

  it("folds an older message's provenance into the areas header, never a raw key", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-turn-steps-done"');
    expect(html).toContain("Looked at 1 area");
    expect(html).not.toContain('data-slot="coach-source-chips"');
    expect(html).not.toContain("insights.coach.metric.");
    expect(html).not.toContain("n=26");
  });

  it("renders an in-flight streaming bubble alongside persisted history", () => {
    const html = render(
      <MessageThread
        conversation={baseConversation}
        streaming={streaming({
          content: "Looking at your data ",
          metricSource: null,
          suggestion: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        })}
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
    // v1.18.9 — the live streaming turn renders each word in its own
    // fade-in <span> (`<StreamedProse>`), so the prose is no longer one
    // contiguous text node; assert each word is present span-wrapped.
    for (const word of ["Looking ", "at ", "your ", "data"]) {
      expect(html).toContain(`>${word}</span>`);
    }
  });

  it("shows the streaming-only bubble when no conversation is loaded yet", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={streaming({
          content: "Drafting…",
          metricSource: null,
          suggestion: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        })}
      />,
    );
    expect(html).toContain("Drafting…");
    expect(html).toContain('data-slot="coach-bubble-assistant"');
  });

  it("renders the 'thinking' placeholder when content is empty but inProgress", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={streaming({
          content: "",
          metricSource: null,
          suggestion: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        })}
      />,
    );
    expect(html).toContain("Thinking");
  });

  it("surfaces the provider error copy when an error frame fired", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={streaming({
          content: "",
          metricSource: null,
          suggestion: null,
          inProgress: false,
          messageId: null,
          errorCode: "errorProvider",
        })}
      />,
    );
    // v1.4.33 IW7 — copy rewritten from "AI provider" to "Insights
    // provider" per the project-voice rule (no "KI"/"AI" prefix in
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
          tokensUsed: null,
          model: null,
        },
      ],
    };

    const html = render(
      <MessageThread
        conversation={conv}
        streaming={streaming({
          content: "Looking at your data ",
          metricSource: null,
          suggestion: null,
          inProgress: false,
          messageId: "m3-streaming",
          errorCode: null,
        })}
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

  it("renders a streaming turn and a persisted one in the same wrapper", () => {
    // The persisted copy replaces the streamed one under the same key; for
    // React to keep the bubble, both must sit in the same element chain.
    const live = render(
      <MessageThread
        conversation={baseConversation}
        streaming={streaming({
          content: "Looking at your data ",
          metricSource: null,
          suggestion: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        })}
      />,
    );
    const liveTurn = live.match(
      /<div data-slot="coach-assistant-turn" data-turn-key="coach-turn-1"[^>]*>/,
    )?.[0];
    expect(liveTurn).toContain('role="log"');
    expect(liveTurn).toContain('aria-live="polite"');
    const persisted = render(<MessageThread conversation={baseConversation} />);
    const turns =
      persisted.match(/<div data-slot="coach-assistant-turn"[^>]*>/g) ?? [];
    expect(turns.length).toBeGreaterThan(0);
    // Settled, the wrapper is no longer a live region.
    for (const turn of turns) expect(turn).not.toContain("aria-live");
  });

  it("still renders the streaming bubble while inProgress and id is null", () => {
    // Mid-stream — `messageId` is null, persisted twin can't exist
    // yet. Confirm the streaming branch survives the v1.4.20.1
    // de-dup logic.
    const html = render(
      <MessageThread
        conversation={baseConversation}
        streaming={streaming({
          content: "Looking at your data ",
          metricSource: null,
          suggestion: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        })}
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

  it("shows no evidence disclosure and no raw key values under an answer", () => {
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
            ],
          },
        },
      ],
    };
    const html = render(<MessageThread conversation={withKeyValues} />);
    expect(html).not.toContain('data-slot="coach-evidence"');
    expect(html).not.toContain("What I&#x27;m looking at");
    expect(html).not.toContain("138 mmHg");
    // The areas the answer drew on stay reachable from the header.
    expect(html).toContain("Looked at 1 area");
  });

  it("names the areas header in German under 'de'", () => {
    const html = render(
      <MessageThread conversation={baseConversation} />,
      "de",
    );
    expect(html).toContain("1 Bereich angesehen");
    expect(html).not.toContain("Worauf bezieht sich das?");
  });

  it("leaves out a metric token the bundle cannot name", () => {
    const unknown: CoachConversationDetailDTO = {
      ...baseConversation,
      messages: [
        baseConversation.messages[0],
        {
          ...baseConversation.messages[1],
          metricSource: {
            windows: [],
            // A token an older seed wrote; it names nothing.
            metrics: ["bloodPressure" as never, "general"],
          },
        },
      ],
    };
    const html = render(<MessageThread conversation={unknown} />);
    expect(html).not.toContain('data-slot="coach-turn-steps"');
    expect(html).not.toContain("bloodPressure");
  });

  it("renders no disclosure when there is no provenance at all", () => {
    const noProvenance: CoachConversationDetailDTO = {
      ...baseConversation,
      messages: [
        baseConversation.messages[0],
        {
          ...baseConversation.messages[1],
          metricSource: { windows: [], metrics: [] },
        },
      ],
    };
    const html = render(<MessageThread conversation={noProvenance} />);
    expect(html).not.toContain('data-slot="coach-evidence"');
    expect(html).not.toContain('data-slot="coach-turn-steps"');
  });

  it("renders the user bubble with the self-hosted avatar when one is set (v1.5.5)", () => {
    // The user-bubble avatar uses the same dimensions as the Coach
    // avatar and pulls the self-hosted avatar URL from useAuth.
    useAuthMock.mockReturnValueOnce({
      user: {
        id: "u-1",
        username: "testuser",
        role: "USER",
        avatarUrl: "/api/user/avatar/u-1?v=1700000000000",
      },
      isAuthenticated: true,
      isLoading: false,
    });
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-bubble-user-avatar"');
    expect(html).toMatch(
      /<img[^>]+src="\/api\/user\/avatar\/u-1\?v=1700000000000/,
    );
    expect(html).toMatch(
      /data-slot="coach-bubble-user-avatar"[^>]*class="[^"]*size-8/,
    );
  });

  it("falls back to initials when no avatar URL is present", () => {
    // Default mock returns avatarUrl: null → initials path.
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
        streaming={streaming({
          content: "",
          metricSource: null,
          suggestion: null,
          inProgress: true,
          messageId: null,
          errorCode: null,
        })}
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

  // v1.16.8 — the remember control under persisted user bubbles.
  it("renders the remember control under a persisted user message", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    expect(html).toContain('data-slot="coach-remember-message"');
    expect(html).toContain("Remember");
  });

  it("localises the remember control under 'de'", () => {
    const html = render(
      <MessageThread conversation={baseConversation} />,
      "de",
    );
    expect(html).toContain('data-slot="coach-remember-message"');
    expect(html).toContain("Merken");
  });

  it("omits the remember control on an optimistic user bubble (no id yet)", () => {
    const html = render(
      <MessageThread
        conversation={null}
        optimisticUser={{
          localId: "local-1",
          content: "Ich habe eine Erdnussallergie",
          conversationId: null,
        }}
      />,
    );
    expect(html).toContain('data-slot="coach-bubble-user"');
    expect(html).not.toContain('data-slot="coach-remember-message"');
  });

  it("omits the remember control when the message exceeds the field cap", () => {
    const long = {
      ...baseConversation,
      messages: [
        {
          ...baseConversation.messages[0],
          content: "x".repeat(501),
        },
      ],
    };
    const html = render(<MessageThread conversation={long} />);
    expect(html).toContain('data-slot="coach-bubble-user"');
    expect(html).not.toContain('data-slot="coach-remember-message"');
  });

  it("reveals the user action row on bubble hover/focus at sm+, keeps it visible on touch", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    const row = html.match(
      /<div[^>]*data-slot="coach-user-actions"[^>]*>/,
    )?.[0];
    expect(row).toBeTruthy();
    // Hidden only behind BOTH gates — `sm:` viewport AND a
    // hover-capable pointer — so touch devices (no hover media) keep
    // the row always visible.
    expect(row).toContain("sm:[@media(hover:hover)]:opacity-0");
    expect(row).toContain(
      "sm:[@media(hover:hover)]:group-hover/user-bubble:opacity-100",
    );
    expect(row).toContain(
      "sm:[@media(hover:hover)]:group-focus-within/user-bubble:opacity-100",
    );
    expect(html).toContain("group/user-bubble");
  });

  it("puts remember in the user's action row, not on a line of its own", () => {
    const html = render(<MessageThread conversation={baseConversation} />);
    const row = html.match(
      /<div[^>]*data-slot="coach-user-actions"[^>]*>([\s\S]*?)<\/div>/,
    )?.[1];
    expect(row).toBeTruthy();
    const copy = row!.indexOf('data-slot="coach-remember-message"');
    const time = row!.indexOf('data-slot="coach-message-time"');
    expect(copy).toBeGreaterThan(-1);
    expect(time).toBeGreaterThan(copy);
    expect(html).not.toContain('data-slot="coach-remember-message-done"');
  });

  it("keeps the remember button mounted once it has settled, so focus stays on it", () => {
    // A disabled or unmounted button drops keyboard focus to <body>; the
    // settled button only turns inert. SSR cannot click, so the wiring is
    // pinned structurally.
    const src = readFileSync(
      join(
        process.cwd(),
        "src/components/insights/coach-panel/message-actions.tsx",
      ),
      "utf8",
    );
    expect(src).toContain("aria-disabled={inert || undefined}");
    expect(src).not.toMatch(
      /data-slot="coach-remember-message"[\s\S]{0,400}(?<![-\w])disabled=\{/,
    );
  });

  // v1.4.25 W5 — distinct daily-limit vs provider-rate-limit copy.
  it("surfaces the daily-limit copy for coach.budget.exceeded", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={streaming({
          content: "",
          metricSource: null,
          suggestion: null,
          inProgress: false,
          messageId: null,
          errorCode: "coach.budget.exceeded",
        })}
      />,
    );
    expect(html).toContain(
      "Daily limit reached. The budget refreshes at midnight UTC.",
    );
    // v1.4.33 IW7 — fallback copy rewritten ("AI provider" -> "Insights
    // provider"). Both old and new strings should be absent here when
    // the budget-exceeded error takes precedence.
    expect(html).not.toContain("could not reach an Insights provider");
  });

  it("surfaces the provider rate-limit copy for coach.provider.rate_limited", () => {
    const html = render(
      <MessageThread
        conversation={null}
        streaming={streaming({
          content: "",
          metricSource: null,
          suggestion: null,
          inProgress: false,
          messageId: null,
          errorCode: "coach.provider.rate_limited",
        })}
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
        streaming={streaming({
          content: "",
          metricSource: null,
          suggestion: null,
          inProgress: false,
          messageId: null,
          errorCode: null,
        })}
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
      "coach.stream",
    ]) {
      expect(errorCodeToI18nKey(code)).toBe("insights.coach.errorProvider");
    }
  });

  // v1.18.6 — a "no provider configured anywhere" turn is a setup gap,
  // not a transient failure, so it carries its own guided-setup copy.
  it("maps the no-provider case to its dedicated guided-setup copy", () => {
    expect(errorCodeToI18nKey("coach.provider.none")).toBe(
      "insights.coach.errorNoProvider",
    );
  });

  // v1.4.43 QoL (M6) — `coach.network` no longer collapses to the
  // generic provider copy; the user needs the actionable offline hint.
  it("maps coach.network to the dedicated offline key", () => {
    expect(errorCodeToI18nKey("coach.network")).toBe(
      "insights.coach.errorNetwork",
    );
  });

  // v1.11.0 W1 — a dead primary credential gets the reconnect copy, not
  // the generic provider-unavailable copy.
  it("maps coach.provider.credential_expired to the reconnect key", () => {
    expect(errorCodeToI18nKey("coach.provider.credential_expired")).toBe(
      "insights.coach.errorCredentialExpired",
    );
  });

  // v1.39 — a refused turn names its reason. The capability refusals carry
  // their code in `meta.errorCode`; each maps to copy that says what is off
  // and who can change it, never the generic "provider unavailable".
  it("maps each AI capability refusal to its own copy", () => {
    expect(errorCodeToI18nKey("consent.ai.required")).toBe(
      "insights.coach.errorConsent",
    );
    expect(errorCodeToI18nKey("ai.record.notPermitted")).toBe(
      "insights.coach.errorNotPermitted",
    );
    expect(errorCodeToI18nKey("ai.unavailable")).toBe(
      "insights.coach.errorUnavailable",
    );
    expect(errorCodeToI18nKey("ai.provider.none")).toBe(
      "insights.coach.errorNoProvider",
    );
    expect(errorCodeToI18nKey("assistant.disabled.coach")).toBe(
      "insights.coach.errorOperatorOff",
    );
    expect(errorCodeToI18nKey("assistant.disabled.enabled")).toBe(
      "insights.coach.errorOperatorOff",
    );
    expect(errorCodeToI18nKey("module.disabled")).toBe(
      "insights.coach.errorCoachOff",
    );
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

/**
 * v1.16.5 — placement of guided-flow bubbles between the persisted
 * messages, the optimistic user bubble, and the thread tail.
 */
describe("placeInterleaved", () => {
  const item = (
    key: string,
    anchorAnswer: string | null,
  ): InterleavedThreadItem => ({
    key,
    anchorAnswer,
    node: <span data-testid={key} />,
  });
  const user = (id: string, content: string) => ({
    id,
    role: "user",
    content,
  });
  const assistant = (id: string, content: string) => ({
    id,
    role: "assistant",
    content,
  });

  it("anchors an answered question before its persisted user message", () => {
    const placed = placeInterleaved(
      [item("q1", "My answer"), item("q2", null)],
      [
        user("m1", "Earlier turn"),
        assistant("m2", "Earlier reply"),
        user("m3", "My answer"),
        assistant("m4", "Reply"),
      ],
      null,
    );
    expect(placed.before.get("m3")?.key).toBe("q1");
    expect(placed.beforeOptimistic).toEqual([]);
    expect(placed.tail.map((i) => i.key)).toEqual(["q2"]);
  });

  it("anchors before the optimistic bubble while the twin is in flight", () => {
    const placed = placeInterleaved(
      [item("q1", "My answer")],
      [user("m1", "Earlier turn")],
      "My answer",
    );
    expect(placed.before.size).toBe(0);
    expect(placed.beforeOptimistic.map((i) => i.key)).toEqual(["q1"]);
    expect(placed.tail).toEqual([]);
  });

  it("matches assistant-content collisions never (user messages only)", () => {
    const placed = placeInterleaved(
      [item("q1", "My answer")],
      [assistant("m1", "My answer")],
      null,
    );
    expect(placed.before.size).toBe(0);
    expect(placed.tail.map((i) => i.key)).toEqual(["q1"]);
  });

  it("consumes duplicate answers in order", () => {
    const placed = placeInterleaved(
      [item("q1", "Yes"), item("q2", "Yes")],
      [user("m1", "Yes"), assistant("m2", "r"), user("m3", "Yes")],
      null,
    );
    expect(placed.before.get("m1")?.key).toBe("q1");
    expect(placed.before.get("m3")?.key).toBe("q2");
  });

  it("falls back to the tail when an anchor never matches", () => {
    const placed = placeInterleaved(
      [item("q1", "Lost answer"), item("summary", null)],
      [user("m1", "Something else")],
      null,
    );
    expect(placed.before.size).toBe(0);
    expect(placed.tail.map((i) => i.key)).toEqual(["q1", "summary"]);
  });
});

describe("<MessageThread> interleaved guided bubbles", () => {
  it("renders an unanchored item at the tail even on an empty thread", () => {
    const html = render(
      <MessageThread
        conversation={null}
        interleaved={[
          {
            key: "q1",
            anchorAnswer: null,
            node: <div data-slot="guided-test-bubble">First question?</div>,
          },
        ]}
      />,
    );
    // The guided bubble suppresses the empty-state hero…
    expect(html).not.toContain(
      "Ask anything about your trends, medications, or readings",
    );
    // …and renders inside the scroller.
    expect(html).toContain('data-slot="guided-test-bubble"');
    expect(html).toContain("First question?");
  });

  it("renders an anchored item before the user message that answered it", () => {
    const html = render(
      <MessageThread
        conversation={baseConversation}
        interleaved={[
          {
            key: "q1",
            anchorAnswer: "Why was BP higher on Monday?",
            node: <div data-slot="guided-test-bubble">Guided question?</div>,
          },
        ]}
      />,
    );
    const guidedAt = html.indexOf('data-slot="guided-test-bubble"');
    const userAt = html.indexOf('data-slot="coach-bubble-user"');
    expect(guidedAt).toBeGreaterThan(-1);
    expect(userAt).toBeGreaterThan(-1);
    expect(guidedAt).toBeLessThan(userAt);
  });
});
