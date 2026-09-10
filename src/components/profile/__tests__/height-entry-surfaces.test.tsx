/**
 * v1.32.30 — the two surfaces that ENTER a height: the onboarding
 * baseline step and the Settings profile card.
 *
 * Vitest runs in the Node environment here (no jsdom), so this asserts
 * the SSR markup — which is exactly where the failure this release
 * closes lived: an imperial account being handed a box labelled "cm".
 *
 * Mutation check: swap either surface's label back to the unconditional
 * `t("settings.height")` / `t("onboarding.baseline.heightLabel")` and
 * the "(ft, in)" assertions go red; drop the adapter and the feet +
 * inches inputs disappear with them.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let unitPreference: "metric" | "imperial" = "metric";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/account",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: null, isLoading: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "testuser",
      email: "user@example.com",
      heightCm: 180.34,
      dateOfBirth: "1990-01-01",
      gender: "MALE",
      role: "USER",
      unitPreference,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { BaselineForm } from "@/components/onboarding/baseline-form";
import { AccountSection } from "@/components/settings/account-section";

function renderUnder(
  preference: "metric" | "imperial",
  node: React.ReactElement,
): string {
  unitPreference = preference;
  try {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">{node}</I18nProvider>,
    );
  } finally {
    unitPreference = "metric";
  }
}

const SURFACES = [
  {
    name: "onboarding baseline step",
    node: (
      <BaselineForm
        initial={{ heightCm: null, dateOfBirth: null, gender: null }}
        onConfirmed={async () => {}}
      />
    ),
    firstInputId: "ob-baseline-height",
    metricLabel: "Height (cm)",
  },
  {
    name: "Settings profile card",
    node: <AccountSection />,
    firstInputId: "height",
    metricLabel: "Height (cm)",
  },
] as const;

describe.each(SURFACES)("$name — height entry", (surface) => {
  it("keeps the single centimetres box for a metric account", () => {
    const html = renderUnder("metric", surface.node);
    expect(html).toContain(surface.metricLabel);
    expect(html).not.toContain("Height (ft, in)");
    expect(html).toContain(`id="${surface.firstInputId}"`);
    expect(html).not.toContain(`id="${surface.firstInputId}-inches"`);
    // The canonical guardrails, unconverted, on the height box itself.
    expect(html).toMatch(
      new RegExp(
        `id="${surface.firstInputId}"[^>]*min="50"[^>]*max="300"`,
        "u",
      ),
    );
  });

  it("shows feet + inches for an imperial account", () => {
    const html = renderUnder("imperial", surface.node);
    expect(html).toContain("Height (ft, in)");
    expect(html).not.toContain(surface.metricLabel);
    expect(html).toContain(`id="${surface.firstInputId}"`);
    expect(html).toContain(`id="${surface.firstInputId}-inches"`);
    expect(html).toContain('aria-label="Height in feet"');
    expect(html).toContain('aria-label="Height in inches"');
    // The unit suffixes come from the bundle, not from a hardcoded
    // literal in the surface.
    expect(html).toContain(">ft</span>");
    expect(html).toContain(">in</span>");
    // The canonical 50/300 centimetre guardrails must not survive onto
    // a feet field.
    expect(html).not.toContain('max="300"');
  });

  it("seeds the imperial fields from the stored centimetres", () => {
    const html = renderUnder("imperial", surface.node);
    // 180.34 cm is exactly 71 in.
    if (surface.firstInputId === "height") {
      expect(html).toMatch(/id="height"[^>]*value="5"/u);
      expect(html).toMatch(/id="height-inches"[^>]*value="11"/u);
    } else {
      // The onboarding step starts blank by design — it is a fresh
      // profile, not an edit of an existing one.
      expect(html).toMatch(/id="ob-baseline-height"[^>]*value=""/u);
    }
  });
});
