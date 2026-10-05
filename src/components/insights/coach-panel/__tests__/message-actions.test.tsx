/**
 * The one action row under a Coach message, and the follow-up chips that
 * live in the answer's column.
 *
 *   - Assistant: copy, read aloud, try again, then the time, in one left
 *     group; the tokens and model in the right group of the same row. No
 *     feedback thumbs, no evidence disclosure.
 *   - User: copy, remember, time in one row; remember is an icon.
 *   - The time reads "14:32" today, "yesterday 14:32", or the date further
 *     back.
 *   - The chips of the latest answer render inside its column, after the
 *     action row, at the answer's text size; the memo comparator sees a new
 *     offer.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import type { CoachFollowUp } from "@/lib/ai/coach/types";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, isAuthenticated: true, isLoading: false }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-coach-message-results", () => ({
  useCoachMessageResults: () => ({
    ref: () => {},
    results: undefined,
    isLoading: false,
    isError: false,
    refetch: () => {},
  }),
}));
// SSR resolves the clipboard and speech capabilities to "absent"; claim
// both so the full row renders and its order can be read.
vi.mock("../read-aloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../read-aloud")>();
  return {
    ...actual,
    useClipboardSupported: () => true,
    ReadAloudButton: () => (
      <button type="button" data-slot="coach-read-aloud" aria-label="Read" />
    ),
  };
});

import { ChatBubble, areChatBubblePropsEqual } from "../chat-bubble";
import { answerMetaText, messageTimeText } from "../message-actions";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

/** The markup of the element carrying `slot`, up to its matching close. */
function slot(html: string, name: string): string {
  const start = html.indexOf(`data-slot="${name}"`);
  if (start < 0) return "";
  const open = html.lastIndexOf("<", start);
  const tag = html.slice(open + 1).match(/^[a-z]+/)![0];
  let depth = 0;
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = open;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return html.slice(open);
}

const CHIPS: CoachFollowUp[] = [
  {
    id: "f1",
    kind: "previous_period",
    labelKey: "coach.followUp.previousPeriod",
    label: "Compare with the period before",
    reuse: false,
    origin: "server",
  },
];

const ANSWER = {
  role: "assistant" as const,
  content: "Your blood pressure held steady.",
  metricSource: null,
  providerType: "openai",
  messageId: "m2",
  createdAt: new Date().toISOString(),
  tokensUsed: 1234,
  model: "gpt-4o-mini",
  onRegenerate: () => {},
};

