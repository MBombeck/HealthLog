import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * `/settings/api`: one table of tokens that fits a phone without
 * horizontal scroll, the access as one chip, and the API address once.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/api",
  useSearchParams: () => new URLSearchParams(),
}));

const sampleTokens = [
  {
    id: "tok-active",
    name: "iOS app",
    permissions: ["medication:ingest"],
    lastUsedAt: "2026-05-08T12:00:00Z",
    expiresAt: null,
    createdAt: "2026-05-01T08:00:00Z",
    revoked: false,
  },
  {
    id: "tok-revoked",
    name: "Old laptop",
    permissions: ["measurements:write"],
    lastUsedAt: null,
    expiresAt: null,
    createdAt: "2026-04-20T08:00:00Z",
    revoked: true,
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: sampleTokens,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "testuser",
      email: "user@example.com",
      role: "USER",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ApiSection } from "../api-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ApiSection />
    </I18nProvider>,
  );
}

describe("ApiSection — one token table", () => {
  it("is one semantic table, with no horizontal scroll at phone width", () => {
    const html = render();
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).toContain('data-testid="settings-api-tokens-table"');
    expect(html).not.toContain("overflow-x-auto");
    // The token name is the row's header cell.
    expect(html).toMatch(/<th scope="row"[^>]*><span[^>]*>iOS app<\/span>/);
  });

  it("shows the access as one short chip, never the raw scope list", () => {
    const html = render();
    expect(html).toContain('data-slot="tag-chip"');
    expect(html).toContain(">Medication<");
    expect(html).not.toContain("medication:ingest");
  });

  it("folds the two date columns into one meta line on a phone", () => {
    const html = render();
    // Created and last used are columns from md up …
    expect(html).toMatch(/<td class="[^"]*hidden[^"]*md:table-cell/);
    // … and the name cell carries the last-used line below md.
    expect(html).toMatch(/<span class="[^"]*md:hidden[^"]*">/);
  });

  it("keeps revoked tokens out of the table until asked", () => {
    const html = render();
    expect(html).not.toContain("Old laptop");
    expect(html).toContain('data-testid="settings-api-tokens-show-revoked"');
  });

  it("states the API address once, with a copy button", () => {
    const html = render();
    expect(html.match(/data-testid="api-address"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="api-address-copy"');
    expect(html).toContain("/reference/api-endpoints/");
  });
});
