/**
 * What the shell does once the server says there is no session.
 *
 * On an `/auth/*` page it clears the previous account's offline copies, once,
 * so a session that ended without a sign-out (an expired cookie the edge sent
 * straight to the sign-in page) leaves nothing on the device for the next
 * account. It never clears on an answer that is not a verdict.
 *
 * On a protected page it sends the visitor to the sign-in page, carrying the
 * page along when the session ended on its own, and not after a deliberate
 * sign-out: the next person on the device starts from a bare sign-in page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";

import { authUser, renderWithApp } from "../../../../tests/browser/render";
import { stubFetch } from "../../../../tests/browser/fetch-stub";

const clearOffline = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/pwa/query-persister", () => ({
  clearOfflineCachesForSessionEnd: clearOffline,
  clearOfflineCachesForRecordSwitch: vi.fn(async () => {}),
}));

// Chrome that is not the subject.
vi.mock("../sidebar-nav", () => ({ SidebarNav: () => null }));
vi.mock("../bottom-nav", () => ({ BottomNav: () => null }));
vi.mock("../top-bar", () => ({ TopBar: () => null }));
vi.mock("../offline-banner", () => ({ OfflineBanner: () => null }));
vi.mock("../shared-record-banner", () => ({ SharedRecordBanner: () => null }));
vi.mock("@/components/gamification/achievement-unlock-notifier", () => ({
  AchievementUnlockNotifier: () => null,
}));
vi.mock("@/components/insights/layout-coach-fab", () => ({
  LayoutCoachFab: () => null,
}));
vi.mock("@/components/insights/layout-coach-mount", () => ({
  LayoutCoachMount: () => null,
}));
vi.mock("@/components/onboarding/tour-launcher", () => ({
  TourLauncher: () => null,
}));
vi.mock("@/components/day/day-layer", () => ({ DayLayerMount: () => null }));
vi.mock("@/components/command-palette/command-palette.lazy", () => ({
  CommandPaletteMount: () => null,
}));
vi.mock("../global-shortcuts", () => ({ GlobalShortcuts: () => null }));

import { clearCachesForSessionEnd } from "@/hooks/use-auth";

import { AuthShell } from "../auth-shell";

const ME = "/api/auth/me";

function openAt(path: string): void {
  window.history.replaceState(null, "", path);
}

/** The tree `renderWithApp` mounts, for rendering it again. */
function shellTree(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <AuthShell>
          <div data-slot="page" />
        </AuthShell>
      </I18nProvider>
    </QueryClientProvider>
  );
}

async function mountShell(user: Parameters<typeof authUser>[0] | null) {
  return renderWithApp(
    <AuthShell>
      <div data-slot="page" />
    </AuthShell>,
    { user },
  );
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

afterEach(() => {
  clearOffline.mockClear();
});

describe("AuthShell on a sign-in page", () => {
  it("clears the offline copies once the server says there is no session", async () => {
    const fetchStub = stubFetch().on("GET", ME, {
      status: 401,
      error: "Unauthorized",
    });
    openAt("/auth/login");
    const { queryClient } = await mountShell(null);

    await expect.poll(() => clearOffline.mock.calls.length).toBe(1);

    // A second answer of the same kind does not clear again.
    await queryClient.refetchQueries();
    await settle();
    expect(fetchStub.calls("GET", ME).length).toBeGreaterThan(1);
    expect(clearOffline).toHaveBeenCalledTimes(1);
  });

  it("does the same on the profile take-over page", async () => {
    stubFetch().on("GET", ME, { status: 401, error: "Unauthorized" });
    openAt("/auth/claim");
    await mountShell(null);
    await expect.poll(() => clearOffline.mock.calls.length).toBe(1);
  });

  it("leaves them alone for a signed-in visitor", async () => {
    stubFetch();
    openAt("/auth/register");
    await mountShell({ id: "signed-in" });
    await settle();
    expect(clearOffline).not.toHaveBeenCalled();
  });

  it("leaves them alone when the answer carries no verdict", async () => {
    // An offline launch or a 5xx says nothing about the session; clearing on
    // it is what used to destroy the offline copies of a signed-in device.
    const fetchStub = stubFetch().on("GET", ME, {
      status: 503,
      error: "Unavailable",
    });
    openAt("/auth/login");
    await mountShell(null);
    // The account query retries a 5xx once; wait for both answers.
    await expect
      .poll(() => fetchStub.calls("GET", ME).length, { timeout: 4000 })
      .toBe(2);
    await settle();
    expect(clearOffline).not.toHaveBeenCalled();
  });

  it("does not clear on a public page outside the sign-in flow", async () => {
    stubFetch().on("GET", ME, { status: 401, error: "Unauthorized" });
    openAt("/about");
    await mountShell(null);
    await settle();
    expect(clearOffline).not.toHaveBeenCalled();
  });
});

describe("AuthShell on a protected page", () => {
  /** Signed in on `path`, with the marker a confirmed session leaves. */
  async function signedInAt(path: string) {
    let session = true;
    stubFetch().on("GET", ME, () =>
      session
        ? { data: authUser({ id: "signed-in" }) }
        : { status: 401, error: "Unauthorized" },
    );
    openAt(path);
    const view = await mountShell(null);
    await expect
      .poll(() => document.querySelector('[data-slot="page"]'))
      .toBeTruthy();
    return {
      ...view,
      endSession: () => {
        session = false;
      },
    };
  }

  it("returns to the page after a session that ended on its own", async () => {
    // Signed in once on this browser; the session has since expired while
    // the cookie stayed, so the next visit gets past the edge and the
    // account answer is the first to say so.
    const first = await signedInAt("/");
    first.endSession();
    await first.screen.unmount();
    openAt("/measurements?add=WEIGHT");
    await mountShell(null);

    await expect.poll(() => window.location.pathname).toBe("/auth/login");
    expect(new URLSearchParams(window.location.search).get("next")).toBe(
      "/measurements?add=WEIGHT",
    );
  });

  it("does not carry the page past a deliberate sign-out", async () => {
    const { screen, queryClient, endSession } =
      await signedInAt("/medications");
    // What the sign-out does once the server confirmed it; the navigation
    // it starts renders the shell again, which asks for the account anew.
    endSession();
    clearCachesForSessionEnd(queryClient);
    await screen.rerender(shellTree(queryClient));

    await expect.poll(() => window.location.pathname).toBe("/auth/login");
    expect(window.location.search).toBe("");
  });
});
