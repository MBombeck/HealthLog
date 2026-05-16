import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<SettingsShell>` reads the active route from `usePathname()`. We stub
// next/navigation so the SSR test render works without an App-Router
// runtime. The mock reads `mockPathnameRef.value` at call-time (not at
// module-load) so each test can mutate the ref before rendering and the
// shell will see the updated path.
const mockPathnameRef = { value: "/settings/account" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathnameRef.value,
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  SETTINGS_SECTION_SLUGS,
  SETTINGS_SECTIONS,
  SettingsShell,
  isSettingsSectionSlug,
} from "../settings-shell";

function renderShell(props: {
  active?: (typeof SETTINGS_SECTION_SLUGS)[number];
  pathname?: string;
  locale?: "en" | "de";
}) {
  mockPathnameRef.value = props.pathname ?? "/settings/account";
  return renderToStaticMarkup(
    <I18nProvider initialLocale={props.locale ?? "en"}>
      <SettingsShell active={props.active}>
        <div>section body</div>
      </SettingsShell>
    </I18nProvider>,
  );
}

describe("SETTINGS_SECTION_SLUGS", () => {
  it("declares the eleven sections agreed for v1.4.25", () => {
    // Order matters — `generateStaticParams()` and the sidebar derive their
    // ordering from this constant, so a reorder is a behaviour change.
    // v1.4.3 split the dashboard panel: layout stays under `dashboard`,
    // per-metric overrides moved to their own `thresholds` slug so it's
    // a top-level entry in the settings nav.
    // v1.4.16 phase B7 added the consolidated `export` section between
    // `api` and `advanced` so every "give me my data out" path lives in
    // one place.
    // v1.4.25 W5e added `sources` between `thresholds` and `ai` so the
    // per-metric-class source-priority surface lives next to the other
    // analytics-shaping controls (thresholds → ranges; sources →
    // canonical source per metric).
    expect([...SETTINGS_SECTION_SLUGS]).toEqual([
      "account",
      "integrations",
      "notifications",
      "dashboard",
      "thresholds",
      "sources",
      "ai",
      "api",
      "export",
      "advanced",
      "about",
    ]);
  });

  it("`isSettingsSectionSlug` accepts known slugs and rejects others", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      expect(isSettingsSectionSlug(slug)).toBe(true);
    }
    expect(isSettingsSectionSlug("nope")).toBe(false);
    expect(isSettingsSectionSlug("")).toBe(false);
    expect(isSettingsSectionSlug("Account")).toBe(false); // case-sensitive
  });

  it("each section has a non-empty title key under settings.sections.<slug>", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.titleKey).toBe(`settings.sections.${section.slug}.title`);
    }
  });
});

describe("<SettingsShell>", () => {
  it("renders every navigable section link — once for the mobile strip and once for the desktop sidebar", () => {
    const html = renderShell({ active: "account" });
    // v1.4.33 IW7 — the `about` slug is alive as a route
    // (`/settings/about` still resolves and `generateStaticParams()`
    // still emits the page) but it is hidden from the in-shell nav.
    // The user-card dropdown owns the link now. Iterate the visible
    // sections list, not the slug list, when asserting on rendered
    // markup.
    const navigableSlugs = SETTINGS_SECTIONS.map((section) => section.slug);
    for (const slug of navigableSlugs) {
      const matches = html.match(new RegExp(`href="/settings/${slug}"`, "g"));
      // Two renders — mobile strip + desktop sidebar — guarantee the link
      // exists in both layouts. Tablet/desktop hide the strip with `md:`,
      // but the markup is always present so it's keyboard-discoverable
      // before media queries resolve.
      expect(matches?.length ?? 0).toBe(2);
    }
    // The hidden `about` slug must NOT appear in the in-shell nav.
    expect(html).not.toContain('href="/settings/about"');
  });

  it("links use the correct `/settings/<slug>` href — regression guard against typos", () => {
    const html = renderShell({ active: "account" });
    // Spot-check a couple of slugs that have historic anchor aliases (e.g.
    // `/settings#withings` → `/settings/integrations`) — they must NOT
    // sneak back in.
    expect(html).toContain('href="/settings/integrations"');
    expect(html).toContain('href="/settings/ai"');
    expect(html).not.toContain('href="/settings#');
    expect(html).not.toContain('href="/settings"');
  });

  it('marks the active section with aria-current="page" (and only that one)', () => {
    const html = renderShell({ active: "notifications" });
    // Both layouts emit the active link, so two `aria-current="page"`.
    const occurrences = html.match(/aria-current="page"/g);
    expect(occurrences?.length ?? 0).toBe(2);

    // And the active link is on the notifications href. Attribute order
    // in React SSR is alphabetic, so `aria-current` precedes `href` —
    // the regex deliberately doesn't pin order to stay robust against
    // future React renderer changes.
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/notifications"|<a\b[^>]*\bhref="\/settings\/notifications"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("derives the active slug from the current pathname when `active` is omitted", () => {
    const html = renderShell({ pathname: "/settings/api" });
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/api"|<a\b[^>]*\bhref="\/settings\/api"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("falls back to `account` when the pathname doesn't match a known slug", () => {
    const html = renderShell({ pathname: "/settings/totally-bogus" });
    const activeLinkRegex =
      /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/account"|<a\b[^>]*\bhref="\/settings\/account"[^>]*\baria-current="page"/g;
    expect(html.match(activeLinkRegex)?.length ?? 0).toBe(2);
  });

  it("resolves every section title via the i18n provider — English", () => {
    const html = renderShell({ active: "account", locale: "en" });
    expect(html).toContain("Account");
    expect(html).toContain("Integrations");
    // v1.4.33 IW7 — section renamed from "Notifications" to
    // "Notification channels" so it doesn't collide with the inbox at
    // `/notifications` ("Notification Center").
    expect(html).toContain("Notification channels");
    expect(html).toContain("Dashboard");
    expect(html).toContain("Insights");
    // The ampersand is HTML-escaped by React SSR — assert on the encoded
    // form so we don't accidentally match a parser that double-escapes.
    expect(html).toContain("API &amp; Tokens");
    // v1.4.16 phase B7: the consolidated Export section is a top-level
    // entry in the sidebar; the link must be present in both locales.
    expect(html).toContain('href="/settings/export"');
    expect(html).toContain("Advanced");
    // v1.4.33 IW7 — About is no longer in the settings nav; it lives
    // in the sidebar user-card dropdown. Route `/settings/about` is
    // still alive for direct links.
    expect(html).not.toContain('href="/settings/about"');
  });

  it("resolves every section title via the i18n provider — German", () => {
    const html = renderShell({ active: "account", locale: "de" });
    expect(html).toContain("Konto");
    expect(html).toContain("Integrationen");
    // v1.4.33 IW7 — section renamed from "Benachrichtigungen" to
    // "Benachrichtigungs-Kanäle" so it doesn't collide with the inbox at
    // `/notifications` ("Benachrichtigungs-Center").
    expect(html).toContain("Benachrichtigungs-Kanäle");
    // v1.4.3: the Settings sub-section formerly labelled "Übersicht" is now
    // "Dashboard" (matching the term users see in the main nav). The
    // per-metric overrides moved out into their own "Persönliche Zielwerte"
    // section, which is the new entry below the Dashboard one.
    expect(html).toContain("Dashboard");
    expect(html).toContain("Persönliche Zielwerte");
    // v1.4.33 IW7 — "KI-Auswertungen" renamed to "Auswertungen" per
    // the Marc-Voice rule (no "KI"/"AI" prefix in user-facing copy).
    expect(html).toContain("Auswertungen");
    // API & Tokens is identical in both locales (proper noun + ampersand)
    expect(html).toContain("API &amp; Tokens");
    expect(html).toContain("Erweitert");
    // v1.4.33 IW7 — "Über" (About) section removed from the in-shell
    // nav, folded into the sidebar user-card dropdown ("Über HealthLog").
    expect(html).not.toContain('href="/settings/about"');
  });

  it("does NOT surface the raw key when a translation resolves — guards against missing JSON entries", () => {
    const html = renderShell({ active: "account", locale: "en" });
    expect(html).not.toContain("settings.sections.");
  });

  it("mobile section strip uses `no-scrollbar` so the swipe area doesn't paint a horizontal scrollbar", () => {
    // The 10-section strip is wider than 393 CSS px, so without
    // `no-scrollbar` Chromium/WebKit paints an always-on horizontal
    // scrollbar at the top of every settings page. The class is
    // defined in `globals.css` and combines `scrollbar-width: none`
    // (Firefox) with `::-webkit-scrollbar { display: none }` (everyone
    // else) — scroll behaviour is preserved.
    const html = renderShell({ active: "account" });
    const nav = html.match(/<nav\b[^>]*md:hidden[^>]*>/);
    expect(nav).not.toBeNull();
    expect(nav![0]).toMatch(/\bno-scrollbar\b/);
    expect(nav![0]).toMatch(/\boverflow-x-auto\b/);
  });
});
