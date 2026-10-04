import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// `<SidebarNav>` reads the active route from `usePathname()`. Stub
// next/navigation so the SSR test render works without an App-Router
// runtime.
const mockPathnameRef = { value: "/" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathnameRef.value,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Each test mutates `mockUserRef.value.role` before rendering so we can
// exercise both regular-user and admin layouts from the same suite.
const mockUserRef = {
  value: {
    id: "u1",
    username: "testuser",
    email: "user@example.com",
    role: "USER" as "USER" | "ADMIN",
    avatarUrl: null,
    // v1.18.0 — nav gating reads the resolved per-user module map; cycle is
    // the delegated `cycle` key on it (no bespoke boolean). An absent key
    // fails open (entry shows), matching the gate's default-on contract.
    modules: {} as Record<string, boolean>,
  },
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mockUserRef.value,
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useLogout: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/providers", () => ({
  useTheme: () => ({
    theme: "system" as const,
    resolvedTheme: "dark" as const,
    setTheme: vi.fn(),
  }),
}));

// Every suite but the collapsed-rail one renders the pre-hydration paint, where
// `useMounted()` is false. The collapsed-rail suite flips this to render the
// post-mount shell, which is the only state the stored preference applies in.
const mockMountedRef = { value: false };
vi.mock("@/hooks/use-mounted", () => ({
  useMounted: () => mockMountedRef.value,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@/lib/i18n/context";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SIDEBAR_EXPANDED_CONTENT_WIDTH,
  SidebarCollapseToggle,
  SidebarNav,
  readSidebarCollapsedPref,
  writeSidebarCollapsedPref,
} from "../sidebar-nav";
import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import { visibleUtilityDestinations } from "../nav-model";
import { delegatedDomains } from "@/lib/sharing/domain-write-support";

function render({
  pathname = "/",
  role = "USER" as "USER" | "ADMIN",
  modules = {} as Record<string, boolean>,
}: {
  pathname?: string;
  role?: "USER" | "ADMIN";
  modules?: Record<string, boolean>;
} = {}) {
  mockPathnameRef.value = pathname;
  mockUserRef.value = { ...mockUserRef.value, role, modules };
  return renderToStaticMarkup(
    // The nav reads `useQueryClient()` for the medications intent
    // prefetch (v1.16.7); a fresh client per render keeps the SSR
    // markup assertions isolated.
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">
        <SidebarNav />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// v1.25.12 — these suites render the FIRST-PAINT (pre-hydration) markup.
// `renderToStaticMarkup` drives `useMounted()` to its server snapshot
// (`false`), so the sidebar applies its fail-CLOSED gate: only CORE
// (non-module-gated) destinations render and EVERY module-gated entry is
// absent regardless of the module map. This is the fix for the disabled-
// module flicker — a gated entry can no longer paint for one frame before the
// `/api/auth/me` query resolves. The resolved, post-mount visible set
// ("cycle shows when its module is on", "a disabled module drops out") is the
// pure `visibleNavDestinations(modules, true)` contract verified in
// `nav-model.test.ts`; the mounted render is exercised in e2e.

// CORE destinations have no owner in the surface map and always render.
// `/insights` is one of them: the `insights` key is AI analysis only.
const CORE_HREFS = ["/", "/measurements", "/checkups", "/insights"] as const;
// A representative slice of the module-gated entries that must stay out of
// the first-paint markup whatever the module map says.
const GATED_HREFS = [
  "/mood",
  "/cycle",
  "/medications",
  "/labs",
  "/illness",
  "/coach",
  "/achievements",
] as const;

describe("<SidebarNav> first-paint fail-closed module gate (v1.25.12)", () => {
  it("renders core destinations on first paint regardless of the module map", () => {
    const maps: Record<string, boolean>[] = [
      {},
      { cycle: true, mood: true, labs: true, coach: true },
      { cycle: false, mood: false },
    ];
    for (const modules of maps) {
      const html = render({ modules });
      for (const href of CORE_HREFS) {
        expect(html).toContain(`href="${href}"`);
      }
    }
  });

  it("keeps every module-gated entry OUT of the first-paint markup, even when its module is enabled", () => {
    // The flicker bug: a gated entry painted before the module query
    // resolved. Pre-mount it must be absent even with the module turned on.
    const html = render({
      modules: {
        cycle: true,
        mood: true,
        labs: true,
        coach: true,
        achievements: true,
        insights: true,
      },
    });
    for (const href of GATED_HREFS) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("keeps gated entries out when the module map is empty (no fail-open flicker)", () => {
    const html = render({ modules: {} });
    for (const href of GATED_HREFS) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("keeps gated entries out when the module is explicitly disabled", () => {
    const html = render({
      modules: { mood: false, labs: false, coach: false, achievements: false },
    });
    for (const href of GATED_HREFS) {
      expect(html).not.toContain(`href="${href}"`);
    }
  });

  it("does not render the deprecated /insights/workouts sub-link", () => {
    const html = render();
    expect(html).not.toContain('href="/insights/workouts"');
  });
});

describe("<SidebarNav> targets deprecation (v1.8.6)", () => {
  it("no longer renders the deprecated /targets entry", () => {
    // The Targets (Zielwerte) page is deprecated; target editing moved
    // inline into Insights, so the sidebar drops the entry. Assert absence
    // against a stable CORE sibling that renders on first paint
    // (Measurements stays; Insights is module-gated and pre-mount absent).
    const html = render();
    expect(html).not.toContain('href="/targets"');
    expect(html).toContain('href="/measurements"');
  });
});

describe("<SidebarNav> shared utility tail (v1.17.1 N-1 parity guard)", () => {
  // The footer renders the shared utility tail EXCEPT Notifications, which
  // lives in the avatar dropdown (a Radix menu that is collapsed — and so
  // not in the SSR markup — until opened). The footer-visible utilities are
  // therefore the shared list minus `/notifications`. Asserting they all
  // render straight from the shared list is the parity net that keeps the
  // sidebar footer from drifting away from the mobile More-hub tail.
  const footerUtilities = () =>
    visibleUtilityDestinations().filter((d) => d.href !== "/notifications");

  it("renders every footer utility destination straight from the shared list", () => {
    const html = render();
    for (const dest of footerUtilities()) {
      expect(html).toContain(`href="${dest.href}"`);
    }
    // Settings is the footer utility entry; it is present.
    expect(html).toContain('href="/settings/account"');
  });
});

describe("<SidebarNav> admin entry mirrors Settings (no sub-item expansion)", () => {
  // v1.4.16 A1: the maintainer reported the global sidebar expanding admin
  // sub-items on `/admin/*` was unwanted UX — the in-shell `<AdminShell>`
  // already provides per-section nav inside the page. The Admin entry
  // must behave EXACTLY like the Settings entry: a single link with no
  // sub-list at any route, regardless of where the avatar dropdown is.

  it("does not render admin entries at all for a regular user", () => {
    const html = render({ role: "USER", pathname: "/admin/system-status" });
    expect(html).not.toContain('href="/admin"');
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("for an admin off /admin/* shows a single Admin link without sub-items", () => {
    const html = render({ role: "ADMIN", pathname: "/" });
    expect(html).toContain('href="/admin"');
    // No sub-route links — sidebar collapses into a single Admin entry.
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("for an admin on /admin/* still shows ONLY the single Admin link (no sub-list)", () => {
    const html = render({ role: "ADMIN", pathname: "/admin/system-status" });
    expect(html).toContain('href="/admin"');
    // Sub-section links must NOT appear in the global sidebar — they
    // belong to `<AdminShell>`'s in-page nav. the maintainer reported the
    // expansion as broken UX in v1.4.16; this guard keeps it gone.
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("on the /admin overview page also shows ONLY the single Admin link", () => {
    const html = render({ role: "ADMIN", pathname: "/admin" });
    expect(html).toContain('href="/admin"');
    for (const section of ADMIN_SECTIONS) {
      expect(html).not.toContain(`href="/admin/${section.slug}"`);
    }
  });

  it("Admin entry markup mirrors Settings entry markup (same shape, no expansion)", () => {
    // Both Settings and Admin should render as a single <a> with no
    // adjacent <ul> sub-list. Counting <ul aria-label="Admin sections"
    // (or any descendant ul under the Admin link) confirms there's no
    // disclosure widget. We assert by checking the structural pattern:
    // the Admin link is followed by the Settings link (or the user
    // section), never by a <ul>.
    const html = render({ role: "ADMIN", pathname: "/admin/system-status" });
    // No sub-list <ul> on /admin/*: previously this was the
    // `aria-label={t("admin.shell.sectionsNav")}` ul; assert the only
    // Settings-bearing nav surface is intact (sectionsNav label belongs
    // to `<AdminShell>`, which the sidebar must NOT echo).
    expect(html).not.toMatch(/aria-label="Admin sections"/);
  });
});

describe("<SidebarNav> inside somebody else's record (#939)", () => {
  /**
   * A self-hoster looking after a managed profile could not find Settings
   * anywhere after switching into it, although the Settings shell lists the
   * profile's own configuration there. The footer entry is back wherever the
   * shell has pages for the record, and points at the first of them; the
   * identity block stays a plain block, because it names the person at the
   * keyboard and must not open somebody else's settings under that name.
   *
   * Mutation checks, run:
   *   - `FooterIdentity` always rendering the link → all three switched cases
   *     go red: the managed case on the account-settings label, the adult
   *     MANAGE and READ cases on the identity link's `/settings/account` href;
   *   - the empty tail restored for shared records in
   *     `visibleUtilityDestinations` → both MANAGE cases go red on the missing
   *     Settings link, while the READ case stays green.
   */
  const accountSettingsLabel = (
    JSON.parse(
      readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
    ) as { nav: { accountSettings: string } }
  ).nav.accountSettings;

  function renderInRecord(
    active: {
      recordKind: "managed" | "shared";
      level: "read" | "write" | "manage";
    } | null,
  ) {
    const user = mockUserRef.value as typeof mockUserRef.value & {
      accountAccess?: unknown;
    };
    user.accountAccess = active
      ? {
          accounts: [],
          canSwitch: true,
          active: {
            accountId: "record-1",
            username: "record",
            displayName: null,
            fullName: null,
            recordKind: active.recordKind,
            level: active.level,
            accessLevel: active.level === "read" ? "read" : "write",
            canWrite: active.level !== "read",
            sections: null,
            writableDomains: [],
            manageableDomains: delegatedDomains(active.level, null, "manage"),
          },
        }
      : undefined;
    try {
      return render();
    } finally {
      // `render()` replaces `mockUserRef.value` with a copy, so the grant
      // has to come off the copy too or it leaks into later suites.
      delete user.accountAccess;
      delete (mockUserRef.value as typeof user).accountAccess;
    }
  }

  const settingsLinks = (html: string) =>
    [...html.matchAll(/<a\b[^>]*data-slot="nav-settings-link"[^>]*>/g)].map(
      (match) => /href="([^"]+)"/.exec(match[0])?.[1],
    );

  it("keeps the account settings door in one's own record", () => {
    const html = renderInRecord(null);
    expect(settingsLinks(html)).toEqual(["/settings/account"]);
    expect(html).toContain(`aria-label="${accountSettingsLabel}"`);
  });

  it("offers Settings inside a managed profile and keeps the identity block a plain block", () => {
    const html = renderInRecord({ recordKind: "managed", level: "manage" });
    expect(settingsLinks(html)).toEqual(["/settings/account"]);
    expect(html).not.toContain(`aria-label="${accountSettingsLabel}"`);
    expect(html).not.toContain('href="/notifications"');
  });

  it("lands an adult MANAGE share on the one Settings page it opens", () => {
    const html = renderInRecord({ recordKind: "shared", level: "manage" });
    expect(settingsLinks(html)).toEqual(["/settings/anamnesis"]);
    expect(html).not.toContain('href="/settings/account"');
  });

  it("offers no Settings entry to a READ share", () => {
    const html = renderInRecord({ recordKind: "shared", level: "read" });
    // Non-zero proof that the sidebar rendered at all.
    expect(html).toContain('href="/measurements"');
    expect(settingsLinks(html)).toEqual([]);
    expect(html).not.toContain('href="/settings/');
  });
});

describe("<SidebarNav> collapse control sits at the bottom, above the footer entries", () => {
  /**
   * The control used to be a small chevron above the first nav entry. It is
   * now a full footer row heading the utility group: directly above Admin for
   * an administrator, directly above Settings for everyone else.
   *
   * Mutation checks, run:
   *   - rendering `<SidebarCollapseToggle>` after `renderAdminLink()` → the
   *     admin ordering case goes red;
   *   - moving it back into the `<nav>` above the first entry → both ordering
   *     cases go red on the main-nav bound;
   *   - dropping `sr-only` from the collapsed label → the rail case goes red.
   */
  const TOGGLE = 'data-slot="sidebar-collapse-toggle"';
  const SETTINGS = 'data-slot="nav-settings-link"';

  it("renders exactly one collapse control", () => {
    const html = render();
    expect(html.split(TOGGLE)).toHaveLength(2);
  });

  it("sits after the main navigation and directly above Admin, then Settings, for an administrator", () => {
    const html = render({ role: "ADMIN" });
    const navEnd = html.indexOf("</nav>");
    const toggle = html.indexOf(TOGGLE);
    const admin = html.indexOf('href="/admin"');
    const settings = html.indexOf(SETTINGS);
    expect(navEnd).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(navEnd);
    expect(admin).toBeGreaterThan(toggle);
    expect(settings).toBeGreaterThan(admin);
    // Nothing else links in between: the only anchor opened between the
    // control and the Admin href is the Admin link itself.
    expect(html.slice(toggle, admin).split("<a ")).toHaveLength(2);
  });

  it("sits directly above Settings when there is no Admin entry", () => {
    const html = render({ role: "USER" });
    const navEnd = html.indexOf("</nav>");
    const toggle = html.indexOf(TOGGLE);
    const settings = html.indexOf(SETTINGS);
    expect(toggle).toBeGreaterThan(navEnd);
    expect(settings).toBeGreaterThan(toggle);
    expect(html.slice(toggle, settings).split("<a ")).toHaveLength(2);
  });

  it("shows a visible Collapse label with the sidebar expanded", () => {
    const html = render();
    const button =
      /<button[^>]*data-slot="sidebar-collapse-toggle"[^>]*>.*?<\/button>/.exec(
        html,
      )?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('aria-label="Collapse sidebar"');
    expect(button).toContain('aria-expanded="true"');
    expect(button).toContain("<span>Collapse</span>");
    expect(button).not.toContain("sr-only");
  });

  function renderToggle(collapsed: boolean) {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TooltipProvider>
          <SidebarCollapseToggle collapsed={collapsed} onToggle={() => {}} />
        </TooltipProvider>
      </I18nProvider>,
    );
  }

  it("switches its labels and keeps the text for screen readers only in the rail", () => {
    const html = renderToggle(true);
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<span class="sr-only">Expand</span>');
    expect(html).toContain('type="button"');
  });

  it("draws a different icon per state", () => {
    const icon = (html: string) => /lucide-(panel-left-[a-z]+)/.exec(html)?.[1];
    expect(icon(renderToggle(false))).toBe("panel-left-close");
    expect(icon(renderToggle(true))).toBe("panel-left-open");
  });
});

describe("<SidebarNav> collapse preference persistence", () => {
  const KEY = "healthlog-sidebar-collapsed";

  function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    return store;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    mockMountedRef.value = false;
  });

  it("keeps the existing storage key, so a stored choice survives the move", () => {
    const store = stubStorage();
    writeSidebarCollapsedPref(true);
    expect(store.get(KEY)).toBe("true");
    expect(readSidebarCollapsedPref()).toBe(true);
    writeSidebarCollapsedPref(false);
    expect(store.get(KEY)).toBe("false");
    expect(readSidebarCollapsedPref()).toBe(false);
  });

  it("reads no choice as null, so the viewport default decides", () => {
    stubStorage();
    expect(readSidebarCollapsedPref()).toBeNull();
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readSidebarCollapsedPref()).toBeNull();
    expect(() => writeSidebarCollapsedPref(true)).not.toThrow();
  });

  it("renders the rail with the stored collapsed choice once mounted", () => {
    stubStorage({ [KEY]: "true" });
    mockMountedRef.value = true;
    const html = render({ role: "ADMIN" });
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).toContain('<span class="sr-only">Expand</span>');
    // Still at the bottom, above Admin, in the rail.
    const toggle = html.indexOf('data-slot="sidebar-collapse-toggle"');
    expect(toggle).toBeGreaterThan(html.indexOf("</nav>"));
    expect(html.indexOf('href="/admin"')).toBeGreaterThan(toggle);
  });
});

/**
 * The rail animates `width` between `w-16` and `w-64`. Expanding used to lay
 * the labels out against the growing width: multi-word labels wrapped, the
 * rows overran the nav, and its `overflow-y-auto` painted a vertical and a
 * horizontal scrollbar for the length of the transition. The content now
 * lays out at its final width from the first frame and the rail clips it, so
 * nothing inside can overflow a scroll container while the width moves.
 */
describe("<SidebarNav> width transition never overflows the nav", () => {
  const KEY = "healthlog-sidebar-collapsed";

  afterEach(() => {
    vi.unstubAllGlobals();
    mockMountedRef.value = false;
  });

  function asideClass(html: string): string {
    return /<aside[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
  }
  function columnClass(html: string): string {
    return (
      /data-slot="sidebar-column"[^>]*class="([^"]*)"|class="([^"]*)"[^>]*data-slot="sidebar-column"/
        .exec(html)
        ?.slice(1)
        .find(Boolean) ?? ""
    );
  }

  it("clips the content to the animating rail", () => {
    const aside = asideClass(render());
    expect(aside).toContain("transition-[width]");
    expect(aside.split(" ")).toContain("overflow-hidden");
  });

  it("lays the expanded column out at the expanded rail's content width", () => {
    const column = columnClass(render());
    expect(column.split(" ")).toContain(SIDEBAR_EXPANDED_CONTENT_WIDTH);
    // `w-64` minus the rail's 1 px `border-r`: a wider floor would push the
    // right padding under the clip, a narrower one would let the labels
    // re-flow while the width grows.
    expect(SIDEBAR_EXPANDED_CONTENT_WIDTH).toBe("min-w-[calc(16rem-1px)]");
    expect(asideClass(render()).split(" ")).toContain("border-r");
  });

  it("drops the floor on the collapsed rail, so the icons follow the narrowing width", () => {
    const store = new Map([[KEY, "true"]]);
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    mockMountedRef.value = true;
    const html = render();
    expect(asideClass(html).split(" ")).toContain("w-16");
    expect(columnClass(html).split(" ")).not.toContain(
      SIDEBAR_EXPANDED_CONTENT_WIDTH,
    );
  });
});
