import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.15: the `/admin` overview no longer renders the
 * `StatusCardGrid` (the section-card grid the maintainer described as redundant
 * with the sidebar nav). The status-card component itself was removed
 * from the codebase. This test guards the *new* overview composition:
 * the version tile, the system snapshot, and the recent-audit preview. The
 * welcome card went with the grid: it greeted the reader and told them they
 * were signed in as an administrator, on a route only an administrator can
 * reach.
 *
 * The file kept its old name so git history follows it. Nothing else
 * imports `status-card-grid`.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: null,
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
import AdminOverviewPage from "@/app/admin/page";
import { SystemStatusSummary } from "../system-status-summary";
import { RecentAuditPreview } from "../recent-audit-preview";

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("/admin overview composition", () => {
  it("does NOT render the legacy section-card grid", () => {
    const html = render(<AdminOverviewPage />);
    // The old grid surfaced six card titles ("Users", "Integrations",
    // "Monitoring", "Backups", "Maintenance", "Audit log") in headings.
    // The redesigned overview must not paint that grid anymore.
    expect(html).not.toContain(">Maintenance<");
    // "Monitoring" is a rail entry now (the former Integrations page), so
    // the check is on a card heading, not on the word.
    expect(html).not.toMatch(/<h[1-4][^>]*>Monitoring</);
    // No "Manage users"/"Open backups" CTAs from the StatusCard CTAs.
    expect(html).not.toContain("Manage users");
    expect(html).not.toContain("Open backups");
  });

  it("renders no welcome card", () => {
    const html = render(<AdminOverviewPage />);
    expect(html).not.toContain("Welcome, testuser");
    expect(html).not.toContain("admin-overview-welcome-heading");
  });

  it("renders the system snapshot section heading", () => {
    const html = render(<SystemStatusSummary />);
    expect(html).toContain("System snapshot");
    expect(html).toContain("admin-overview-snapshot-heading");
  });

  it("renders the recent-activity section with a 'View all' link", () => {
    const html = render(<RecentAuditPreview />);
    expect(html).toContain("Recent activity");
    expect(html).toContain("admin-overview-audit-heading");
    expect(html).toContain('href="/admin/login-overview"');
    expect(html).toContain("View all");
  });
});
