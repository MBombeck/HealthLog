/**
 * <NotificationStatusCard /> SSR smoke (v1.4.15 Phase B3).
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

import { I18nProvider } from "@/lib/i18n/context";
import { NotificationStatusCard } from "../notification-status-card";

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
  it("renders empty state when no channels exist", () => {
    setChannels([]);
    const html = render(<NotificationStatusCard />);
    expect(html).toContain("Delivery status");
    expect(html).toContain("No channels configured yet");
    expect(html).not.toContain('data-testid="notification-status-list"');
  });

  it("paints Active badge for a healthy channel", () => {
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

  it("paints Auto-disabled badge + Re-enable button + reason for an auto-disabled channel", () => {
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
    expect(html).toContain(">Auto-disabled</span>");
    expect(html).toContain('data-testid="re-enable-WEB_PUSH"');
    expect(html).toContain("web_push_410_gone");
    // Send-test must be present but disabled (the channel is dead until re-enabled).
    // React renders attributes in source order — `disabled` comes before
    // `data-testid` because we wrote the JSX prop that way.
    expect(html).toMatch(/disabled[^>]*data-testid="send-test-WEB_PUSH"/);
  });

  it("paints Sending paused badge when nextRetryAt is in the future", () => {
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
    expect(html).toContain(">Sending paused</span>");
    expect(html).toContain('data-testid="next-retry"');
    // No re-enable button — the channel is still enabled, just cooling down.
    expect(html).not.toContain('data-testid="re-enable-NTFY"');
  });

  it("paints Manually-disabled badge when the user toggled enabled=false themselves", () => {
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
    expect(html).toContain(">Disabled</span>");
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
    expect(html).toContain("Automatisch deaktiviert");
    expect(html).toContain("Wieder aktivieren");
  });
});
