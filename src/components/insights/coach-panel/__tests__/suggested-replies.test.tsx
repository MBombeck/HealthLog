/**
 * v1.41 — the one quiet reply pattern: pills under the latest answer that
 * send their label as the person's own message.
 */
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { getServerTranslator } from "@/lib/i18n/server-translator";

vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      getServerTranslator("en").t(key, params),
  }),
}));

const focusComposer = vi.fn();
vi.mock("../composer-focus", () => ({
  focusCoachComposer: () => focusComposer(),
}));

import { SuggestedReplies, type SuggestedReply } from "../suggested-replies";

function pills(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(pills);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  const own = el.props["data-reply-id"] ? [el] : [];
  return [...own, ...pills(el.props.children as ReactNode)];
}

function replies(onSelect: (id: string) => void): SuggestedReply[] {
  return [
    "Resting heart rate",
    "Walking heart rate",
    "Both",
    "Neither",
    "Fifth",
  ].map((label, i) => ({
    id: `c${i + 1}`,
    label,
    kind: "clarification",
    data: { "data-choice-id": `c${i + 1}` },
    onSelect: () => onSelect(`c${i + 1}`),
  }));
}

describe("<SuggestedReplies>", () => {
  it("renders at most four quiet outline pills in a labelled group", () => {
    const tree = SuggestedReplies({
      replies: replies(() => {}),
      messageId: "m1",
      disabled: false,
    });
    const html = tree ? renderToStaticMarkup(tree) : "";
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Suggested replies"');
    expect(html).toContain('data-slot="coach-suggested-replies"');
    expect(html).toContain('data-message-id="m1"');
    expect(html).not.toContain("Fifth");
    const rendered = pills(tree);
    expect(rendered).toHaveLength(4);
    for (const pill of rendered) {
      expect(pill.props.variant).toBe("outline");
      const cls = String(pill.props.className);
      // The answer's text size, low contrast in the foreground, a pill.
      expect(cls).toContain("text-sm");
      expect(cls).toContain("font-normal");
      expect(cls).toContain("text-foreground/80");
      expect(cls).toContain("rounded-full");
      expect(cls).toContain("min-h-11");
      // Never an accent, never muted-with-alpha.
      expect(cls).not.toMatch(/\bprimary\b|text-muted-foreground\/\d/);
    }
  });

  it("marks keyboard focus with the neutral ring, never the purple one", () => {
    const tree = SuggestedReplies({
      replies: replies(() => {}),
      messageId: "m1",
      disabled: false,
    });
    const html = tree ? renderToStaticMarkup(tree) : "";
    // The class the browser gets, after the primitive's variant classes and
    // ours are merged.
    const classes = [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map(
      (m) => m[1],
    );
    expect(classes).toHaveLength(4);
    for (const cls of classes) {
      expect(cls).toContain("focus-visible:ring-input-focus");
      expect(cls).toContain("focus-visible:border-border");
      expect(cls).toContain("focus-visible:ring-2");
      expect(cls).not.toMatch(
        /(?:^|\s)focus-visible:(?:ring-ring|border-ring|ring-\[3px\])/,
      );
    }
  });

  it("sends the tapped reply and hands focus to the composer", () => {
    focusComposer.mockClear();
    const onSelect = vi.fn();
    const tree = SuggestedReplies({
      replies: replies(onSelect),
      messageId: "m1",
      disabled: false,
    });
    (pills(tree)[1].props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith("c2");
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });

  it("is hidden while a turn runs, and when there is nothing to offer", () => {
    expect(
      SuggestedReplies({
        replies: replies(() => {}),
        messageId: "m1",
        disabled: true,
      }),
    ).toBeNull();
    expect(
      SuggestedReplies({ replies: [], messageId: "m1", disabled: false }),
    ).toBeNull();
  });
});
