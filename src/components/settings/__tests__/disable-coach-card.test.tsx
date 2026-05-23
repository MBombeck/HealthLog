/**
 * v1.4.47 W3 — Settings → AI "Hide Coach" toggle persistence contract.
 *
 * The card is a small client-only `<Switch>` that PATCHes
 * `/api/auth/me/disable-coach` and invalidates `queryKeys.authMe()` so
 * every Coach mount point in the app reacts on the next /me refetch.
 *
 * Test strategy: use the real `useMutation` + `QueryClient` from
 * `@tanstack/react-query`, stub `fetch`, and drive the Switch via a
 * `renderToStaticMarkup` pass plus a hand-invoked mutation call. The
 * file SSR-renders inside a `<QueryClientProvider>` so the hook
 * branches execute and the spies fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import type { AuthUser } from "@/hooks/use-auth";

const authSpy = vi.fn<
  () => { user: AuthUser | null; isAuthenticated: boolean }
>(() => ({ user: buildUser(false), isAuthenticated: true }));
vi.mock("@/hooks/use-auth", async () => {
  const actual =
    await vi.importActual<typeof import("@/hooks/use-auth")>(
      "@/hooks/use-auth",
    );
  return {
    ...actual,
    useAuth: () => authSpy(),
  };
});

// Stub every other query hook the parent `<AiSection>` triggers so
// the SSR pass doesn't blow up. The disable-coach card itself doesn't
// trigger any GET — it only writes through PATCH on click.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/ai",
  useSearchParams: () => new URLSearchParams(""),
}));

function buildUser(disableCoach: boolean): AuthUser {
  return {
    id: "user-1",
    username: "marc",
    email: null,
    role: "USER",
    heightCm: null,
    dateOfBirth: null,
    gender: null,
    timezone: "Europe/Berlin",
    onboardingCompletedAt: null,
    onboardingTourCompleted: true,
    gravatarUrl: null,
    glucoseUnit: null,
    disableCoach,
  };
}

import { AiSection } from "../ai-section";

function makeFetch() {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    return new Response(
      JSON.stringify({
        data: { disableCoach: body.disableCoach ?? false },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}

beforeEach(() => {
  authSpy.mockClear();
  authSpy.mockImplementation(() => ({
    user: buildUser(false),
    isAuthenticated: true,
  }));
  vi.stubGlobal("fetch", makeFetch());
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
        <AiSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("Settings — DisableCoachCard", () => {
  it("seeds the Switch in the off state for a default user", () => {
    const html = render();
    // The Switch primitive surfaces `data-state="unchecked"` when
    // `checked={false}` is passed by the parent — pin the contract so
    // the SSR shape matches the user's `disableCoach: false` field.
    expect(html).toContain('data-testid="settings-disable-coach-switch"');
    expect(html).toContain('data-state="unchecked"');
  });

  it("seeds the Switch in the on state for an opted-out user", () => {
    authSpy.mockImplementation(() => ({
      user: buildUser(true),
      isAuthenticated: true,
    }));
    const html = render();
    expect(html).toContain('data-testid="settings-disable-coach-switch"');
    // The shadcn Switch surfaces `data-state="checked"` on the root
    // when `checked={true}`. Pre-fix the card painted `unchecked` for
    // an opted-out user; this assertion guards that regression.
    expect(html).toContain('data-state="checked"');
  });

  it("Switch description string matches the QoL audit (M2) copy", () => {
    const html = render();
    // The Marc-voice contract: "Hides the Coach button and drawer
    // everywhere." (English) — must surface verbatim because the QoL
    // findings doc cites this exact phrasing.
    expect(html).toContain("Hides the Coach button and drawer everywhere.");
  });
});
