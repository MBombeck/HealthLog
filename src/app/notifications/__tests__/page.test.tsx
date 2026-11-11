import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * Notification-matrix page contract (QoL/UX audit 2026-07-08):
 *   - H2: the "no channels" CTA points at Settings → Integrations#channels,
 *     the surface that can actually add a channel (not the reminder-types
 *     screen, which no longer configures channels since v1.25.7).
 *   - M3: a failed load renders the shared `QueryErrorCard` with a Retry,
 *     never a bare alert box; the loading frame reserves a skeleton.
 *   - L1: the globally-disabled hint reads as a full sentence, not the bare
 *     "(Disabled)" inline tag.
 *   - M7: the page cross-links the other two notification surfaces.
 */

type AuthState = { isAuthenticated: boolean; isLoading: boolean };
type QueryState = {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
};

let authState: AuthState = { isAuthenticated: true, isLoading: false };
let queryState: QueryState = {
  data: undefined,
  isLoading: false,
  isError: false,
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authState,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ ...queryState, refetch: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

import NotificationsPage from "../page";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <NotificationsPage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  authState = { isAuthenticated: true, isLoading: false };
  queryState = { data: undefined, isLoading: false, isError: false };
});

describe("NotificationsPage", () => {
  it("M3: renders a skeleton while loading, not a lone spinner", () => {
    queryState.isLoading = true;
    const html = render();
    expect(html).toContain('data-slot="notifications-loading"');
    expect(html).not.toContain("animate-spin");
  });

  it("M3: renders the shared QueryErrorCard with a retry on load failure", () => {
    queryState.isError = true;
    const html = render();
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain("Notification preferences could not be loaded.");
  });

  it("H2 + L4: the no-channels CTA targets Settings → Integrations#channels", () => {
    queryState.data = { channels: [], preferences: [], eventTypes: [] };
    const html = render();
    expect(html).toContain('href="/settings/integrations#channels"');
    // The reminder-types screen no longer configures channels — never point there.
    expect(html).not.toContain('href="/settings/notifications"><');
    expect(html).toContain("Settings → Integrations");
  });

  it("M7: the matrix cross-links the reminder-types + channels surfaces", () => {
    queryState.data = {
      channels: [
        {
          id: "c1",
          type: "telegram",
          label: "Telegram",
          enabled: true,
          globallyEnabled: true,
        },
      ],
      preferences: [],
      eventTypes: ["MEDICATION_REMINDER"],
    };
    const html = render();
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain('href="/settings/integrations#channels"');
  });

  it("L1: the globally-disabled hint is a full sentence, not the bare tag", () => {
    queryState.data = {
      channels: [
        {
          id: "c1",
          type: "telegram",
          label: "Telegram",
          enabled: true,
          globallyEnabled: true,
        },
        {
          id: "c2",
          type: "ntfy",
          label: "ntfy",
          enabled: true,
          globallyEnabled: false,
        },
      ],
      preferences: [],
      eventTypes: ["MEDICATION_REMINDER"],
    };
    const html = render();
    expect(html).toContain("won’t receive notifications");
  });

  it("a switch without a stored row shows the server's default for this account", () => {
    // The mood reminder is delivered when the reminder card is on, with no
    // per-channel row. The constant table says OFF for it, so a matrix that
    // read the table showed the switch off while the reminder kept arriving.
    // The page renders what the server resolved, row-less events included.
    queryState.data = {
      channels: [
        {
          id: "c1",
          type: "TELEGRAM",
          label: "Telegram",
          enabled: true,
          globallyEnabled: true,
        },
      ],
      preferences: [],
      eventTypes: ["MOOD_REMINDER", "DAILY_BRIEFING"],
      eventDefaults: { MOOD_REMINDER: true, DAILY_BRIEFING: false },
    };
    const html = render();
    const state = (label: string) =>
      new RegExp(
        `aria-label="${label} - Telegram"[^>]*data-state="(checked|unchecked)"|data-state="(checked|unchecked)"[^>]*aria-label="${label} - Telegram"`,
      ).exec(html);
    const mood = state("Mood reminder");
    const briefing = state("Daily briefing");
    expect(mood, "mood switch rendered").not.toBeNull();
    expect(mood?.[1] ?? mood?.[2]).toBe("checked");
    expect(briefing?.[1] ?? briefing?.[2]).toBe("unchecked");
  });

  it("a stored row still wins over the default", () => {
    queryState.data = {
      channels: [
        {
          id: "c1",
          type: "TELEGRAM",
          label: "Telegram",
          enabled: true,
          globallyEnabled: true,
        },
      ],
      preferences: [
        { channelId: "c1", eventType: "MOOD_REMINDER", enabled: false },
      ],
      eventTypes: ["MOOD_REMINDER"],
      eventDefaults: { MOOD_REMINDER: true },
    };
    const html = render();
    expect(html).toMatch(
      /aria-label="Mood reminder - Telegram"[^>]*data-state="unchecked"|data-state="unchecked"[^>]*aria-label="Mood reminder - Telegram"/,
    );
  });
});
