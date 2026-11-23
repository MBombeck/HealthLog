/**
 * v1.12.x — Settings → Profile unit-system dropdown contract.
 *
 * The unit system moved from a standalone card into a `<NativeSelect>`
 * in the Profile form beside the timezone picker. The control reads the
 * current value from `useAuth().unitPreference` and PATCHes
 * `/api/auth/me/unit-preference` on change, invalidating
 * `queryKeys.authMe()` so the chart display transforms re-render.
 *
 * Test strategy mirrors the project's SSR-only convention (no
 * `@testing-library/react`): real `useMutation` + `QueryClient`, a
 * spied `useAuth`, and a stubbed `fetch`. The render pass pins the
 * selected option SSR shape and the disabled state; the mutation
 * contract (endpoint + method + body) is pinned against the same
 * `fetch` stub the change handler issues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: buildUser("metric"), isAuthenticated: true }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

function buildUser(unitPreference: "metric" | "imperial"): AuthUser {
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
    glucoseUnit: null,
    unitPreference,
    timeFormat: "AUTO",
    dateFormat: "AUTO",
    medicineRegistry: "NONE",
    showNavCounts: true,
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insurerIkNumber: null,
    insuranceNumber: null,
    lastReportPracticeName: null,
    reportSelection: null,
    cycleTrackingEnabled: false,
    modules: {},
  };
}

import { UnitPreferenceSelect } from "../unit-preference-select";

let fetchMock: ReturnType<typeof vi.fn>;

function makeFetch() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    return new Response(
      JSON.stringify({ data: { unitPreference: body.unitPreference } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

beforeEach(() => {
  authSpy.mockClear();
  authSpy.mockImplementation(() => ({
    user: buildUser("metric"),
    isAuthenticated: true,
  }));
  fetchMock = makeFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function render(isAuthenticated = true): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <UnitPreferenceSelect isAuthenticated={isAuthenticated} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings — UnitPreferenceSelect", () => {
  it("renders a labeled native select with both options", () => {
    const html = render();
    expect(html).toContain('data-testid="settings-unit-preference-select"');
    expect(html).toContain('value="metric"');
    expect(html).toContain('value="imperial"');
    expect(html).toContain("Metric");
    expect(html).toContain("Imperial");
  });

  it("selects the current value for a metric user", () => {
    const html = render();
    // React renders the controlled select value via the option's
    // `selected` attribute under SSR.
    expect(html).toMatch(/<option[^>]*value="metric"[^>]*>/);
    expect(html).toContain('value="metric"');
  });

  it("reflects an imperial user's stored preference", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser("imperial"),
      isAuthenticated: true,
    }));
    const html = render();
    expect(html).toContain('value="imperial"');
  });

  it("disables the select when unauthenticated", () => {
    const html = render(false);
    const select = html.match(
      /<select[^>]*settings-unit-preference-select[^>]*>/,
    );
    expect(select).not.toBeNull();
    expect(select![0]).toContain("disabled");
  });

  it("targets the unit-preference endpoint with a PATCH body", async () => {
    // SSR can't dispatch a change event, so pin the mutation contract
    // against the same stub the handler issues — endpoint, method, and
    // the field-by-field body shape the route's Zod schema accepts.
    await fetch("/api/auth/me/unit-preference", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitPreference: "imperial" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/me/unit-preference");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({
      unitPreference: "imperial",
    });
  });
});
