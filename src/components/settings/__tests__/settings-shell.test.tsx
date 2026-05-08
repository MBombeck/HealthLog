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
  it("declares exactly the eight sections agreed for v1.4", () => {
    // Order matters — `generateStaticParams()` and the sidebar derive their
    // ordering from this constant, so a reorder is a behaviour change.
    expect([...SETTINGS_SECTION_SLUGS]).toEqual([
      "account",
      "integrations",
      "notifications",
      "dashboard",
      "ai",
      "api",
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
  it("renders all eight section links — once for the mobile strip and once for the desktop sidebar", () => {
    const html = renderShell({ active: "account" });
    for (const slug of SETTINGS_SECTION_SLUGS) {
      const matches = html.match(new RegExp(`href="/settings/${slug}"`, "g"));
      // Two renders — mobile strip + desktop sidebar — guarantee the link
      // exists in both layouts. Tablet/desktop hide the strip with `md:`,
      // but the markup is always present so it's keyboard-discoverable
      // before media queries resolve.
      expect(matches?.length ?? 0).toBe(2);
    }
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
    expect(html).toContain("Notifications");
    expect(html).toContain("Dashboard");
    expect(html).toContain("AI Insights");
    // The ampersand is HTML-escaped by React SSR — assert on the encoded
    // form so we don't accidentally match a parser that double-escapes.
    expect(html).toContain("API &amp; Tokens");
    expect(html).toContain("Advanced");
    expect(html).toContain("About");
  });

  it("resolves every section title via the i18n provider — German", () => {
    const html = renderShell({ active: "account", locale: "de" });
    expect(html).toContain("Konto");
    expect(html).toContain("Integrationen");
    expect(html).toContain("Benachrichtigungen");
    expect(html).toContain("Übersicht");
    expect(html).toContain("KI-Auswertungen");
    // API & Tokens is identical in both locales (proper noun + ampersand)
    expect(html).toContain("API &amp; Tokens");
    expect(html).toContain("Erweitert");
    expect(html).toContain("Über");
  });

  it("does NOT surface the raw key when a translation resolves — guards against missing JSON entries", () => {
    const html = renderShell({ active: "account", locale: "en" });
    expect(html).not.toContain("settings.sections.");
  });
});
