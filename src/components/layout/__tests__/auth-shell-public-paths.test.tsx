/**
 * The edge gate and the client gate must agree about which PAGES are public.
 *
 * `src/proxy.ts` decides whether a request reaches the app at all;
 * `auth-shell.tsx` decides whether the mounted shell treats the pathname as
 * public or as a protected route that needs `/api/auth/me`. The two lists are
 * maintained by hand, and when they drift the visitor pays: Next streams the
 * shell before an RSC redirect resolves, so a route the edge admits but the
 * shell classifies as protected renders the protected branch and fires
 * `router.replace("/auth/login")` against the redirect. That is exactly what
 * happened to `/invite/<token>` — public in `proxy.ts` since v1.17.0, never
 * added here, and the operator's invite link landed on the login page.
 *
 * So this file does not pin one route. It parameterises over every PAGE prefix
 * the proxy admits and asserts the shell paints the page for each, which makes
 * the drift itself the thing under test rather than the one instance of it.
 *
 * SSR-only, per project convention (node environment, no DOM, no
 * `@testing-library/react`): effects never run here, so the assertion is the
 * PAINT. On a public path the shell hands the child through; on a protected
 * path with auth resolved as unauthenticated it paints the redirect spinner
 * instead and the child never appears. The production evidence for the defect
 * was the same signal read off a `curl` — `record-scope-hydration-gate` in the
 * body of `GET /invite/<token>`.
 *
 * Mutation check, run: remove `"/invite/"` from the shell's `PUBLIC_PATHS` →
 * the `/invite/` case goes red with the child sentinel missing, every other
 * case stays green.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

const mockPathRef = { value: "/" };

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathRef.value,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    isAuthUnknown: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  clearCachesForSessionEnd: vi.fn(),
}));

vi.mock("@/hooks/use-record-session-transition", () => ({
  useRecordSessionTransition: () => ({
    id: "none",
    phase: "ready",
    expectedScope: null,
  }),
}));

// Chrome that is not the subject — each pulls its own query cells and portals.
vi.mock("../sidebar-nav", () => ({ SidebarNav: () => null }));
vi.mock("../bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("../top-bar", () => ({ TopBar: () => null }));
vi.mock("../offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("../demo-banner", () => ({ DemoBanner: () => null }));
vi.mock("../shared-record-banner", () => ({ SharedRecordBanner: () => null }));
vi.mock("../shared-record-unavailable", () => ({
  SharedRecordUnavailable: () => null,
}));
vi.mock("@/components/i18n/maintainership-banner", () => ({
  MaintainershipBanner: () => null,
}));
vi.mock("@/components/gamification/achievement-unlock-notifier", () => ({
  AchievementUnlockNotifier: () => null,
}));
vi.mock("@/components/insights/layout-coach-fab", () => ({
  LayoutCoachFab: () => null,
}));
vi.mock("@/components/insights/layout-coach-mount", () => ({
  LayoutCoachMount: () => null,
}));
vi.mock("@/components/onboarding/tour-launcher", () => ({
  TourLauncher: () => null,
}));

import { AuthShell } from "../auth-shell";
// The proxy's list is the source of truth for what the edge lets through.
import { PUBLIC_PATHS as PROXY_PUBLIC_PATHS } from "@/proxy";

/**
 * Prefixes the proxy admits that are NOT pages — route handlers with no
 * React tree, so `<AuthShell>` never mounts on them and has nothing to say
 * about them. Named explicitly rather than pattern-matched: a new non-page
 * public prefix should turn this file red once, so its author classifies it
 * here deliberately instead of a regex swallowing a real page.
 */
const NON_PAGE_PREFIXES = new Set([
  "/i18n/", // locale-catalog boot script
  "/robots.txt", // static text route
]);

const PAGE_PREFIXES = PROXY_PUBLIC_PATHS.filter(
  (p) =>
    !p.startsWith("/api/") &&
    !p.startsWith("/.well-known") &&
    !NON_PAGE_PREFIXES.has(p),
);

function render(pathname: string): string {
  mockPathRef.value = pathname;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <AuthShell>
          <div data-slot="sentinel-page" />
        </AuthShell>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/**
 * A representative pathname under a prefix. A trailing-slash prefix admits
 * EVERY path beneath it at the edge, so the sample is a segment that no
 * narrower shell entry could be covering by accident — otherwise the guard
 * would pass on the one page that happens to exist there today and miss the
 * next one.
 */
function sampleFor(prefix: string): string {
  return prefix.endsWith("/") ? `${prefix}probe` : prefix;
}

describe("AuthShell public paths agree with proxy.ts", () => {
  it("has page prefixes to check at all", () => {
    expect(PAGE_PREFIXES.length).toBeGreaterThan(0);
    expect(PAGE_PREFIXES).toContain("/invite/");
  });

  it.each(PAGE_PREFIXES)(
    "renders the page for %s instead of the sign-in gate",
    (prefix) => {
      const markup = render(sampleFor(prefix));
      expect(markup).toContain('data-slot="sentinel-page"');
    },
  );

  it("renders the invite landing for a real token path", () => {
    // The instance of the class: the operator's link, byte for byte.
    const markup = render(`/invite/hlv_${"a".repeat(64)}`);
    expect(markup).toContain('data-slot="sentinel-page"');
  });

  it("still gates a protected route", () => {
    // Negative check — confirms the fixture would catch a real regression.
    const markup = render("/insights");
    expect(markup).not.toContain('data-slot="sentinel-page"');
  });
});