describe("assistant action row", () => {
  const html = render(<ChatBubble {...ANSWER} />);
  const row = slot(html, "coach-answer-actions");
  const left = slot(row, "coach-answer-actions-left");

  it("lists copy, read aloud, try again and the time on the left, in that order", () => {
    const order = [
      "coach-copy-message",
      "coach-read-aloud",
      "coach-try-again",
      "coach-message-time",
    ].map((name) => left.indexOf(`data-slot="${name}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("puts the tokens and the model on the right of the same row", () => {
    const meta = slot(row, "coach-answer-meta");
    expect(meta).toContain("1,234 tokens · gpt-4o-mini");
    expect(meta).toContain('title="gpt-4o-mini"');
    expect(meta).toContain("truncate");
    expect(left).not.toContain("coach-answer-meta");
    expect(row).toContain("justify-between");
  });

  it("has no thumbs, no evidence disclosure and no separate token line", () => {
    expect(html).not.toContain("coach-message-feedback");
    expect(html).not.toContain("coach-evidence");
    expect(html).not.toContain("coach-token-footer");
  });

  it("shows the time as text, the full date for screen readers", () => {
    const time = slot(left, "coach-message-time");
    expect(time).toMatch(/^<time[^>]*dateTime="/);
    expect(time).toContain("Message sent");
    expect(time).toMatch(/<span aria-hidden="true">[^<]*\d:\d{2}[^<]*<\/span>/);
  });

  it("keeps an empty right group when the answer has no count", () => {
    const bare = render(
      <ChatBubble {...ANSWER} tokensUsed={null} model={null} />,
    );
    expect(slot(bare, "coach-answer-meta")).toMatch(
      /<p data-slot="coach-answer-meta"[^>]*><\/p>/,
    );
  });

  it("is absent on a refusal and while the answer is in flight", () => {
    expect(
      render(<ChatBubble {...ANSWER} providerType="refusal" />),
    ).not.toContain("coach-answer-actions");
    expect(
      render(<ChatBubble {...ANSWER} inProgress streaming />),
    ).not.toContain("coach-answer-actions");
  });
});

describe("user action row", () => {
  const html = render(
    <ChatBubble
      role="user"
      content="I am allergic to peanuts"
      messageId="m1"
      createdAt={new Date().toISOString()}
    />,
  );
  const row = slot(html, "coach-user-actions");

  it("holds copy, remember and the time in one row, flush right", () => {
    const order = [
      "coach-copy-message",
      "coach-remember-message",
      "coach-message-time",
    ].map((name) => row.indexOf(`data-slot="${name}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(row).toContain("justify-end");
  });

  it("renders remember as a labelled icon button, not a text button", () => {
    const button = slot(row, "coach-remember-message");
    expect(button).toContain('aria-label="Remember"');
    expect(button).toContain('data-state="idle"');
    expect(button).toContain("<svg");
    expect(button).not.toMatch(/>Remember</);
  });
});

describe("follow-up chips in the answer column", () => {
  const offer = { messageId: "m2", followUps: CHIPS };

  it("render inside the column, after the action row", () => {
    const html = render(
      <ChatBubble {...ANSWER} followUps={offer} onFollowUp={() => {}} />,
    );
    const column = slot(html, "coach-answer-column");
    const actions = column.indexOf('data-slot="coach-answer-actions"');
    const chips = column.indexOf('data-slot="coach-follow-up-chips"');
    expect(actions).toBeGreaterThan(-1);
    expect(chips).toBeGreaterThan(actions);
    // The answer's own text size, not the button's default.
    expect(slot(column, "coach-follow-up-chips")).toMatch(
      /class="[^"]*\btext-sm\b[^"]*font-normal/,
    );
  });

  it("step aside while another turn runs", () => {
    const html = render(
      <ChatBubble
        {...ANSWER}
        followUps={offer}
        followUpsDisabled
        onFollowUp={() => {}}
      />,
    );
    expect(html).not.toContain("coach-follow-up-chips");
  });

  it("re-render the memoised bubble when the offer changes, not when only its wrapper does", () => {
    const onFollowUp = () => {};
    const base = { ...ANSWER, onFollowUp };
    expect(
      areChatBubblePropsEqual(
        { ...base, followUps: offer },
        { ...base, followUps: { ...offer } },
      ),
    ).toBe(true);
    expect(
      areChatBubblePropsEqual(
        { ...base, followUps: null },
        { ...base, followUps: offer },
      ),
    ).toBe(false);
    expect(
      areChatBubblePropsEqual(
        { ...base, followUps: offer },
        { ...base, followUps: { ...offer, followUps: [...CHIPS] } },
      ),
    ).toBe(false);
    expect(
      areChatBubblePropsEqual(
        { ...base, followUps: offer },
        { ...base, followUps: offer, followUpsDisabled: true },
      ),
    ).toBe(false);
  });
});

describe("messageTimeText", () => {
  const { t } = getServerTranslator("en");
  // Day keys from the ISO date, the clock from its time: enough to pin the
  // three tiers without a zone.
  const formatters = {
    dateShortSmart: (v: string | number | Date) =>
      new Date(v).toISOString().slice(0, 10),
    time: (v: string | number | Date) =>
      new Date(v).toISOString().slice(11, 16),
  };
  const now = Date.parse("2026-10-04T12:00:00.000Z");

  it("is the clock alone today", () => {
    expect(
      messageTimeText("2026-10-04T08:15:00.000Z", now, formatters, t),
    ).toBe("08:15");
  });

  it("says yesterday the day before", () => {
    expect(
      messageTimeText("2026-10-03T21:40:00.000Z", now, formatters, t),
    ).toBe("yesterday 21:40");
  });

  it("adds the date further back", () => {
    expect(
      messageTimeText("2026-09-28T07:05:00.000Z", now, formatters, t),
    ).toBe("2026-09-28, 07:05");
  });
});

describe("answerMetaText", () => {
  const { t } = getServerTranslator("en");

  it("formats the count for the locale and adds the model", () => {
    expect(answerMetaText(1234, "gpt-4o", "en-US", t)).toBe(
      "1,234 tokens · gpt-4o",
    );
    expect(answerMetaText(1234, null, "de-DE", t)).toBe("1.234 tokens");
  });

  it("is nothing without a count", () => {
    expect(answerMetaText(null, "gpt-4o", "en-US", t)).toBeNull();
  });
});
