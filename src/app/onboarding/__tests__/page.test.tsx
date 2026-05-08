import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Stub Next.js navigation — we never actually navigate in these tests.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// Stub TanStack Query — the onboarding page only invalidates after
// finish, which we don't trigger here.
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: null, isLoading: false }),
}));

// Stub the toaster — fires post-finish only.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The Logo pulls in an SVG icon set we don't need to assert on.
vi.mock("@/components/ui/logo", () => ({
  Logo: () => null,
}));

// MeasurementForm is independently tested. Stub it so step 2's render
// doesn't drag the entire form's dependencies into this SSR test.
vi.mock("@/components/measurements/measurement-form", () => ({
  MeasurementForm: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import OnboardingPage from "../page";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <OnboardingPage />
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<OnboardingPage> v2", () => {
  it("renders three progress dots, not four", () => {
    const html = render();
    // The progress row holds exactly three dots — count `w-10` segments.
    const dots = html.match(/h-1\.5 w-10 rounded-full/g) ?? [];
    expect(dots.length).toBe(3);
  });

  it("shows the v2 welcome copy and step 1 of 3 indicator", () => {
    const html = render();
    expect(html).toContain("Welcome to HealthLog");
    expect(html).toContain("Step 1 of 3");
    expect(html).toContain("About you");
  });

  it("renders the German title when locale is de", () => {
    const html = render("de");
    expect(html).toContain("Willkommen bei HealthLog");
    expect(html).toContain("Schritt 1 von 3");
  });

  it("includes a single skip link with the descriptive label", () => {
    const html = render();
    const skipMatches =
      html.match(
        /Skip this step — you can finish setup later from Settings./g,
      ) ?? [];
    // Exactly one skip control on step 1; second skip from the legacy
    // wizard is gone.
    expect(skipMatches.length).toBe(1);
  });

  it("does not show a Back button on step 1 (first step)", () => {
    const html = render();
    expect(html).not.toContain(">Back<");
  });

  it("provides every step-1 form field via accessible labels", () => {
    const html = render();
    expect(html).toContain('for="ob-display-name"');
    expect(html).toContain('for="ob-language"');
    expect(html).toContain('for="ob-height"');
    expect(html).toContain('for="ob-gender"');
    expect(html).toContain('for="ob-dob"');
  });

  it("step-1 progressbar has correct aria attributes", () => {
    const html = render();
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="1"');
    expect(html).toContain('aria-valuemax="3"');
    expect(html).toContain('aria-valuenow="1"');
  });
});
