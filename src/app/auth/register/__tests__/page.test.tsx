/**
 * An invitation opened from inside a live session.
 *
 * `POST /api/auth/register` refuses that with 409 `already_authenticated`
 * (see `src/app/api/auth/register/__tests__/route.test.ts`). The page must not
 * make the visitor discover it by filling the form: a signed-in caller gets an
 * explanation and a way out instead of three inputs that cannot succeed.
 *
 * SSR-only, per project convention (node environment, no DOM, no
 * `@testing-library/react`), so what is asserted is the PAINT — which branch
 * the page rendered. The sign-out click itself is driven in
 * `e2e/invite-registration.spec.ts`.
 *
 * Mutation check, run: drop the `isAuthenticated` branch → the two signed-in
 * cases go red naming the form inputs they found, the anonymous case stays
 * green.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

const authRef = {
  value: {
    user: null as { username: string } | null,
    isAuthenticated: false,
    isLoading: false,
  },
};
const inviteRef = { value: null as string | null };

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => ({
    get: (key: string) => (key === "invite" ? inviteRef.value : null),
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authRef.value,
  clearCachesForSessionEnd: vi.fn(),
}));

import RegisterPage from "../page";

const TOKEN = `hlv_${"a".repeat(64)}`;

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <RegisterPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function anonymous(invite: string | null): string {
  authRef.value = { user: null, isAuthenticated: false, isLoading: false };
  inviteRef.value = invite;
  return render();
}

function signedIn(invite: string | null, username = "marc"): string {
  authRef.value = {
    user: { username },
    isAuthenticated: true,
    isLoading: false,
  };
  inviteRef.value = invite;
  return render();
}

describe("register page — an invitation cannot be accepted from a live session", () => {
  it("renders the form for an anonymous visitor holding an invitation", () => {
    const markup = anonymous(TOKEN);
    expect(markup).toContain('data-testid="register-invite-banner"');
    expect(markup).toContain('id="username"');
    expect(markup).not.toContain('data-testid="register-already-signed-in"');
  });

  it("replaces the form with the explaining panel for a signed-in visitor", () => {
    const markup = signedIn(TOKEN);
    expect(markup).toContain('data-testid="register-already-signed-in"');
    expect(markup).not.toContain('id="username"');
    expect(markup).not.toContain('id="password"');
  });

  it("names the account the visitor is signed in as", () => {
    const markup = signedIn(TOKEN, "grandma");
    expect(markup).toContain("grandma");
  });

  it("offers the way out", () => {
    const markup = signedIn(TOKEN);
    expect(markup).toContain('data-testid="register-sign-out"');
  });

  it("explains the same thing without an invitation in the URL", () => {
    // Reaching /auth/register signed in is the same dead end with or without
    // a token — the form below could only ever answer 409.
    const markup = signedIn(null);
    expect(markup).toContain('data-testid="register-already-signed-in"');
  });

  it("holds the panel back while the session question is unanswered", () => {
    // Fail closed the other way round: an unresolved `/api/auth/me` must not
    // flash "you are already signed in" at somebody who is not.
    authRef.value = { user: null, isAuthenticated: false, isLoading: true };
    inviteRef.value = TOKEN;
    const markup = render();
    expect(markup).not.toContain('data-testid="register-already-signed-in"');
  });
});
