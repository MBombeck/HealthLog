/**
 * v1.5.5 F-1 H-1 — pin the split title ids on the notifications row.
 *
 * The earlier single `TITLE_ID` constant landed on both the section
 * heading (`<MedicationDetailSection titleId={…}>`) and the inner
 * `<span>` carrying the switch's `aria-labelledby`, producing a
 * duplicate-id axe failure. The fix splits the two ids: the section
 * heading carries `*-heading`, the inner row label carries
 * `*-row-label`, and the switch's `aria-labelledby` points at the
 * row label.
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

describe("<NotificationsSection> — split title ids (F-1 H-1)", () => {
  it("renders the section heading and the row label with distinct ids", () => {
    const client = makeClient();
    const html = render(
      <NotificationsSection
        medicationId="med-1"
        notificationsEnabled={true}
      />,
      client,
    );

    // Section heading + row label sit on different DOM nodes so axe
    // duplicate-id passes. The §10 invariant 4 row-as-hit-target also
    // needs the row label to be the aria-labelledby target.
    expect(html).toContain('id="medication-detail-notifications-heading"');
    expect(html).toContain('id="medication-detail-notifications-row-label"');
    expect(html).not.toContain('id="medication-detail-notifications-title"');

    // The switch reaches the row label, not the section heading.
    expect(html).toContain(
      'aria-labelledby="medication-detail-notifications-row-label"',
    );
  });
});
