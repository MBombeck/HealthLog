/**
 * The app shell's scroll position across navigation.
 *
 * `<main>` is the shell's one scroller and stays mounted across routes, and
 * the browser restores only the document's offset on Back. So the shell
 * keeps the offsets itself: a new page starts at the top, Back returns to
 * where the list was left.
 */
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { usePathname } from "next/navigation";
import { URL_STATE_EVENT } from "@/lib/url-state";

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

/**
 * A long list on `/labs`, a short detail page anywhere else. The list is
 * short while it loads (a skeleton), and each page mounts afresh.
 */
function Page() {
  const pathname = usePathname();
  return <PageBody key={pathname} pathname={pathname} />;
}

function PageBody({ pathname }: { pathname: string }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoaded(true), 200);
    return () => clearTimeout(timer);
  }, []);
  const long = pathname === "/labs" && loaded;
  return (
    <div
      data-slot="page"
      data-path={pathname}
      data-loaded={loaded || undefined}
      style={{ height: long ? 4000 : 300 }}
    />
  );
}

function main(): HTMLElement {
  return document.getElementById("main-content")!;
}

async function nextFrames(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/** A link tap: the router pushes the entry and renders the next page. */
async function openPage(path: string): Promise<void> {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(URL_STATE_EVENT));
  await expect
    .poll(() => document.querySelector(`[data-path="${path}"]`))
    .toBeTruthy();
}

describe("AuthShell scroll position", () => {
  it("opens a new page at the top and returns to the list's offset on Back, once the list has loaded", async () => {
    stubFetch();
    window.history.replaceState(null, "", "/labs");
    await renderWithApp(
      <AuthShell>
        <Page />
      </AuthShell>,
      { user: { id: "signed-in" } },
    );
    await expect
      .poll(() => document.querySelector("[data-loaded]"))
      .toBeTruthy();

    main().scrollTop = 1500;
    await nextFrames();
    expect(main().scrollTop).toBe(1500);

    await openPage("/labs/biomarker-1");
    await expect.poll(() => main().scrollTop).toBe(0);

    window.history.back();
    await expect
      .poll(() => document.querySelector('[data-path="/labs"]'))
      .toBeTruthy();
    await expect.poll(() => main().scrollTop).toBe(1500);
  });
});
