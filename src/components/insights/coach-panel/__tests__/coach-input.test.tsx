import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachInput } from "../coach-input";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<CoachInput>", () => {
  it("mounts the textarea + send button slots (mic dropped in W5)", () => {
    // v1.4.22 B4 — the disclaimer moved to the sources rail; the
    // composer no longer renders its own paragraph below the input.
    // v1.4.25 W5 — the non-functional mic icon was removed.
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain('data-slot="coach-input"');
    expect(html).toContain('data-slot="coach-input-textarea"');
    expect(html).toContain('data-slot="coach-input-send"');
    expect(html).not.toContain('data-slot="coach-input-mic"');
    expect(html).not.toContain('data-slot="coach-input-disclaimer"');
    expect(html).not.toContain("Coach replies are generated");
  });

  it("renders the localised placeholder + hint", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain("Ask anything about your data");
    expect(html).toContain("Press Enter to send");
  });

  it("renders the German placeholder under the 'de' locale", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
      "de",
    );
    expect(html).toContain("Frag mich etwas zu deinen Daten");
  });

  it("no longer renders a mic button (W5 removed the placeholder)", () => {
    // v1.4.25 W5 — the mic icon used to be rendered + disabled with a
    // "voice arrives with iOS" tooltip. Marc flagged it as a click-
    // trap: nothing happened on tap. The composer now drops the icon
    // entirely; voice input remains a v1.5 iOS feature.
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).not.toMatch(/data-slot="coach-input-mic"/);
    expect(html).not.toContain("Voice input arrives with the iOS app");
  });

  it("disables the send button when the value is empty", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag?.[0]).toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("disables the send button when value is whitespace-only", () => {
    const html = render(
      <CoachInput value="   " onChange={() => {}} onSubmit={() => {}} />,
    );
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag?.[0]).toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("enables the send button when there is non-empty content", () => {
    const html = render(
      <CoachInput
        value="Why was BP higher on Monday?"
        onChange={() => {}}
        onSubmit={() => {}}
      />,
    );
    // Locate the send button tag and assert no boolean `disabled=""`
    // attribute (Tailwind class names contain the word `disabled` in
    // utilities like `disabled:opacity-50`, so we match the actual
    // attribute form `disabled=""` that React emits for boolean
    // attributes).
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag).not.toBeNull();
    expect(sendTag?.[0]).not.toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("disables the send button while streaming", () => {
    const html = render(
      <CoachInput
        value="Hello"
        onChange={() => {}}
        onSubmit={() => {}}
        disabled
        isStreaming
      />,
    );
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag?.[0]).toMatch(/\sdisabled(=""|\s|>)/);
    // Spinner replaces the send icon in the streaming state.
    expect(html).toContain("animate-spin");
  });

  it("invokes onChange when the parent passes a controlled handler", () => {
    // SSR can't fire DOM events; smoke-check the contract by calling
    // the supplied handler directly.
    const handler = vi.fn();
    render(<CoachInput value="" onChange={handler} onSubmit={() => {}} />);
    handler("typed");
    expect(handler).toHaveBeenCalledWith("typed");
  });

  it("renders the textarea at rows=1 initial state (W5 auto-grow baseline)", () => {
    // v1.4.25 W5 — Claude-web-style auto-grow. SSR baseline is a
    // single-line textarea; the client-side `useEffect` measures
    // `scrollHeight` and grows the height up to ~6 lines. The static
    // markup must show `rows="1"` so the initial paint matches the
    // disclaimer text height on the left side of the row.
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toMatch(/data-slot="coach-input-textarea"[^>]*rows="1"/);
    // The textarea caps growth via the `max-h-[9.5rem]` class so the
    // composer never pushes the rest of the drawer off-screen.
    expect(html).toMatch(
      /data-slot="coach-input-textarea"[^>]*class="[^"]*max-h-\[9\.5rem\]/,
    );
  });
});

// v1.4.25 W5 — `computeAutoGrowHeight` is the pure helper backing the
// textarea's auto-grow effect. Pin its math so the textarea never
// collapses below a single line or grows past the 6-line ceiling.
import { computeAutoGrowHeight } from "../coach-input";

describe("computeAutoGrowHeight", () => {
  it("clamps to the single-line minimum when scrollHeight is empty", () => {
    const out = computeAutoGrowHeight({
      lineHeight: 20,
      scrollHeight: 0,
      maxLines: 6,
      paddingY: 10,
    });
    expect(out).toBe(20 + 10);
  });

  it("returns the natural scrollHeight when below the cap", () => {
    const out = computeAutoGrowHeight({
      lineHeight: 20,
      scrollHeight: 60,
      maxLines: 6,
      paddingY: 10,
    });
    expect(out).toBe(60);
  });

  it("caps at maxLines × lineHeight + paddingY", () => {
    const out = computeAutoGrowHeight({
      lineHeight: 20,
      scrollHeight: 999,
      maxLines: 6,
      paddingY: 10,
    });
    expect(out).toBe(20 * 6 + 10);
  });
});
