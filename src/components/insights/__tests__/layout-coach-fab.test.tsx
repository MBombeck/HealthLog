import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// SSR test render has no Next.js app-router context; stub the two
// navigation hooks the FAB uses. The pathname is mutable so the
// hide-on-coach-page branch can be exercised.
let mockPathname = "/insights";
// AI surfaces paint only while their capability is available; these tests
// cover the painted surface, so every capability reads available here.
vi.mock("@/hooks/use-ai-capability", () => ({
  useAiCapability: () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => mockPathname,
}));
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachLaunchProvider } from "@/lib/insights/coach-launch-context";

import { isNudgeUnread, LayoutCoachFab } from "../layout-coach-fab";

/**
 * v1.16.8 — the FAB is a permanent launcher on every authenticated
 * page (mounted once in `<AuthShell>`). The v1.16.1 nudge-only bubble
 * folded into it: an unseen proactive `COACH_NUDGE` paints a small
 * unread dot on the button's corner instead of toggling the whole
 * button, and the FAB hides itself on the Coach page.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`).
 * On first paint the nudge-status query has no data, so the dot must
 * be absent while the launcher itself renders; the unread derivation
 * is pinned through the exported pure helper.
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  const client = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<LayoutCoachFab>", () => {
  it("returns nothing when no <CoachLaunchProvider> is mounted", () => {
    mockPathname = "/insights";
    const html = render(<LayoutCoachFab />);
    expect(html).not.toContain('data-slot="coach-fab"');
  });

  it("renders the always-on launcher under the provider (no nudge needed)", () => {
    mockPathname = "/";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).toContain('data-slot="coach-fab"');
    // Accessible name carries the launcher label, not the nudge copy.
    expect(html).toContain('aria-label="Open the Coach"');
    // Fixed bottom-right, above the mobile bottom-nav band. The plain
    // desktop offset kicks in at `md:` — the same breakpoint where the
    // bottom-nav hides (`md:hidden`) — so the FAB never floats mid-air
    // in the 768-1023px band. v1.18.1 (C5) — the corner inset is
    // symmetric: right equals bottom at each breakpoint (`right-6`
    // mobile-band / `md:right-8` desktop mirrors `md:bottom-8`). v1.42 —
    // each offset sits on top of the matching safe-area inset (the notch
    // of a phone held sideways, an installed iPad's home indicator).
    expect(html).toContain(
      "fixed right-[calc(env(safe-area-inset-right,0px)+1.5rem)]",
    );
    expect(html).toContain(
      "md:right-[calc(env(safe-area-inset-right,0px)+2rem)]",
    );
    expect(html).toContain(
      "bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)]",
    );
    // The bottom offset follows the shell, not a width: a phone held
    // sideways keeps the bottom nav, so the FAB keeps clearing it there.
    expect(html).toContain(
      "shell-desktop:bottom-[calc(env(safe-area-inset-bottom,0px)+2rem)]",
    );
    expect(html).toContain('data-keyboard-hide=""');
    expect(html).not.toContain("md:bottom-6");
    expect(html).not.toContain("lg:bottom-6");
  });

  it("paints the on-accent glyph + offset focus ring on the gradient", () => {
    mockPathname = "/";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    // The glyph is decorative (aria-hidden) and the button carries its own
    // accessible name, so the text-contrast rule does not gate it; the glyph
    // shares the button's own on-accent token (text-background) rather than a
    // harsh pure white, so it reads as a softer mark on the gradient.
    expect(html).not.toContain("text-white");
    expect(html).toMatch(/lucide-sparkles[^"]*text-background/);
    // The offset ring draws a visible halo around the gradient circle and
    // provides the non-text UI-component contrast against the page.
    expect(html).toContain("focus-visible:ring-offset-2");
    expect(html).toContain("focus-visible:ring-offset-background");
  });

  it("carries a polite live region for the unread-nudge announcement", () => {
    mockPathname = "/";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    // The swapped aria-label is not announced on mutation; the sr-only
    // sibling emits the nudge copy once on the unread rising edge. It
    // must be mounted (and empty) BEFORE a nudge arrives so the live
    // region is registered with the accessibility tree.
    const live = html.match(/<span[^>]*data-slot="coach-fab-live"[^>]*>/)?.[0];
    expect(live).toBeTruthy();
    expect(live).toContain('aria-live="polite"');
    expect(live).toContain("sr-only");
  });

  it("paints no unread dot on first paint (no nudge-status data yet)", () => {
    mockPathname = "/";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).not.toContain('data-slot="coach-fab-unread"');
    expect(html).not.toContain('data-unread="true"');
  });

  it("hides itself on the Coach page", () => {
    mockPathname = "/coach";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).not.toContain('data-slot="coach-fab"');
  });

  it("yields to the data-list selection bar via the :has() gate", () => {
    mockPathname = "/measurements";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    // The selection bar's delete action lands in the same lower-right
    // band; the FAB carries a CSS gate keyed off the bar's data-slot.
    expect(html).toContain("selection-action-bar");
    // The gate must include `invisible` — `opacity-0` alone left the
    // hidden button focusable and operable: a keyboard user could tab
    // onto an unseeable control and trigger a navigation. (The `&` is
    // HTML-escaped in static markup.)
    expect(html).toContain(
      "[body:has([data-slot=selection-action-bar])_&amp;]:invisible",
    );
    expect(html).toContain(
      "[body:has([data-slot=selection-action-bar])_&amp;]:pointer-events-none",
    );
  });

  it("yields to the onboarding tour overlay with the same robust gate", () => {
    mockPathname = "/";
    const html = render(
      <CoachLaunchProvider>
        <LayoutCoachFab />
      </CoachLaunchProvider>,
    );
    expect(html).toContain(
      "[body:has([data-testid=onboarding-tour])_&amp;]:invisible",
    );
    expect(html).toContain(
      "[body:has([data-testid=onboarding-tour])_&amp;]:pointer-events-none",
    );
  });
});

describe("isNudgeUnread", () => {
  const nudgedAt = "2026-06-09T05:15:00.000Z";

  it("is false without status or without a nudge", () => {
    expect(isNudgeUnread(undefined, null)).toBe(false);
    expect(
      isNudgeUnread(
        { nudgedAt: null, unread: false, conversationId: null },
        null,
      ),
    ).toBe(false);
  });

  it("is true for a server-unread nudge the device has not seen", () => {
    expect(
      isNudgeUnread({ nudgedAt, unread: true, conversationId: "conv-1" }, null),
    ).toBe(true);
    expect(
      isNudgeUnread(
        { nudgedAt, unread: true, conversationId: "conv-1" },
        "2026-01-01",
      ),
    ).toBe(true);
  });

  it("is false once the server counts the nudge as read", () => {
    // The user sent a Coach message after the nudge.
    expect(
      isNudgeUnread(
        { nudgedAt, unread: false, conversationId: "conv-1" },
        null,
      ),
    ).toBe(false);
  });

  it("is false once this device stored the matching seen stamp", () => {
    expect(
      isNudgeUnread(
        { nudgedAt, unread: true, conversationId: "conv-1" },
        nudgedAt,
      ),
    ).toBe(false);
  });
});
