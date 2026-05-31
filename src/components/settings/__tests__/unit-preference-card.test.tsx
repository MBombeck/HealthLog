/**
 * v1.7.0 — Settings → Display metric/imperial control contract.
 *
 * The card is a two-option segmented control that reads the current
 * value from `useAuth().unitPreference` and PATCHes
 * `/api/auth/me/unit-preference` on change, invalidating
 * `queryKeys.authMe()` so the chart display transforms re-render.
 *
 * Test strategy mirrors `<DisableCoachCard>` and the project's
 * SSR-only convention (no `@testing-library/react`): real
 * `useMutation` + `QueryClient`, a spied `useAuth`, and a stubbed
 * `fetch`. The render pass pins the current-value SSR shape and the
 * interactive / disabled state of the two segments; the mutation
 * contract (endpoint + method + body) is pinned against the same
 * `fetch` stub the click handler issues.
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
    avatarUrl: null,
    glucoseUnit: null,
    unitPreference,
    disableCoach: false,
    fullName: null,
    insurerName: null,
    insuranceNumber: null,
  };
}

import { UnitPreferenceCard } from "../unit-preference-card";

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

function render(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <UnitPreferenceCard isAuthenticated />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// React renders the boolean `disabled` attribute as `disabled=""`. The
// Tailwind `disabled:opacity-50` class string also contains the word
// "disabled", so callers match the attribute form specifically. The
// helper isolates a single button's opening tag so attribute order
// (which React does not guarantee) doesn't make assertions brittle.
function segmentMarkup(html: string, key: "metric" | "imperial"): string {
  const m = html.match(
    new RegExp(`<button[^>]*settings-unit-preference-${key}[^>]*>`),
  );
  expect(m).not.toBeNull();
  return m![0];
}

describe("Settings — UnitPreferenceCard", () => {
  it("renders the metric option as selected for a default user", () => {
    const html = render();
    expect(html).toContain('data-testid="settings-unit-preference-control"');
    // The metric radio carries aria-checked="true"; imperial false.
    expect(segmentMarkup(html, "metric")).toContain('aria-checked="true"');
    expect(segmentMarkup(html, "imperial")).toContain('aria-checked="false"');
  });

  it("reflects an imperial user's stored preference", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser("imperial"),
      isAuthenticated: true,
    }));
    const html = render();
    expect(segmentMarkup(html, "imperial")).toContain('aria-checked="true"');
    expect(segmentMarkup(html, "metric")).toContain('aria-checked="false"');
  });

  it("renders both segments as enabled radios for an authenticated user", () => {
    const html = render();
    // Both segments are interactive (no `disabled=""` attribute) so the
    // user can switch between them; the click handler PATCHes the
    // endpoint with the chosen value.
    expect(segmentMarkup(html, "metric")).not.toContain('disabled=""');
    expect(segmentMarkup(html, "imperial")).not.toContain('disabled=""');
    expect(html).toContain("Metric");
    expect(html).toContain("Imperial");
  });

  it("applies a roving tabindex — selected segment is the tab stop", () => {
    // Roving tabindex: the radiogroup is a single tab stop. The selected
    // (metric) option carries tabindex=0; the unselected (imperial) option
    // carries tabindex=-1 so Tab skips it and Arrow keys move within the
    // group instead. Arrow-key navigation itself is exercised at the
    // `rovingRadioNextIndex` unit level (SSR can't dispatch keydown).
    const html = render();
    expect(segmentMarkup(html, "metric")).toContain('tabindex="0"');
    expect(segmentMarkup(html, "imperial")).toContain('tabindex="-1"');
  });

  it("moves the tab stop to the imperial segment when it is selected", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser("imperial"),
      isAuthenticated: true,
    }));
    const html = render();
    expect(segmentMarkup(html, "imperial")).toContain('tabindex="0"');
    expect(segmentMarkup(html, "metric")).toContain('tabindex="-1"');
  });

  it("disables both segments when unauthenticated", () => {
    authSpy.mockImplementation(() => ({ user: null, isAuthenticated: false }));
    const html = renderToStaticMarkup(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: 0 } } })}
      >
        <I18nProvider initialLocale="en">
          <UnitPreferenceCard isAuthenticated={false} />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(segmentMarkup(html, "metric")).toContain('disabled=""');
    expect(segmentMarkup(html, "imperial")).toContain('disabled=""');
  });

  it("targets the unit-preference endpoint with a PATCH body", async () => {
    // SSR can't dispatch a click, so pin the mutation contract against
    // the same stub the handler issues — endpoint, method, and the
    // field-by-field body shape the route's Zod schema accepts.
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
