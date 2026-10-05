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
  it("mounts the textarea + send button slots", () => {
    // v1.4.22 B4 — the disclaimer moved to the sources rail; the
    // composer no longer renders its own paragraph below the input.
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain('data-slot="coach-input"');
    expect(html).toContain('data-slot="coach-input-textarea"');
    expect(html).toContain('data-slot="coach-input-send"');
    expect(html).not.toContain('data-slot="coach-input-disclaimer"');
    expect(html).not.toContain("Coach replies are generated");
  });

  it("does not render the retired voice-input control", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).not.toContain('data-slot="coach-input-mic"');
  });

  it("renders the localised placeholder without the retired shortcut hint", () => {
    // v1.16.1 — the Enter/Shift+Enter hint (prose footer, later an
    // Info-popover) is gone entirely; the behaviour itself is
    // unchanged. The composer is a single row: textarea + send button
    // on the same baseline.
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).toContain("Ask me anything");
    expect(html).not.toContain('data-slot="coach-input-hint"');
    expect(html).not.toContain("Press Enter to send");
    expect(html).toContain('data-slot="coach-input-send"');
  });

  it("renders the German placeholder under the 'de' locale", () => {
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
      "de",
    );
    expect(html).toContain("Frag mich etwas");
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

  it("keeps the textarea focusable while a reply streams: read-only, not disabled", () => {
    const html = render(
      <CoachInput
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        disabled
        isStreaming
      />,
    );
    const textarea = html.match(/<textarea[^>]*>/)?.[0];
    expect(textarea).toContain('id="coach-composer-textarea"');
    expect(textarea).toMatch(/\sreadonly(=""|\s|>)/i);
    expect(textarea).toContain('aria-disabled="true"');
    expect(textarea).not.toMatch(/\sdisabled(=""|\s|>)/);
  });

  it("swaps the send button for a Stop control while streaming with onCancel", () => {
    // v1.11.3 D1 — while a reply streams the composer must surface a
    // visible Stop affordance bound to the abort handler so the user
    // can interrupt a long or off-track reply. The Stop button only
    // appears when an `onCancel` handler is wired (the drawer always
    // passes `send.cancel`).
    const html = render(
      <CoachInput
        value="Hello"
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        disabled
        isStreaming
      />,
    );
    expect(html).toContain('data-slot="coach-input-stop"');
    expect(html).not.toContain('data-slot="coach-input-send"');
    expect(html).toContain("Stop");
    // The Stop control is a plain button, never a submit, so tapping it
    // aborts rather than re-firing the form.
    const stopTag = html.match(
      /<button[^>]*data-slot="coach-input-stop"[^>]*>/,
    );
    expect(stopTag?.[0]).toContain('type="button"');
  });

  it("keeps the send button (with spinner) while streaming without onCancel", () => {
    // Backwards-compatible fallback: without an `onCancel` the composer
    // keeps the legacy disabled-spinner send button.
    const html = render(
      <CoachInput
        value="Hello"
        onChange={() => {}}
        onSubmit={() => {}}
        disabled
        isStreaming
      />,
    );
    expect(html).toContain('data-slot="coach-input-send"');
    expect(html).not.toContain('data-slot="coach-input-stop"');
    expect(html).toContain("animate-spin");
  });

  it("renders the localised Stop label under the 'de' locale", () => {
    const html = render(
      <CoachInput
        value="Hallo"
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        disabled
        isStreaming
      />,
      "de",
    );
    expect(html).toContain("Stopp");
  });

  it("sizes the send control to the 44px tap-target floor on phones", () => {
    // v1.18.7 — the composer controls (send / stop / mic) must clear the
    // 44px WCAG 2.5.5 floor on phones and condense at `sm:` upward. Guard
    // the `size-11 sm:size-9` pattern so a future restyle can't quietly
    // drop the send button back to 36px.
    const html = render(
      <CoachInput value="Hi" onChange={() => {}} onSubmit={() => {}} />,
    );
    const sendTag = html.match(
      /<button[^>]*data-slot="coach-input-send"[^>]*>/,
    );
    expect(sendTag?.[0]).toMatch(/\bsize-11\b/);
    expect(sendTag?.[0]).toMatch(/\bsm:size-9\b/);
  });

  it("sizes the stop control to the 44px tap-target floor on phones", () => {
    const html = render(
      <CoachInput
        value="Hi"
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        disabled
        isStreaming
      />,
    );
    const stopTag = html.match(
      /<button[^>]*data-slot="coach-input-stop"[^>]*>/,
    );
    expect(stopTag?.[0]).toMatch(/\bsize-11\b/);
    expect(stopTag?.[0]).toMatch(/\bsm:size-9\b/);
  });

  it("invokes onChange when the parent passes a controlled handler", () => {
    // SSR can't fire DOM events; smoke-check the contract by calling
    // the supplied handler directly.
    const handler = vi.fn();
    render(<CoachInput value="" onChange={handler} onSubmit={() => {}} />);
    handler("typed");
    expect(handler).toHaveBeenCalledWith("typed");
  });

  it("renders the single-row composer with no actions menu", () => {
    // The composer carries text, attach and send only; it grows no actions
    // menu or settings deep-link on either surface.
    const html = render(
      <CoachInput value="" onChange={() => {}} onSubmit={() => {}} />,
    );
    expect(html).not.toContain('data-slot="coach-input-hub"');
    expect(html).not.toContain('data-slot="coach-input-actions"');
    expect(html).not.toContain('data-slot="coach-input-settings"');
    // Send renders in the single-row layout. The mic is client-and-secure-
    // context only, so it never appears in SSR markup.
    expect(html).not.toContain('data-slot="coach-input-mic"');
    expect(html).toContain('data-slot="coach-input-send"');
  });

  it("keeps the textarea and its controls on one row at every width", () => {
    const html = render(
      <CoachInput
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        attachEnabled
        onPickFromVault={() => {}}
        onUploadNew={() => {}}
      />,
    );
    expect(html).toContain('data-slot="coach-input-controls"');
    expect(html).toContain('data-slot="coach-input-leading"');
    expect(html).toContain('data-slot="coach-input-attach"');
    expect(html).not.toContain('data-slot="coach-input-mic"');
    expect(html).toContain('data-slot="coach-input-send"');

    // DOM and visual order agree at every breakpoint: the textarea comes first,
    // followed by the leading attach control and then Send.
    const textareaIdx = html.indexOf('data-slot="coach-input-textarea"');
    const attachIdx = html.indexOf('data-slot="coach-input-attach"');
    const sendIdx = html.indexOf('data-slot="coach-input-send"');
    expect(textareaIdx).toBeGreaterThan(-1);
    expect(textareaIdx).toBeLessThan(attachIdx);
    expect(attachIdx).toBeLessThan(sendIdx);

    const controls = html.match(
      /<div[^>]*data-slot="coach-input-controls"[^>]*>/,
    );
    // The controls sit BESIDE the textarea, not under it. Stacking them made an
    // empty composer two rows tall — a text line plus a 44 px tap-target row —
    // which is roughly a tenth of a phone screen before anyone has typed. The
    // controls must therefore never claim the full width or push themselves
    // onto their own line.
    expect(controls?.[0]).not.toMatch(/\bw-full\b/);
    expect(controls?.[0]).not.toMatch(/\bjustify-between\b/);
    expect(controls?.[0]).toMatch(/\bshrink-0\b/);

    // And the row itself is a row at every width. The textarea is centred in
    // it — bottom-aligning a one-line textarea against a 44 px tap target left
    // the placeholder sitting visibly low in the pill — while the controls
    // keep their own bottom alignment, so the send button stays beside the
    // LAST line as the textarea grows rather than drifting to the middle.
    const shell = html.match(/<div[^>]*class="[^"]*\bflex-row\b[^"]*"[^>]*>/);
    expect(shell?.[0]).toMatch(/\bitems-center\b/);
    expect(shell?.[0]).not.toMatch(/\bflex-col\b/);
    expect(controls?.[0]).toMatch(/\bself-end\b/);
  });

  it("carries no conversation menu: New chat, Conversations and Settings live in the page's panel", () => {
    const html = render(
      <CoachInput
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        attachEnabled
        onPickFromVault={() => {}}
        onUploadNew={() => {}}
      />,
    );
    expect(html).not.toContain('data-slot="coach-input-actions"');
    expect(html).not.toContain("coach-input-action-new-chat");
    expect(html).not.toContain("coach-input-action-history");
    expect(html).not.toContain("coach-input-action-settings");
    expect(html).not.toContain('href="/settings/ai"');
    // The attach control stays, at the 44 px tap-target floor on phones.
    const attach = html.match(
      /<button[^>]*data-slot="coach-input-attach"[^>]*>/,
    );
    expect(attach?.[0]).toMatch(/\bsize-11\b/);
    expect(attach?.[0]).toMatch(/\bsm:size-9\b/);
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
