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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
const mockAuthLoadingRef = { value: false };
const mockAccountAccessStatusRef = {
  value: "valid" as "absent" | "valid" | "invalid",
};
const mockRecordSessionPhaseRef = {
  value: "ready" as "ready" | "blocking" | "resolving",
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
      accountAccessStatus: mockAccountAccessStatusRef.value,
    },
    isAuthenticated: true,
    isAuthUnknown: false,
    isLoading: mockAuthLoadingRef.value,
    refetch: vi.fn(),
  }),
  clearCachesForSessionEnd: vi.fn(),
}));

vi.mock("@/hooks/use-record-session-transition", () => ({
  useRecordSessionTransition: () => ({
    id: "cross-tab-switch",
    phase: mockRecordSessionPhaseRef.value,
    expectedScope: "record-a",
  }),
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
import { delegatedDomains } from "@/lib/sharing/domain-write-support";

const OWNER_READ: AccountAccessEntry = {
  accountId: "acct-owner",
  username: "grandma",
  displayName: "Margarethe",
  fullName: null,
  access: "read" as const,
  level: "read" as const,
  sections: null,
  recordKind: "shared" as const,
  canWrite: false,
  writableDomains: [],
  manageableDomains: [],
};
const OWNER_WRITE: AccountAccessEntry = {
  ...OWNER_READ,
  access: "write",
  level: "write",
  canWrite: true,
  writableDomains: [],
  manageableDomains: [],
};
const MANAGED_GUARDIAN: AccountAccessEntry = {
  accountId: "managed-record",
  username: "managed-record",
  displayName: "Managed profile",
  fullName: null,
  access: "write" as const,
  level: "manage" as const,
  sections: null,
  recordKind: "managed" as const,
  canWrite: true,
  writableDomains: delegatedDomains("manage", null, "write"),
  manageableDomains: delegatedDomains("manage", null, "manage"),
};

function render(
  access: AccountAccess,
  pathname = "/",
  accountAccessStatus: "absent" | "valid" | "invalid" = "valid",
): string {
  mockAccessRef.value = access;
  mockPathRef.value = pathname;
  mockAccountAccessStatusRef.value = accountAccessStatus;
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
  it("holds protected children until record capabilities resolve", () => {
    mockAuthLoadingRef.value = true;
    try {
      const html = render(OWN_RECORD, "/medications");

      expect(html).toContain('data-slot="record-scope-hydration-gate"');
      expect(html).not.toContain("sentinel-page");
      expect(html).not.toContain("sentinel-coach-fab");
    } finally {
      mockAuthLoadingRef.value = false;
    }
  });

  it("holds protected children and owner-only doors while a peer tab changes the session", () => {
    mockRecordSessionPhaseRef.value = "blocking";
    try {
      const html = render(OWN_RECORD, "/labs");

      expect(html).toContain('data-slot="record-scope-hydration-gate"');
      expect(html).not.toContain("sentinel-page");
      for (const slot of DOORS) {
        expect(html).not.toContain(slot);
      }
    } finally {
      mockRecordSessionPhaseRef.value = "ready";
    }
  });

  it("does not delay public routes for record capability resolution", () => {
    mockAuthLoadingRef.value = true;
    try {
      const html = render(OWN_RECORD, "/auth/login");

      expect(html).toContain("sentinel-page");
      expect(html).not.toContain('data-slot="record-scope-hydration-gate"');
    } finally {
      mockAuthLoadingRef.value = false;
    }
  });

  it("mounts all three in the caller's own record", () => {
    // The half that makes the rest mean something. Without it, a shell that
    // had simply dropped the Coach and the tour for everybody would satisfy
    // every assertion below.
    const html = render(OWN_RECORD);
    for (const slot of DOORS) {
      expect(html, `${slot} must exist in one's own record`).toContain(slot);
    }
  });

  it("refuses an invalid record block without mounting owner-only doors or children", () => {
    const html = render(OWN_RECORD, "/", "invalid");

    expect(html).toContain("sentinel-unavailable");
    expect(html).not.toContain("sentinel-page");
    for (const slot of DOORS) {
      expect(html, `${slot} must not paint for a refused record`).not.toContain(
        slot,
      );
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

  it("admits a switched Guardian to the record-aware Settings gate", () => {
    const html = render(SWITCHED(MANAGED_GUARDIAN), "/settings/integrations");

    expect(html).toContain("sentinel-page");
    expect(html).not.toContain("sentinel-unavailable");
  });
});

/**
 * v1.37.0 — a refusal must never render behind the hydration gate.
 *
 * The two branches look interchangeable and are not. `RecordScopeHydrationGate`
 * is a bare spinner with no controls, which is correct for a transition that
 * ends on its own. A refusal does not end on its own — `/api/auth/me` reports
 * the same disagreement on every boot — so behind the gate it renders as a
 * permanent "Loading…" with no way out, which is what an audit found on the
 * grant-expiry path.
 *
 * Asserted on source order rather than by rendering, because the shell's
 * branches are early returns: whichever `if` comes first wins, and that is
 * exactly the fact worth freezing. Break it by moving the `accessRefused`
 * block back below the gate.
 */
describe("the refusal door is reachable", () => {
  const SHELL = readFileSync(
    join(process.cwd(), "src/components/layout/auth-shell.tsx"),
    "utf8",
  );

  it("checks accessRefused before the hydration gate", () => {
    const refusal = SHELL.indexOf("if (accessRefused) {");
    const gate = SHELL.indexOf("<RecordScopeHydrationGate");
    // Non-zero proof: a renamed branch must fail here rather than agree with
    // two -1s.
    expect(refusal).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(gate);
  });

  it("gives the refusal door an actual way out", () => {
    // A door with no handle is the same wedge wearing different paint.
    const door = readFileSync(
      join(
        process.cwd(),
        "src/components/layout/shared-record-unavailable.tsx",
      ),
      "utf8",
    );
    expect(door).toContain("shared-record-unavailable-leave");
    expect(door).toMatch(/switchAccount\.mutate\(null\)/);
  });
});
