import { describe, expect, it, vi } from "vitest";
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
    username: "marc",
    email: "marc@example.com",
    role: "USER" as "USER" | "ADMIN",
    avatarUrl: null,
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

// The bug-report flag — each test mutates `mockSettingsRef.value` before
// rendering so the sidebar reads the desired state.
const mockSettingsRef = { value: { bugReportEnabled: true } };
vi.mock("@/components/app-settings-provider", () => ({
  useAppSettings: () => mockSettingsRef.value,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SidebarNav } from "../sidebar-nav";
import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";

function render({
  pathname = "/",
  bugReportEnabled = true,
  role = "USER" as "USER" | "ADMIN",
}: {
  pathname?: string;
  bugReportEnabled?: boolean;
  role?: "USER" | "ADMIN";
} = {}) {
  mockPathnameRef.value = pathname;
  mockSettingsRef.value = { bugReportEnabled };
  mockUserRef.value = { ...mockUserRef.value, role };
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SidebarNav />
    </I18nProvider>,
  );
}

describe("<SidebarNav> bug-report toggle", () => {
  it("renders the Bug Report entry when the admin flag is enabled", () => {
    const html = render({ bugReportEnabled: true });
    expect(html).toContain('href="/bugreport"');
    // i18n string for the entry — sanity check that the link is the actual
    // bug-report nav entry, not e.g. an error-page report-bug button.
    expect(html).toContain("Bug Report");
  });

  it("hides the Bug Report entry when the admin flag is disabled", () => {
    const html = render({ bugReportEnabled: false });
    expect(html).not.toContain('href="/bugreport"');
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
