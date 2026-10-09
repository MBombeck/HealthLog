/**
 * v1.25.11 (#148) — the "Layout" hub (slug stays `layout`).
 *
 * The hub is a navigable index: it lists each module as a clickable row
 * (`<a href="/settings/layout/<id>">` with the localized title + description +
 * a chevron) and links to the module's own subpage. NOTHING is stacked inline.
 * These tests pin the hub contract — the rows link to the right subpages, the
 * module gate hides a disabled module's row, the never-gated rows always show,
 * and the titles resolve through i18n. The child section components are NOT
 * rendered by the hub, so they need no mocking here (each has its own test and
 * its own subpage).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mutable modules ref so each render can pick a different gate map.
const authRef: { modules?: Record<string, boolean> } = {};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "t", role: "USER", modules: authRef.modules },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// The hub renders post-mount fail-open gating via `useMounted()`. Under SSR
// (`renderToStaticMarkup`) `useMounted()` returns `false`, which would render
// EVERY row regardless of the gate map. Force it to the hydrated (`true`)
// snapshot so these tests exercise the real module filter.
vi.mock("@/hooks/use-mounted", () => ({
  useMounted: () => true,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { LayoutSection } from "../layout-section";

function render(modules?: Record<string, boolean>, locale: "en" | "de" = "en") {
  authRef.modules = modules;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LayoutSection />
    </I18nProvider>,
  );
}

describe("<LayoutSection> hub", () => {
  it("lists every module as a clickable row linking to its subpage", () => {
    const html = render(undefined);
    for (const id of [
      "dashboard",
      "insights",
      "medications",
      "mood",
      "labs",
      "illness",
      "vorsorge",
    ]) {
      expect(html).toContain(`href="/settings/layout/${id}"`);
    }
  });

  it("hides a module's row when that module is disabled", () => {
    const html = render({ medications: false, labs: false });
    expect(html).not.toContain('href="/settings/layout/medications"');
    expect(html).not.toContain('href="/settings/layout/labs"');
    // Other modules unaffected; Vorsorge is never gated.
    expect(html).toContain('href="/settings/layout/mood"');
    expect(html).toContain('href="/settings/layout/vorsorge"');
  });

  it("always lists dashboard, insights, and vorsorge (no module gate)", () => {
    const html = render({
      medications: false,
      mood: false,
      labs: false,
      illness: false,
    });
    expect(html).toContain('href="/settings/layout/dashboard"');
    expect(html).toContain('href="/settings/layout/insights"');
    expect(html).toContain('href="/settings/layout/vorsorge"');
    expect(html).not.toContain('href="/settings/layout/mood"');
  });

  it("resolves its row titles via i18n (no raw keys leak)", () => {
    const html = render();
    expect(html).toContain("Medications");
    expect(html).toContain("Labs");
    expect(html).not.toContain("settings.sections.layout.");
  });

  it("resolves the titles in German too", () => {
    const html = render(undefined, "de");
    expect(html).toContain("Medikamente");
    expect(html).toContain("Labor");
    expect(html).not.toContain("settings.sections.layout.");
  });
});
