/**
 * `<DashboardHeader>` greeting contract.
 *
 * The greeting line sits under the title on every dashboard mount — the
 * promoted Today hero renders separately above the tile strip, so the
 * header greeting is unconditional (the legacy opt-in hero that once
 * owned it was retired). Pinned here:
 *
 *   1. the greeting line renders (with the `min-h-5` line-box
 *      reservation that keeps the header height stable through the
 *      post-hydration name personalisation);
 *   2. the SSR pass renders the name-less fallback (hydration-safe).
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
const modulesRef: { value: Record<string, boolean> | undefined } = {
  value: undefined,
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      username: "tester",
      timezone: "Europe/Berlin",
      modules: modulesRef.value,
    },
  }),
}));

import { DashboardHeader } from "../dashboard-header";
import {
  CAPTURE_KIND_ORDER,
  visibleCaptureKinds,
} from "@/components/layout/capture-picker";

function renderSSR(node: React.ReactElement, locale: "en" | "de" = "de") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<DashboardHeader> — greeting", () => {
  it("renders the greeting line under the title", () => {
    const html = renderSSR(<DashboardHeader onQuickEntry={() => undefined} />);
    expect(html).toContain('data-slot="dashboard-header-greeting"');
    // SSR pass: name-less fallback (personalises post-hydration only).
    expect(html).toContain("willkommen zurück.");
    // Reserved line box keeps the header height stable through the
    // post-hydration personalisation swap.
    expect(html).toMatch(/data-slot="dashboard-header-greeting"[^>]*>/);
    expect(html).toContain("min-h-5");
    // The title itself stays.
    expect(html).toContain("Dashboard");
  });

  // 2026-07-17 a11y audit (M4) — the dashboard is the app's landing surface
  // and must expose a page-level `<h1>`. It comes from the shared
  // `PageHeader` the header renders, so a screen-reader user navigating by
  // heading lands on a real page anchor (not the Today hero's muted `<h2>`
  // micro-label). No separate sr-only heading is added — that would double
  // the `h1`.
  it("renders a real page-level h1 with the dashboard title", () => {
    const html = renderSSR(<DashboardHeader onQuickEntry={() => undefined} />);
    expect(html).toMatch(/<h1[^>]*>Dashboard<\/h1>/);
  });
});

describe("<DashboardHeader> — quick-add menu", () => {
  it("offers measurement, mood and medication, and no water entry", () => {
    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} />,
      "en",
    );

    expect(html).toContain("Log measurement");
    expect(html).toContain("Log mood");
    expect(html).toContain("Log medication intake");
    // Water logging was removed from the app; the dashboard quick-add offers
    // no water entry.
    expect(html).not.toContain("Log water");
  });
});

describe("<DashboardHeader> — Log workout", () => {
  beforeEach(() => {
    modulesRef.value = undefined;
  });

  it("offers it beside the other capture entries", () => {
    modulesRef.value = { workouts: true };
    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} />,
      "en",
    );
    expect(html).toContain("Log workout");
  });

  it("withholds it when the workouts module is off, and keeps the rest", () => {
    modulesRef.value = { workouts: false };
    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} />,
      "en",
    );
    expect(html).not.toContain("Log workout");
    expect(html).toContain("Log measurement");
  });
});

describe("<DashboardHeader> — every entry follows its module, as the capture picker does", () => {
  beforeEach(() => {
    modulesRef.value = undefined;
  });

  it("withholds Log mood when the mood module is off", () => {
    modulesRef.value = { mood: false };
    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} />,
      "en",
    );
    expect(html).not.toContain("Log mood");
    expect(html).toContain("Log medication intake");
  });

  it("withholds Log medication intake when the medications module is off", () => {
    modulesRef.value = { medications: false };
    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} />,
      "en",
    );
    expect(html).not.toContain("Log medication intake");
    expect(html).toContain("Log mood");
  });

  it("offers exactly what the capture picker offers for the same modules", () => {
    const cases: Array<Record<string, boolean> | undefined> = [
      undefined,
      { mood: false },
      { medications: false },
      { workouts: false },
      { illness: false },
      { mood: false, medications: false, workouts: false, illness: false },
      { timeline: false },
      { timeline: true },
    ];
    for (const modules of cases) {
      modulesRef.value = modules;
      const html = renderSSR(
        <DashboardHeader onQuickEntry={() => undefined} />,
        "en",
      );
      const picker = visibleCaptureKinds(
        { inSharedRecord: false, canWriteDomain: () => true },
        CAPTURE_KIND_ORDER,
        modules,
      );
      const label = {
        measurement: "Log measurement",
        medication: "Log medication intake",
        mood: "Log mood",
        symptom: "Log symptom",
        workout: "Log workout",
        lifeEvent: "Log life event",
      } as const;
      for (const kind of CAPTURE_KIND_ORDER) {
        expect(
          html.includes(label[kind]),
          `${kind} ${JSON.stringify(modules)}`,
        ).toBe(picker.includes(kind));
      }
      // Same order as the picker, so the two ways in never disagree on
      // where an entry sits.
      const positions = picker.map((kind) => html.indexOf(label[kind]));
      expect(positions).toEqual([...positions].sort((x, y) => x - y));
    }
  });
});
