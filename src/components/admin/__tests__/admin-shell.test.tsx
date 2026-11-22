import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `<AdminShell>` mirrors `<SettingsShell>`: a sticky desktop sidebar
 * plus a horizontal section strip on mobile. With 13 sections the strip
 * is always wider than a 393 CSS-px (Pixel-5) viewport, so v1.4.18
 * hid the strip's scrollbar (today through `SubNavRow`) — Chromium /
 * WebKit otherwise paint an always-on horizontal scrollbar at the top
 * of every admin page, which the maintainer kept mis-attributing to the
 * `/admin/api-tokens` table card right below it. Three previous fix
 * attempts (v1.4.15 column-hide, v1.4.16 mobile-card-list, then this
 * one) all targeted the table while the bar lived in the shell.
 *
 * This suite locks in the shell-level fix so a future refactor can't
 * silently regress it.
 */

const mockPathnameRef = { value: "/admin/system-status" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathnameRef.value,
}));

// The shell gates its own frame on the confirmed ADMIN role — a
// non-admin (or a still-loading auth state) must not see the section
// nav while AuthShell's redirect effect is catching up.
const mockUserRef = {
  value: { role: "ADMIN", username: "op" } as {
    role: string;
    username: string;
  } | null,
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mockUserRef.value }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ADMIN_SECTION_SLUGS } from "../section-slugs";
import { ADMIN_SECTIONS, AdminShell } from "../admin-shell";

function renderShell(props: {
  active?: (typeof ADMIN_SECTIONS)[number]["slug"];
  pathname?: string;
  user?: { role: string; username: string } | null;
}) {
  mockPathnameRef.value = props.pathname ?? "/admin/system-status";
  mockUserRef.value =
    props.user === undefined ? { role: "ADMIN", username: "op" } : props.user;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AdminShell active={props.active}>
        <div>section body</div>
      </AdminShell>
    </I18nProvider>,
  );
}

