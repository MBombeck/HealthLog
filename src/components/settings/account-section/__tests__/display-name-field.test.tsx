/**
 * The display name can be changed after the setup flow.
 *
 * The setup flow asks for the name the greeting and the reports use, and the
 * profile route has always accepted `displayName` — but no settings surface
 * offered it, and `/api/auth/me` did not even publish it, so a name chosen on
 * the first day was the name for good. The profile card now carries the
 * field, seeded from the account payload, and sends it with the save.
 *
 * Both ends are pinned: the route publishes the field (read from its response
 * literal, the way `account-payload-consumer-guard` reads it), and the card
 * renders it seeded and posts it.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let displayName: string | null = "Sam";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/account",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

vi.mock("@/hooks/use-auth", () => ({
  isFullAccount: (user: { accountSeed?: true } | null) =>
    user !== null && user.accountSeed !== true,
  useAuth: () => ({
    user: {
      id: "u1",
      username: "testuser",
      displayName,
      email: "user@example.com",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      role: "USER",
      unitPreference: "metric",
    },
    isAuthenticated: true,
    profileLoaded: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { AccountSection } from "@/components/settings/account-section";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AccountSection />
    </I18nProvider>,
  );
}

/** The `<input id="display-name" …>` tag, or null. */
function displayNameInput(html: string): string | null {
  return /<input[^>]*id="display-name"[^>]*>/.exec(html)?.[0] ?? null;
}

describe("display name on the profile card", () => {
  it("renders the field seeded with the stored name", () => {
    displayName = "Sam";
    const input = displayNameInput(render());
    expect(input).not.toBeNull();
    expect(input).toContain('value="Sam"');
  });

  it("renders it empty for an account that never set one", () => {
    displayName = null;
    const input = displayNameInput(render());
    expect(input).not.toBeNull();
    expect(input).toContain('value=""');
  });

  it("sends the field with the profile save", () => {
    const source = readFileSync(resolve(__dirname, "../index.tsx"), "utf8");
    expect(source).toMatch(
      /displayName:\s*savedProfile\.displayName\s*\|\|\s*null/,
    );
  });

  it("is published on the account payload the card seeds from", () => {
    const route = readFileSync(
      join(process.cwd(), "src/lib/auth/me-payload.ts"),
      "utf8",
    );
    expect(route).toMatch(/\bdisplayName:\s*user\.displayName\s*\?\?\s*null/);
  });
});
