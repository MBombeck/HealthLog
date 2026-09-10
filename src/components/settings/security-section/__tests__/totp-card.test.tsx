/**
 * v1.23 Phase-Q — `<TotpCard>` recovery-code regeneration guard.
 *
 * Regenerating recovery codes is destructive: the previous set stops working
 * immediately. This suite pins that the regenerate action is gated behind a
 * confirmation dialog (matching the disable-MFA pattern), not a bare click.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`); the
 * dialog's open-state behaviour is Radix's own, so we assert the source wires
 * the trigger + consequence copy rather than driving a portal at runtime.
 *
 * ## The refused mutation
 *
 * A refusal used to leave the confirmation up: the confirming click
 * `preventDefault()`s Radix's close so the request can stay in flight behind a
 * disabled button, and nothing took the dialog down again. On success that was
 * invisible — the fresh-codes panel replaces the branch the dialog lives in,
 * so it unmounted anyway — but a refused rotation (or a mistyped code at
 * disable) left an overlay covering the one place the card explains itself.
 *
 * Two halves are pinned below: the sentence a step-up refusal puts on the
 * card, called directly; and the wiring that takes the dialog down when the
 * request settles, read off the source. The second half is structural because
 * the DOM is out of reach here — what a person actually sees, a closed dialog
 * over a visible message, is asserted in `e2e/mfa-step-up-journey.spec.ts`
 * against a real browser.
 *
 * Mutation check: drop either `onSettled` and the wiring case goes red; drop
 * an `open=` binding and the controlled case goes red; return `err.message`
 * from `describeError`'s step-up arm and the sentence case goes red.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/api-fetch";
import { I18nProvider } from "@/lib/i18n/context";
import en from "@/../messages/en.json";
import { describeError, TotpCard } from "../totp-card";

const STEP_UP_SENTENCE = en.settings.security.stepUpRequired;

function render(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

function source(): string {
  return readFileSync(resolve(__dirname, "../totp-card.tsx"), "utf8");
}

describe("<TotpCard> — recovery-code regeneration", () => {
  it("SSRs the enabled card with the regenerate action", () => {
    const html = render(<TotpCard enabled recoveryCodesRemaining={3} />);
    expect(html).toContain("Regenerate codes");
  });

  it("wraps regenerate in a confirmation dialog with a consequence line", () => {
    const src = source();
    // The regenerate action is a dialog trigger, not a bare mutate-on-click.
    expect(src).toContain("settings.security.recovery.regenerateTitle");
    expect(src).toContain("settings.security.recovery.regenerateConfirm");
    // The mutate only fires from inside the dialog's confirm action.
    expect(src).toContain("regenerate.mutate()");
  });
});

describe("<TotpCard> — a refused mutation", () => {
  it("puts the step-up sentence on the card, not the server's prose", () => {
    const refusal = new ApiError(
      "Recent second-factor verification required",
      401,
      { errorCode: "auth.stepup.required" },
    );

    const shown = describeError(refusal, "fallback", STEP_UP_SENTENCE);

    expect(shown).toBe(STEP_UP_SENTENCE);
    expect(shown).not.toContain("second-factor verification required");
  });

  it("closes each confirmation when its request settles", () => {
    const src = source();
    // Whatever the answer was — the refusal is the case that needs it, and a
    // handler that only closed on success would leave the refusal covered.
    expect(src).toContain("onSettled: () => setRegenerateOpen(false)");
    expect(src).toContain("onSettled: () => setDisableOpen(false)");
  });

  it("leaves no confirmation for Radix to close on its own", () => {
    const src = source();
    // Every dialog on this card is controlled, so none of them can be left
    // holding an overlay after a `preventDefault()`ed confirm.
    const dialogs = src.match(/<AlertDialog[\s>]/g);
    const controlled = src.match(/<AlertDialog\s+open=\{/g);
    expect(dialogs).toHaveLength(2);
    expect(controlled).toHaveLength(dialogs?.length ?? 0);
    // And the confirming click still holds the dialog open while the request
    // is in flight — that is what `onSettled` exists to release.
    expect(src).toContain("e.preventDefault()");
  });
});
