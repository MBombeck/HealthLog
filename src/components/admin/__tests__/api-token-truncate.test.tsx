import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.19 — `/admin/api-tokens` 4th-attempt scrollbar fix.
 *
 * The maintainer reported a "minimaler Scrollbar" still painting at the
 * bottom-right of the api-tokens page, even after the v1.4.18 phase
 * A2 mobile-strip `no-scrollbar` fix. The remaining culprits are
 * inside the section card itself: long token names, long usernames,
 * and long permission strings can each push their parent past the
 * viewport. Cumulatively this leaves the page in an "almost-fits"
 * state where the visible scrollbar the maintainer sees is the page-level main
 * scroll picking up a fraction of pixels of horizontal scroll spill
 * from the children.
 *
 * The fix is aggressive: every cell that could carry a long string
 * gets `truncate` (overflow-hidden + text-ellipsis + whitespace-nowrap)
 * AND a popover on a tap so the full value is still
 * discoverable. This is the same pattern UserManagementSection uses
 * — apply it consistently here.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/api-tokens",
}));

const sampleTokens = [
  {
    id: "tok1",
    name: "iOS auto-login 2026-05-05T19:42:11Z device-AABBCCDDEEFF",
    permissions: ["measurements:write", "medications:read", "*"],
    lastUsedAt: "2026-05-08T12:00:00Z",
    expiresAt: null,
    createdAt: "2026-05-01T08:00:00Z",
    revoked: false,
    user: {
      id: "u1",
      username: "user-the-very-long-username-that-overflows",
    },
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
      role: "ADMIN",
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ApiTokenOverviewSection } from "../api-token-overview-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ApiTokenOverviewSection />
    </I18nProvider>,
  );
}

describe("ApiTokenOverviewSection — truncate + popover", () => {
  it("mobile token-name span does NOT carry the contradictory `break-all` modifier", () => {
    // `truncate` already sets `white-space: nowrap`, which beats
    // `word-break: break-all` per CSS spec — `break-all` was dead
    // code AND it is misleading: a future reader expects the long
    // name to break onto multiple lines, when in fact it stays on a
    // single ellipsised line. Strip the conflicting class.
    const html = render();
    const mobileMatch = html.match(/<ul[^>]*md:hidden[^>]*>([\s\S]*?)<\/ul>/);
    expect(mobileMatch).not.toBeNull();
    expect(mobileMatch![1]).not.toMatch(/\btruncate\b[^"]*\bbreak-all\b/);
  });

  it("desktop token-name and user cells truncate inside max-width wrappers so a long string cannot push the row past the viewport", () => {
    const html = render();
    // Desktop table block is `hidden md:block`. Its rows render at
    // server-side render unconditionally (the visibility is purely
    // CSS), so we can grep for the cell contents in the SSR output.
    const desktopMatch = html.match(
      /<div[^>]*\bhidden\b[^>]*md:block[^>]*>([\s\S]*?)<\/table>/,
    );
    expect(desktopMatch).not.toBeNull();
    const desktop = desktopMatch![1];
    // Token name and username cells must each carry the truncate
    // modifier with a bounded max-width so they cannot expand the
    // row past the available column width on any viewport.
    expect(desktop).toMatch(/\btruncate\b/);
    expect(desktop).toMatch(/\bmax-w-/);
  });

  it("permission badges carry max-width + truncate so a single long permission string cannot blow up the cell", () => {
    const html = render();
    // Even with `flex-wrap`, a single permission like
    // "measurements:write:audit:legacy:..." can be wider than the
    // card on mobile. Badge primitive already has `overflow-hidden`,
    // we add an upper bound on width so it ellipsises instead of
    // pushing the parent.
    expect(html).toMatch(
      /<span[^>]*max-w-(?:\[[^\]]+\]|full)[^>]*\btruncate\b/,
    );
  });

  it("makes each truncated cell a button that opens the full value on a tap", () => {
    const html = render();
    // A hover tooltip never opens on a phone; the popover trigger does.
    expect(html).toMatch(
      /<button type="button"[^>]*data-slot="popover-trigger"[^>]*\btruncate\b/,
    );
  });
});
