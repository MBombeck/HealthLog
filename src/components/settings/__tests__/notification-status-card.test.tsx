/**
 * <NotificationStatusCard /> SSR smoke (v1.4.15).
 *
 * The card is wrapped in TanStack Query, but each test below mocks
 * `useQuery` to return a specific channel-state shape so the static
 * markup snapshot tells us:
 *   1. The right state badge is painted (Active / Auto-disabled / etc).
 *   2. "Re-enable" only renders for `auto_disabled`.
 *   3. The reason line shows up next to the badge for auto-disabled
 *      channels (so users know WHY their channel went silent).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => {
  const useQueryMock = vi.fn();
  return {
    __esModule: true,
    useQuery: useQueryMock,
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
      setQueryData: vi.fn(),
    }),
    __useQueryMock: useQueryMock,
  };
});

import * as ReactQuery from "@tanstack/react-query";
const useQueryMock = (
  ReactQuery as unknown as { __useQueryMock: ReturnType<typeof vi.fn> }
).__useQueryMock;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

// The card gates its auth/loading branches behind `useMounted()` so SSR and
// the first client paint render identically (`null`) and avoid a React #418
// hydration mismatch. These tests assert the POST-hydration content tree, so
// pin the probe to `true` — the state the card reaches once hydrated.
vi.mock("@/hooks/use-mounted", () => ({
  useMounted: () => true,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { NotificationStatusCard } from "../notification-status-card";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de");

function render(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

interface MockChannel {
  id: string;
  type: "TELEGRAM" | "NTFY" | "WEB_PUSH";
  label: string;
  enabled: boolean;
  state: "active" | "auto_disabled" | "manually_disabled" | "sending_paused";
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  nextRetryAt: string | null;
}

function setChannels(channels: MockChannel[]) {
  useQueryMock.mockReturnValue({ data: channels, isLoading: false });
}

describe("<NotificationStatusCard />", () => {
  it("renders nothing when no channels exist", () => {
    // The channel cards right below are where one is set up.
    setChannels([]);
    const html = render(<NotificationStatusCard />);
    expect(html).toBe("");
  });

  it("renders nothing instead of crashing when data is not an array", () => {
    // Regression: the status endpoint returns `{ channels, events }` where
    // `events` is an object map. A shape-drifted / poisoned cache read that
    // hands the whole object to the card must not reach `.map` on a
    // non-array and white-screen the notifications panel.
    useQueryMock.mockReturnValue({
      data: { channels: [], events: {} } as unknown as MockChannel[],
      isLoading: false,
    });
    const html = render(<NotificationStatusCard />);
    expect(html).toBe("");
  });

  it("paints the Active chip for a healthy channel", () => {
    setChannels([
      {
        id: "ch-1",
        type: "WEB_PUSH",
        label: "Web Push",
        enabled: true,
        state: "active",
        disabledReason: null,
        consecutiveFailures: 0,
        lastSuccessAt: "2026-05-09T10:00:00.000Z",
        lastFailureAt: null,
        lastFailureReason: null,
        nextRetryAt: null,
      },
    ]);
    const html = render(<NotificationStatusCard />);
    expect(html).toMatch(
      /data-testid="notification-status-row-WEB_PUSH"[^>]*data-state="active"/,
    );
    expect(html).toContain(">Active</span>");
    // No "Re-enable" button when the channel is healthy.
    expect(html).not.toContain('data-testid="re-enable-WEB_PUSH"');
  });

  it("paints the Error chip + Re-enable button + reason for an auto-disabled channel", () => {
    setChannels([
      {
        id: "ch-2",
        type: "WEB_PUSH",
        label: "Web Push",
        enabled: false,
        state: "auto_disabled",
        disabledReason: "web_push_410_gone",
        consecutiveFailures: 1,
        lastSuccessAt: null,
        lastFailureAt: "2026-05-09T11:00:00.000Z",
        lastFailureReason: "web_push_410_gone",
        nextRetryAt: null,
      },
    ]);
    const html = render(<NotificationStatusCard />);
    expect(html).toContain('data-state="auto_disabled"');
    expect(html).toContain(">Error</span>");
    expect(html).toContain('data-testid="re-enable-WEB_PUSH"');
    expect(html).toContain("web_push_410_gone");
    // Send-test must be present but disabled (the channel is dead until re-enabled).
    // React renders attributes in source order — `disabled` comes before
    // `data-testid` because we wrote the JSX prop that way.
    expect(html).toMatch(/disabled[^>]*data-testid="send-test-WEB_PUSH"/);
  });

  it("paints the Error chip when nextRetryAt is in the future", () => {
    setChannels([
      {
        id: "ch-3",
        type: "NTFY",
        label: "ntfy",
        enabled: true,
        state: "sending_paused",
        disabledReason: null,
        consecutiveFailures: 2,
        lastSuccessAt: null,
        lastFailureAt: "2026-05-09T11:00:00.000Z",
        lastFailureReason: "ntfy_503",
        nextRetryAt: "2026-05-09T11:05:00.000Z",
      },
    ]);
    const html = render(<NotificationStatusCard />);
    expect(html).toContain('data-state="sending_paused"');
    expect(html).toContain(">Error</span>");
    expect(html).toContain('data-testid="next-retry"');
    // No re-enable button — the channel is still enabled, just cooling down.
    expect(html).not.toContain('data-testid="re-enable-NTFY"');
  });

  it("paints the Off chip when the user toggled enabled=false themselves", () => {
    setChannels([
      {
        id: "ch-4",
        type: "TELEGRAM",
        label: "Telegram",
        enabled: false,
        state: "manually_disabled",
        disabledReason: null,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        nextRetryAt: null,
      },
    ]);
    const html = render(<NotificationStatusCard />);
    expect(html).toContain('data-state="manually_disabled"');
    expect(html).toContain(">Off</span>");
    // Manually-disabled does NOT get the Re-enable button (only
    // auto-disabled does — manual disable is reversed via the
    // channel's own "Enabled" switch in the per-channel card).
    expect(html).not.toContain('data-testid="re-enable-TELEGRAM"');
  });

  it("renders DE labels under German locale", () => {
    setChannels([
      {
        id: "ch-5",
        type: "WEB_PUSH",
        label: "Web Push",
        enabled: false,
        state: "auto_disabled",
        disabledReason: "web_push_410_gone",
        consecutiveFailures: 5,
        lastSuccessAt: null,
        lastFailureAt: "2026-05-09T11:00:00.000Z",
        lastFailureReason: "web_push_410_gone",
        nextRetryAt: null,
      },
    ]);
    const html = render(<NotificationStatusCard />, "de");
    expect(html).toContain("Zustellstatus");
    expect(html).toContain(">Fehler</span>");
    expect(html).toContain("Wieder aktivieren");
  });
});
