/**
 * What the shell does once the server says there is no session.
 *
 * On an `/auth/*` page it clears the previous account's offline copies, once,
 * so a session that ended without a sign-out (an expired cookie the edge sent
 * straight to the sign-in page) leaves nothing on the device for the next
 * account. It never clears on an answer that is not a verdict.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { AuthShell } from "../auth-shell";

const ME = "/api/auth/me";

function openAt(path: string): void {
  window.history.replaceState(null, "", path);
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
