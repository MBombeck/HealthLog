/**
 * The "machine translated" strip is not part of signing in.
 *
 * It belongs to the app, where the language can be changed and a correction
 * reported; on the sign-in, registration and take-over pages it was the first
 * thing a visitor in eight of ten languages read, above the form.
 */
import { describe, expect, it, vi } from "vitest";

import { renderWithApp } from "../../../../tests/browser/render";
import { stubFetch } from "../../../../tests/browser/fetch-stub";

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

const BANNER = '[data-slot="maintainership-banner"]';

async function mountAt(path: string, user: { id: string } | null) {
  window.history.replaceState(null, "", path);
  await renderWithApp(
    <AuthShell>
      <div data-slot="page" />
    </AuthShell>,
    { user, locale: "fr" },
  );
  await expect
    .poll(() => document.querySelector('[data-slot="page"]'))
    .toBeTruthy();
}

describe("translation notice", () => {
  it("is not shown on the sign-in page", async () => {
    stubFetch().on("GET", "/api/auth/me", {
      status: 401,
      error: "Unauthorized",
    });
    await mountAt("/auth/login", null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector(BANNER)).toBeNull();
  });

  it("is still shown inside the app", async () => {
    stubFetch();
    await mountAt("/", { id: "signed-in" });
    await expect.poll(() => document.querySelector(BANNER)).toBeTruthy();
  });
});