describe("<AdminShell>", () => {
  it("groups operational domains with non-interactive desktop headings and quiet mobile separators", () => {
    const html = renderShell({ active: "system-status" });
    const groupHeaders =
      html.match(/data-slot="admin-nav-group"[^>]*data-group="[^"]+"/g) ?? [];
    const separators =
      html.match(/data-slot="admin-nav-group-separator"/g) ?? [];

    expect(groupHeaders.length).toBeGreaterThanOrEqual(4);
    expect(new Set(groupHeaders).size).toBe(groupHeaders.length);
    expect(separators).toHaveLength(groupHeaders.length - 1);
  });

  it("starts the sticky desktop sidebar on the heading row", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "components", "admin", "admin-shell.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /<aside[\s\S]*?md:sticky[\s\S]*?md:col-start-1[\s\S]*?md:row-start-1/,
    );
    expect(source).not.toMatch(/<aside[\s\S]*?md:row-start-2/);
  });

  it("renders every section link in both the mobile strip and the desktop sidebar", () => {
    const html = renderShell({ active: "system-status" });
    for (const section of ADMIN_SECTIONS) {
      const matches = html.match(
        new RegExp(`href="/admin/${section.slug}"`, "g"),
      );
      // Two renders — mobile strip + desktop sidebar.
      expect(matches?.length ?? 0).toBe(2);
    }
  });

  it("mobile section strip paints no horizontal scrollbar", () => {
    // The 13-section strip is ~1700 CSS px wide. Without a hidden
    // scrollbar Chromium/WebKit paint an always-on horizontal bar at the
    // top of every admin page. The strip is the app's `SubNavRow` now,
    // which hides it (`[scrollbar-width:none]` plus the WebKit
    // pseudo-element) and keeps `overflow-x-auto`, so swipe and
    // keyboard-arrow scrolling continue to work.
    const html = renderShell({ active: "api-tokens" });
    const row = html.match(/<div\b[^>]*data-slot="sub-nav-row"[^>]*>/);
    expect(row).not.toBeNull();
    expect(row![0]).toMatch(/\[scrollbar-width:none\]/);
    expect(row![0]).toMatch(/\[&amp;::-webkit-scrollbar\]:hidden/);
    expect(row![0]).toMatch(/\boverflow-x-auto\b/);
  });

  it('marks the active section with aria-current="page" in both layouts', () => {
    const html = renderShell({ active: "api-tokens" });
    const occurrences = html.match(/aria-current="page"/g);
    // Two layouts (mobile strip + desktop sidebar) → two matches.
    expect(occurrences?.length ?? 0).toBe(2);
    // Active link is on the api-tokens href in both renders.
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/admin\/api-tokens"|<a\b[^>]*\bhref="\/admin\/api-tokens"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("derives the active slug from the current pathname when `active` is omitted", () => {
    const html = renderShell({ pathname: "/admin/api-tokens" });
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/admin\/api-tokens"|<a\b[^>]*\bhref="\/admin\/api-tokens"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("ADMIN_SECTIONS covers every slug in ADMIN_SECTION_SLUGS (drift guard)", () => {
    // Hand-maintained `ADMIN_SECTIONS` (sidebar nav) used to drift from
    // `ADMIN_SECTION_SLUGS` (slug list / generateStaticParams source of
    // truth). v1.4.23 W6 design review CRIT C1 caught coach-feedback
    // missing from the nav even though the slug + page + i18n shipped.
    const navSlugs = new Set(ADMIN_SECTIONS.map((s) => s.slug));
    for (const slug of ADMIN_SECTION_SLUGS) {
      expect(
        navSlugs.has(slug),
        `ADMIN_SECTIONS missing nav entry for ${slug}`,
      ).toBe(true);
    }
  });

  it("every /admin/[section] page slug has a matching ADMIN_SECTIONS nav entry", () => {
    // Walks the filesystem so any new admin section page added under
    // ADMIN_SECTION_SLUGS without a nav entry fails this test. Since
    // /admin/[section] is a single dynamic route, the slug source of
    // truth is the union of `ADMIN_SECTION_SLUGS` and the renderer's
    // exhaustive switch — both have to know about the slug for the
    // page to render.
    const renderer = readdirSync(
      join(process.cwd(), "src/app/admin/[section]"),
    );
    expect(renderer).toContain("page.tsx");
    expect(renderer).toContain("renderer.tsx");
    const navSlugs = new Set(ADMIN_SECTIONS.map((s) => s.slug));
    for (const slug of ADMIN_SECTION_SLUGS) {
      expect(
        navSlugs.has(slug),
        `slug ${slug} registered in ADMIN_SECTION_SLUGS but missing from ADMIN_SECTIONS`,
      ).toBe(true);
    }
    // Touch statSync so the import isn't dead — and so the
    // filesystem read isn't accidentally noop'd by a future tree-
    // shaker pass.
    expect(
      statSync(
        join(process.cwd(), "src/app/admin/[section]/page.tsx"),
      ).isFile(),
    ).toBe(true);
  });

  it("renders neither frame nor children until the role is confirmed ADMIN", () => {
    // Non-admin: no section nav, no children — the frame must not
    // flash while AuthShell's redirect effect moves the user away.
    const asUser = renderShell({
      active: "system-status",
      user: { role: "USER", username: "u" },
    });
    expect(asUser).toBe("");
    // Auth still in flight (user === null): same blank render.
    const loading = renderShell({ active: "system-status", user: null });
    expect(loading).toBe("");
    // Admin: frame + children render.
    const asAdmin = renderShell({ active: "system-status" });
    expect(asAdmin).toContain("section body");
  });

  it("does NOT mark any section active on `/admin` overview", () => {
    const html = renderShell({ pathname: "/admin" });
    // Overview-link only — no section gets aria-current.
    const sectionActive = html.match(
      /aria-current="page"[^>]*\bhref="\/admin\/[^"]+"/g,
    );
    expect(sectionActive?.length ?? 0).toBe(0);
  });
});
