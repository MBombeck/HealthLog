/**
 * The grant card says where the invitation will turn up.
 *
 * A sharing invitation carries no link and nothing is e-mailed: it is
 * addressed to a username or e-mail of an account that already exists here,
 * and the person accepts it from inside their own session (`POST
 * /api/account/grants/[id]/accept`). The card said the first half — the input
 * hint already names the account requirement — and left the second half
 * unsaid, so an inviter who then goes looking for a link to send has nothing
 * to find and no reason to stop looking.
 *
 * SSR-only, per project convention.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "owner", modules: {} },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { GrantInviteCard } from "../grant-invite-card";
import en from "../../../../../messages/en.json";

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <GrantInviteCard />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("grant invite card — the invitee needs an account here", () => {
  it("says where the invited person will find the invitation", () => {
    const markup = render();
    expect(markup).toContain(en.recordSharing.invite.needsAccount);
  });

  it("names Settings → Shared access rather than a link to send", () => {
    expect(en.recordSharing.invite.needsAccount).toMatch(/Settings/);
    expect(en.recordSharing.invite.needsAccount).not.toMatch(/https?:/);
  });
});
