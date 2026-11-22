/**
 * Pin how the notifications switch is named.
 *
 * A single title id once landed on both the section heading and the row's
 * name, producing a duplicate-id axe failure and announcing the heading as
 * the switch's name. The heading carries `*-heading`; the switch is named by
 * the row's own label, bound to it with `for`, and points at nothing else.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { NotificationsSection } from "@/components/medications/sections/notifications-section";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "test-user", username: "tester", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY,
        refetchOnMount: false,
      },
    },
  });
}

function render(node: React.ReactNode, client: QueryClient) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<NotificationsSection> — the switch's name", () => {
  it("names the switch by its row label, not the section heading", () => {
    const client = makeClient();
    const html = render(
      <NotificationsSection medicationId="med-1" notificationsEnabled={true} />,
      client,
    );

    expect(html).toContain('id="medication-detail-notifications-heading"');
    expect(html).not.toContain('id="medication-detail-notifications-title"');
    expect(html).toContain('for="medication-detail-notifications-switch"');
    expect(html).toContain('id="medication-detail-notifications-switch"');
    expect(html).toContain('data-slot="medication-notifications-switch"');
    const switchTag = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0];
    expect(switchTag).toBeDefined();
    expect(switchTag).not.toContain("aria-labelledby");
  });
});
