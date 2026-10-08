import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * A claim link that no longer works still leaves the page with a way on:
 * the card offers the sign-in page instead of ending in a dead end.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null }),
  clearCachesForSessionEnd: () => {},
}));
vi.mock("@/lib/queries/use-profile-claim", () => ({
  useProfileClaimPreview: () => ({ data: undefined, error: null }),
  useClaimProfile: () => ({ mutate: () => {}, isPending: false }),
}));

import { ClaimProfile } from "../claim-profile";

describe("ClaimProfile — invalid link", () => {
  it("offers the sign-in page", () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider initialLocale="en">
          <ClaimProfile token={null} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(html).toContain('data-testid="claim-invalid"');
    expect(html).toMatch(
      /data-slot="claim-to-login"[^>]*href="\/auth\/login"|href="\/auth\/login"[^>]*data-slot="claim-to-login"/,
    );
  });
});
