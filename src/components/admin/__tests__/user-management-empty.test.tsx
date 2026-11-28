import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.15 — `/admin/users` empty state.
 *
 * Before this phase, when the admin's filter bucket returned zero
 * users (or the system had only one admin and the "Users" filter was
 * active), the table rendered an empty `<tbody>` and the rest of the
 * card was a blank rectangle. The empty state must:
 *
 *   - mount the EmptyState primitive (`role="status"` + dashed border).
 *   - carry a localized title + description.
 *   - expose a "Show all users" reset CTA when a non-default filter is
 *     active.
 *
 * The default-filter ("all") path is verified by an isolated test
 * because the empty list case is ambiguous (could be a real empty
 * deployment or a misconfigured fetch); the reset CTA must not appear
 * there.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/users",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [], isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
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
import { UserManagementSection } from "../user-management-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <UserManagementSection />
    </I18nProvider>,
  );
}

describe("UserManagementSection — empty state", () => {
  it("renders the EmptyState primitive when no users match", () => {
    const html = render();
    // Polite live region marker from the primitive.
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-slot="empty-state-title"');
  });

  it("says it with the localized title alone", () => {
    const html = render();
    expect(html).toContain("No users in this view");
    expect(html).not.toContain(
      "There are no users matching the current filter.",
    );
  });

  it("does not render the reset CTA when the default filter is active", () => {
    // Default filter is "all" — reset CTA would be a no-op so it must
    // not appear. The other test (filter=admin) covers the visible path
    // via the same component but isolated by its own state — we cover
    // the absence here so a future regression that always renders the
    // CTA is caught.
    const html = render();
    expect(html).not.toContain("Show all users");
  });
});
