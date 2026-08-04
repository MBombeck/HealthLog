/**
 * The shell-level doors, under a switch.
 *
 * Three surfaces hang off `<AuthShell>` rather than off a route, so they paint
 * on every page the shell serves and on the unavailable panel too — the panel
 * whose entire message is that a page is not part of what was shared. All
 * three are owner-only:
 *
 *   - the Coach FAB, whose drawer carries chat, conversation rename and
 *     delete, attachments, feedback, an adopt action and suggested actions,
 *     every one of them resolving `requireAuth()` and refusing under a switch —
 *     and which fires `POST /api/insights/coach/seen` on being opened at all;
 *   - the drawer mount behind it;
 *   - the module tour, which `POST`s `/api/onboarding/tour`.
 *
 * The nav dropped Insights and Coach under a switch on purpose. These were the
 * doors left standing beside the removed entries.
 *
 * Rendered, not grepped. The shell is mounted through `renderToStaticMarkup`
 * with the three doors replaced by sentinels, so what is asserted is the paint
 * — which of them the shell put on the page — rather than the shape of a JSX
 * condition. The chrome around them is stubbed for the same reason: this file
 * is about the mount decision and nothing else.
 *
 * SSR-only, per project convention: `@testing-library/react` is not a
 * dependency, effects do not run, and no click is available here. That is
 * enough for this property, which is purely what renders. The click paths
 * behind these doors are driven in `e2e/account-sharing.spec.ts`.
 *
 * Mutation checks, run:
 *   - drop `!inSharedRecord` from the FAB mount → "mounts none of them under a
 *     read grant" and its write sibling both go red, naming the FAB sentinel
 *     they found in the markup.
 *   - drop it from the tour mount, or from `<LayoutCoachMount />` → the same
 *     two cases go red naming that sentinel instead.
 *   - make `resolveRecordCapabilities` return `inSharedRecord: false` always →
 *     all three go red at once, while "mounts all three in the caller's own
 *     record" stays green, which is how the pair distinguishes "gated" from
 *     "removed".
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type {
  AccountAccess,
  AccountAccessEntry,
} from "@/lib/sharing/account-access-view";

const mockAccessRef: { value: AccountAccess } = {
  value: { accounts: [], active: null, canSwitch: false },
};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "delegate",
      username: "delegate",
      email: null,
      role: "USER",
      avatarUrl: null,
      modules: {},
      accountAccess: mockAccessRef.value,
    },
    isAuthenticated: true,
    isAuthUnknown: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  clearCachesForSessionEnd: vi.fn(),
}));

const mockPathRef = { value: "/" };

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathRef.value,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// The three doors under test, reduced to sentinels: this file asserts whether
// the shell mounted them, not what they would have rendered.
vi.mock("@/components/insights/layout-coach-fab", () => ({
  LayoutCoachFab: () => <div data-slot="sentinel-coach-fab" />,
}));
vi.mock("@/components/insights/layout-coach-mount", () => ({
  LayoutCoachMount: () => <div data-slot="sentinel-coach-mount" />,
}));
vi.mock("@/components/onboarding/tour-launcher", () => ({
  TourLauncher: () => <div data-slot="sentinel-tour-launcher" />,
}));

// Chrome that is not the subject. Each pulls its own query cells and portals;
// rendering them here would measure the renderer, not the mount decision.
vi.mock("../sidebar-nav", () => ({ SidebarNav: () => null }));
vi.mock("../bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("../top-bar", () => ({ TopBar: () => null }));
vi.mock("../offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("../demo-banner", () => ({ DemoBanner: () => null }));
vi.mock("../shared-record-banner", () => ({ SharedRecordBanner: () => null }));
vi.mock("../shared-record-unavailable", () => ({
  SharedRecordUnavailable: () => <div data-slot="sentinel-unavailable" />,
}));
vi.mock("@/components/i18n/maintainership-banner", () => ({
  MaintainershipBanner: () => null,
}));
vi.mock("@/components/gamification/achievement-unlock-notifier", () => ({
  AchievementUnlockNotifier: () => null,
}));

import { AuthShell } from "../auth-shell";

const OWNER_READ: AccountAccessEntry = {
  accountId: "acct-owner",
  username: "grandma",
  displayName: "Margarethe",
  access: "read" as const,
  level: "read" as const,
  sections: null,
  canWrite: false,
};
const OWNER_WRITE: AccountAccessEntry = {
  ...OWNER_READ,
  access: "write",
  level: "write",
  canWrite: true,
};

function render(access: AccountAccess, pathname = "/"): string {
  mockAccessRef.value = access;
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

const OWN_RECORD: AccountAccess = {
  accounts: [],
  active: null,
  canSwitch: false,
};
const SWITCHED = (entry: AccountAccessEntry): AccountAccess => ({
  accounts: [entry],
  active: entry,
  canSwitch: true,
});

const DOORS = [
  "sentinel-coach-fab",
  "sentinel-coach-mount",
  "sentinel-tour-launcher",
] as const;

describe("<AuthShell> — the owner-only doors", () => {
  it("mounts all three in the caller's own record", () => {
    // The half that makes the rest mean something. Without it, a shell that
    // had simply dropped the Coach and the tour for everybody would satisfy
    // every assertion below.
    const html = render(OWN_RECORD);
    for (const slot of DOORS) {
      expect(html, `${slot} must exist in one's own record`).toContain(slot);
    }
  });

  it.each([
    ["read", OWNER_READ],
    ["write", OWNER_WRITE],
  ])("mounts none of them under a %s grant", (_level, entry) => {
    // Both levels, because the grant level is not the question. A WRITE grant
    // admits a short list of health-record creates and nothing about the
    // account around the record — the Coach and the tour are outside it either
    // way.
    const html = render(SWITCHED(entry));
    for (const slot of DOORS) {
      expect(html, `${slot} must not paint under a switch`).not.toContain(slot);
    }
    // And the page itself still renders: the doors went, the record did not.
    expect(html).toContain("sentinel-page");
  });

  it("mounts none of them over the unavailable panel either", () => {
    // The panel says a page is not part of what was shared. A floating Coach
    // launcher on top of that sentence is the product contradicting itself in
    // one viewport.
    const html = render(SWITCHED(OWNER_READ), "/settings");
    // First prove this render actually reached the panel. Without this line
    // the case is indistinguishable from the previous one and would stay green
    // if `outsideSharedRecord` stopped resolving at all.
    expect(html).toContain("sentinel-unavailable");
    expect(html).not.toContain("sentinel-page");
    for (const slot of DOORS) {
      expect(html).not.toContain(slot);
    }
  });
});
