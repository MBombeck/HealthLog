import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * v1.4.15 — `/measurements` empty state.
 *
 * Before this phase the list rendered a single sentence
 * ("No measurements yet") in a dashed-border box with no CTA. Brand-
 * new accounts had to scroll back up to find the header "Add" button.
 * The new EmptyState surface mounts the primitive with an Activity
 * icon, localized copy, and an "Add your first measurement" CTA wired
 * to the parent dialog.
 *
 * The filter-aware copy switches to "no measurements match this
 * filter" + a "Show all types" reset CTA when a non-default filter is
 * active — guarded indirectly by the absence assertion here (the test
 * runs the default ALL filter; reset CTA must NOT appear).
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/measurements",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { measurements: [], meta: { total: 0 } },
    isLoading: false,
  }),
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
    user: { id: "u1", username: "testuser", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementList } from "../measurement-list";

function render(props: { onAddFirst?: () => void } = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementList {...props} />
    </I18nProvider>,
  );
}

describe("MeasurementList — empty state", () => {
  it("renders the EmptyState primitive when no measurements exist", () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-slot="empty-state-title"');
  });

  it("renders the localized title, and no sentence under it", () => {
    const html = render();
    expect(html).toContain("No measurements yet");
    expect(html).not.toContain(
      "Log your weight, blood pressure, pulse, or other vitals",
    );
  });

  it("exposes the Add-first CTA when onAddFirst is wired", () => {
    const html = render({ onAddFirst: () => {} });
    expect(html).toContain("Add your first measurement");
  });

  it("hides the Add-first CTA when no callback is provided", () => {
    const html = render();
    // The fallback is the parent's header CTA; the empty card itself
    // must not render a button that does nothing.
    expect(html).not.toContain("Add your first measurement");
  });

  it("does not render the reset-filter CTA on the default filter", () => {
    const html = render();
    expect(html).not.toContain("Show all types");
  });
});
