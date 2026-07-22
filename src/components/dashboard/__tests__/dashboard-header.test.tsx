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
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

const moduleGate = vi.hoisted(() => ({ nutrientsEnabled: true }));

vi.mock("@/hooks/use-module-enabled", () => ({
  useModuleEnabled: (moduleKey: string) =>
    moduleKey === "nutrients" ? moduleGate.nutrientsEnabled : true,
}));

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
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { username: "tester", timezone: "Europe/Berlin" },
  }),
}));

import { DashboardHeader } from "../dashboard-header";

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

describe("<DashboardHeader> — nutrients module gate", () => {
  it("hides only the water quick-add item when nutrients are disabled", () => {
    moduleGate.nutrientsEnabled = false;

    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} />,
      "en",
    );

    expect(html).not.toContain("Log water");
    expect(html).toContain("Log measurement");
    expect(html).toContain("Log mood");
    expect(html).toContain("Log medication intake");
  });

  it("keeps the water quick-add item available when nutrients are enabled", () => {
    moduleGate.nutrientsEnabled = true;

    const html = renderSSR(
      <DashboardHeader onQuickEntry={() => undefined} />,
      "en",
    );

    expect(html).toContain("Log water");
  });
});
