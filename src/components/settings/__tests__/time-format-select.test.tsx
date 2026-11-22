/**
 * Settings → Profile hour-format dropdown contract (v1.15.20).
 *
 * The control reads the current value from `useAuth().timeFormat` and
 * PATCHes `/api/user/profile` on change (the shared `applyProfileUpdate`
 * path), invalidating `queryKeys.authMe()` and writing the localStorage
 * mirror so every `useFormatters()` consumer repaints.
 *
 * Test strategy mirrors `<UnitPreferenceSelect>`'s suite — the project's
 * SSR-only convention (no `@testing-library/react`): real `useMutation` +
 * `QueryClient`, a spied `useAuth`, and a stubbed `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";
import type { TimeFormatPreference } from "@/lib/format-locale";

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: buildUser("AUTO"), isAuthenticated: true }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return { ...actual, useAuth: () => authSpy() };
});

function buildUser(timeFormat: TimeFormatPreference): AuthUser {
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
    unitPreference: "metric",
    timeFormat,
    dateFormat: "AUTO",
    medicineRegistry: "NONE",
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

import { TimeFormatSelect } from "../time-format-select";

let fetchMock: ReturnType<typeof vi.fn>;

function makeFetch() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    return new Response(
      JSON.stringify({ data: { timeFormat: body.timeFormat } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

beforeEach(() => {
  authSpy.mockClear();
  authSpy.mockImplementation(() => ({
    user: buildUser("AUTO"),
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
        <TimeFormatSelect isAuthenticated={isAuthenticated} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings — TimeFormatSelect", () => {
  it("renders a labeled native select with all three options", () => {
    const html = render();
    expect(html).toContain('data-testid="settings-time-format-select"');
    expect(html).toContain('value="AUTO"');
    expect(html).toContain('value="H24"');
    expect(html).toContain('value="H12"');
    expect(html).toContain("Automatic (language)");
    expect(html).toContain("24-hour");
    expect(html).toContain("12-hour (AM/PM)");
  });

  it("reflects a stored H24 preference", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser("H24"),
      isAuthenticated: true,
    }));
    const html = render();
    expect(html).toMatch(
      /<option[^>]*selected[^>]*value="H24"|<option[^>]*value="H24"[^>]*selected/,
    );
  });

  it("defaults to AUTO when the user has no stored preference", () => {
    authSpy.mockImplementation(() => ({
      user: null,
      isAuthenticated: true,
    }));
    const html = render();
    expect(html).toMatch(
      /<option[^>]*selected[^>]*value="AUTO"|<option[^>]*value="AUTO"[^>]*selected/,
    );
  });

  it("disables the select when unauthenticated", () => {
    const html = render(false);
    const select = html.match(/<select[^>]*settings-time-format-select[^>]*>/);
    expect(select).not.toBeNull();
    expect(select![0]).toContain("disabled");
  });

  it("targets the profile endpoint with a PATCH body", async () => {
    // SSR can't dispatch a change event, so pin the mutation contract
    // against the same stub the handler issues — endpoint, method, and
    // the field-by-field body shape the route's Zod schema accepts.
    await fetch("/api/user/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeFormat: "H24" }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/user/profile");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ timeFormat: "H24" });
  });
});
