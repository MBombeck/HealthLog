/**
 * v1.4.49 — `<MoodReminderCard>` status auto-clear parity.
 *
 * The v1.4.48 W-DISABLE-COACH refactor added a 3 s `setTimeout` to
 * `<DisableCoachCard>` and claimed in the docstring that the pattern
 * mirrored `<MoodReminderCard>`. It did not — the mood-reminder card
 * had no auto-clear. v1.4.49 backfills the parity. This suite pins:
 *
 *   1. The card SSRs cleanly with no in-flight status banner.
 *   2. The component module exposes the auto-clear plumbing
 *      (`scheduleClear` + `clearTimerRef`) so a future refactor can't
 *      silently regress the docstring claim.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`);
 * the actual timer-tick behaviour is verified through manual QA + the
 * shared pattern with `<DisableCoachCard>` which is already audit-grade.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/notifications",
  useSearchParams: () => new URLSearchParams(""),
}));

import { MoodReminderCard } from "../mood-reminder-card";

function render(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <MoodReminderCard isAuthenticated={true} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<MoodReminderCard> — v1.4.49 auto-clear parity", () => {
  it("SSRs the card scaffolding with no in-flight status banner", () => {
    const html = render();
    // The Switch primitive surfaces `data-state="unchecked"` for the
    // default `moodReminderEnabled: false` profile shape.
    expect(html).toContain('data-state="unchecked"');
    // No status message visible by default — the `<p role="status">`
    // line is gated on `msg !== null`.
    expect(html).not.toContain('role="status"');
  });

  it("contains the auto-clear plumbing introduced for v1.4.48 docstring parity", () => {
    // Structural assertion: the source file ships the `scheduleClear`
    // helper + `clearTimerRef` (mirroring `<DisableCoachCard>` from
    // v1.4.48 M2). Reading the file rather than a runtime mount keeps
    // the test deterministic in the SSR-only test environment.
    const src = readFileSync(
      resolve(__dirname, "../mood-reminder-card.tsx"),
      "utf8",
    );
    expect(src).toContain("clearTimerRef");
    expect(src).toContain("scheduleClear");
    // 3 s timeout — must match the `<DisableCoachCard>` value so the
    // two Settings cards age at the same rate.
    expect(src).toMatch(/setTimeout\([^,]+,\s*3000\)/);
    // Cleanup-on-unmount branch — without this a navigate-away during
    // the 3 s window would leave a stray timer pointing at unmounted
    // state.
    expect(src).toContain("clearTimeout(clearTimerRef.current)");
  });
});
