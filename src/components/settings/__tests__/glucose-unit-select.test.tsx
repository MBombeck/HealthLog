import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";

/**
 * Settings → Profile blood-glucose unit dropdown.
 *
 * The control the preference column never had. It sits beside the
 * metric/imperial select and is deliberately not a branch of it: metric
 * countries are split on which unit they read glucose in, so one dropdown
 * would get one of them wrong.
 *
 * SSR-only, like the unit-system select next to it: the render pass pins the
 * options and the selected value, and the mutation contract — endpoint,
 * method, body — is asserted against the source, because nothing here can
 * dispatch a change event.
 */

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: buildUser(null), isAuthenticated: true }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

function buildUser(glucoseUnit: string | null): AuthUser {
  return {
    id: "user-1",
    username: "user",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    onboardingTourProgress: null,
    avatarUrl: null,
    glucoseUnit,
    unitPreference: "metric",
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    lastReportPracticeName: null,
    reportSelection: null,
    cycleTrackingEnabled: false,
    modules: {},
  } as AuthUser;
}

import { GlucoseUnitSelect } from "../glucose-unit-select";

const componentSource = readFileSync(
  join(process.cwd(), "src/components/settings/glucose-unit-select.tsx"),
  "utf8",
);

beforeEach(() => {
  authSpy.mockClear();
  authSpy.mockImplementation(() => ({
    user: buildUser(null),
    isAuthenticated: true,
  }));
});

function render(isAuthenticated = true): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <GlucoseUnitSelect isAuthenticated={isAuthenticated} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings — GlucoseUnitSelect", () => {
  it("offers both units the app renders", () => {
    const html = render();
    expect(html).toContain('data-testid="settings-glucose-unit-select"');
    expect(html).toContain('value="mg/dL"');
    expect(html).toContain('value="mmol/L"');
  });

  // React renders a controlled select's current value as `selected` on the
  // option under SSR, not as an attribute on the `<select>`.
  function selectedOption(html: string): string | null {
    return /<option[^>]*selected[^>]*>/.exec(html)?.[0] ?? null;
  }

  it("shows mg/dL for an account that never chose", () => {
    expect(selectedOption(render())).toContain('value="mg/dL"');
  });

  it("shows the unit an account already chose", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser("mmol/L"),
      isAuthenticated: true,
    }));
    expect(selectedOption(render())).toContain('value="mmol/L"');
  });

  it("disables the select when unauthenticated", () => {
    const select = /<select[^>]*settings-glucose-unit-select[^>]*>/.exec(
      render(false),
    );
    expect(select).not.toBeNull();
    expect(select![0]).toContain("disabled");
  });

  it("PATCHes the glucose-unit endpoint field-by-field", () => {
    expect(componentSource).toMatch(
      /apiFetchRaw\(\s*"\/api\/auth\/me\/glucose-unit"[\s\S]{0,200}?method: "PATCH"[\s\S]{0,200}?JSON\.stringify\(\{ glucoseUnit: next \}\)/,
    );
  });

  it("refreshes the account payload every glucose surface reads from", () => {
    expect(componentSource).toMatch(/queryKey: queryKeys\.authMe\(\)/);
  });

  // The targets panel takes its unit from the targets payload, not from the
  // account, so a save that only refreshed `/me` left it on the old unit
  // until the server cache turned over (up to ten minutes). Both ends have
  // to let go of the old payload.
  it("refreshes the targets payload on both ends", () => {
    expect(componentSource).toMatch(/queryKey: queryKeys\.insightsTargets\(\)/);
    const route = readFileSync(
      join(process.cwd(), "src/app/api/auth/me/glucose-unit/route.ts"),
      "utf8",
    );
    expect(route).toMatch(/!== next\) \{\s*invalidateUserProfile\(user\.id\);/);
  });

  it("is actually mounted on the settings page", () => {
    // A control nobody can reach is the same defect as no control.
    const accountSection = readFileSync(
      join(process.cwd(), "src/components/settings/account-section/index.tsx"),
      "utf8",
    );
    expect(accountSection).toMatch(/<GlucoseUnitSelect\s/);
  });
});
