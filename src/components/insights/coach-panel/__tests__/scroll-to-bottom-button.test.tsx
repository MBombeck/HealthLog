/**
 * The jump-to-latest button: invisible and out of reach at the end of the
 * thread, visible and reachable away from it, and without a transition
 * under reduced motion. The thread drives `visible` from its scroll state.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { I18nProvider } from "@/lib/i18n/context";

import { ScrollToBottomButton } from "../scroll-to-bottom-button";

function render(visible: boolean) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ScrollToBottomButton visible={visible} onClick={() => {}} />
    </I18nProvider>,
  );
}

describe("<ScrollToBottomButton>", () => {
  it("is hidden, inert and out of the tab order at the end", () => {
    const html = render(false);
    expect(html).toContain('data-visible="false"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toMatch(/class="[^"]*\bopacity-0\b/);
    expect(html).toMatch(/class="[^"]*\spointer-events-none\s/);
  });

  it("is visible, labelled and focusable away from the end", () => {
    const html = render(true);
    const button = html.match(/<button[^>]*>/)![0];
    expect(button).toContain('data-visible="true"');
    expect(button).toContain('aria-label="Jump to the latest message"');
    expect(button).not.toContain("aria-hidden");
    expect(button).not.toContain("tabindex");
    expect(html).toMatch(/class="[^"]*\bopacity-100\b/);
    expect(button).not.toMatch(/[\s"]pointer-events-none[\s"]/);
  });

  it("fades without motion when the reader asks for less", () => {
    expect(render(true)).toContain("motion-reduce:transition-none");
  });

  it("is wired to the thread's pinned state and returns focus to the composer", () => {
    // SSR cannot scroll; the wiring is pinned structurally.
    const src = readFileSync(
      join(
        process.cwd(),
        "src/components/insights/coach-panel/message-thread.tsx",
      ),
      "utf8",
    );
    expect(src).toContain(
      "<ScrollToBottomButton visible={!pinned} onClick={scrollToLatest} />",
    );
    expect(src).toMatch(
      /scrollToLatest = useCallback\([\s\S]*?wasPinnedRef\.current = true;[\s\S]*?focusCoachComposer\(\);/,
    );
  });
});
