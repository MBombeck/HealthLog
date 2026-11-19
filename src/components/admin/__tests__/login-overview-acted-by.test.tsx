import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * #1403 — a row a guardian wrote inside a managed profile is filed under the
 * profile. The viewer names the profile in the user column and, under it,
 * the account that acted; a self-action shows no second line.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/login-overview",
}));

const ENTRIES = [
  {
    id: "a1",
    action: "documents.inbound.store",
    ipAddress: null,
    location: null,
    asn: null,
    carrier: null,
    details: null,
    createdAt: "2026-11-19T10:00:00.000Z",
    user: { id: "p1", username: "managed-1" },
    actor: { id: "g1", username: "parent" },
  },
  {
    id: "a2",
    action: "auth.login",
    ipAddress: null,
    location: null,
    asn: null,
    carrier: null,
    details: null,
    createdAt: "2026-11-19T09:00:00.000Z",
    user: { id: "u1", username: "self-only" },
    actor: null,
  },
  {
    id: "a3",
    action: "documents.inbound.discard",
    ipAddress: null,
    location: null,
    asn: null,
    carrier: null,
    details: null,
    createdAt: "2026-11-19T08:00:00.000Z",
    user: { id: "p1", username: "managed-1" },
    actor: { id: "g2", username: null },
  },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const isActions = JSON.stringify(queryKey).includes("actions");
    return {
      data: isActions
        ? { actions: [] }
        : {
            entries: ENTRIES,
            meta: { total: 3, limit: 50, offset: 0, page: 1, perPage: 50 },
          },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "admin", username: "admin", role: "ADMIN" },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LoginOverviewSection } from "../login-overview-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <LoginOverviewSection />
    </I18nProvider>,
  );
}

describe("LoginOverviewSection — acting account", () => {
  it("shows who acted under the record, and nothing for a self-action", () => {
    const html = render();
    const actedBy = [
      ...html.matchAll(/data-slot="audit-acted-by"[^>]*>([^<]*)</g),
    ].map((m) => m[1]);
    expect(actedBy).toEqual(["by parent", "by a deleted account"]);
    expect(html).toContain("managed-1");
    expect(html).toContain("self-only");
  });
});
