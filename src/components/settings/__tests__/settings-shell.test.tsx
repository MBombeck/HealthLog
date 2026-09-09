import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `<SettingsShell>` reads the active route from `usePathname()`. We stub
// next/navigation so the SSR test render works without an App-Router
// runtime. The mock reads `mockPathnameRef.value` at call-time (not at
// module-load) so each test can mutate the ref before rendering and the
// shell will see the updated path.
const mockPathnameRef = { value: "/settings/account" };
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathnameRef.value,
}));

// v1.18.0 (S5) — the shell module-gates per-submodule nav entries off
// `useAuth().user.modules`. The mock returns a user whose modules map is
// mutated per-test via `mockModulesRef`. `undefined` (the default) means
// every gate fails open, so all entries render.
const mockModulesRef: { value: Record<string, boolean> | undefined } = {
  value: undefined,
};
// v1.37.0 — the shell also filters by which record the browser is inside.
// Unlike the module gate above, that filter is NOT hydration-deferred: the
// server has already resolved which record is active, so it applies on the SSR
// pass and is assertable from a static render.
const mockActiveRecordRef: {
  value: { recordKind: "managed" | "shared"; level: string } | null;
} = { value: null };
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: "USER",
      modules: mockModulesRef.value,
      accountAccess: mockActiveRecordRef.value
        ? {
            accounts: [mockActiveRecordRef.value],
            active: mockActiveRecordRef.value,
            canSwitch: true,
          }
        : null,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
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
  modules?: Record<string, boolean>;
  activeRecord?: { recordKind: "managed" | "shared"; level: string } | null;
}) {
  mockPathnameRef.value = props.pathname ?? "/settings/account";
  mockModulesRef.value = props.modules;
  mockActiveRecordRef.value = props.activeRecord ?? null;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={props.locale ?? "en"}>
      <SettingsShell active={props.active}>
        <div>section body</div>
      </SettingsShell>
    </I18nProvider>,
  );
}

describe("SETTINGS_SECTION_SLUGS", () => {
  it("declares every section", () => {
    // Order matters — `generateStaticParams()` and the sidebar derive their
    // ordering from this constant, so a reorder is a behaviour change.
    // v1.4.3 split the dashboard panel: layout stays under `dashboard`,
    // per-metric overrides moved to their own `thresholds` slug so it's
    // a top-level entry in the settings nav.
    // v1.4.16 phase B7 added the consolidated `export` section between
    // `api` and `advanced` so every "give me my data out" path lives in
    // one place.
    // v1.4.25 W5e added `sources` between `thresholds` and `ai`; v1.4.34
    // IW-D merged it into `thresholds`; v1.8.7.1 split it back out.
    // v1.18.0 (S3) — `sources` is no longer a standalone slug: source
    // priority folded into Settings → Integrations as the "Sources"
    // sub-tab. `/settings/sources` 301-redirects to `/settings/integrations`.
    // v1.15.18 — `insights` sits between `dashboard` and `thresholds`: the
    // overview-arrange + pill-sort customise surface for `/insights`.
    // v1.16.10 — `medications` sits between `insights` and `thresholds`:
    // the view-preference + manual-order customise surface for
    // `/medications`, reached from the page header's Settings2 glyph.
    // v1.17 — `mood` sits between `medications` and `thresholds`: the
    // mood-tag management surface (groups, custom tags, hide/archive,
    // picker order), reached from the /mood page header's wrench glyph.
    // v1.17.1 (F-2) — `layout` is the one "Layout & Personalization" home
    // and sits after `notifications`. The four personalization editor
    // slugs (`dashboard`, `insights`, `medications`, `mood`) keep their
    // routes so deep links resolve, but they are reached through the
    // Layout hub instead of four standalone nav entries.
    // v1.18.0 (S4) — the standalone `reminders` hub is gone; reminder TYPES
    // live in `notifications`, each gated on its module. `/settings/reminders`
    // 301-redirects to `/settings/notifications`.
    // v1.18.0 — `modules` ("Was du trackst") sits right after `account` as
    // the single front door for enabling/disabling secondary domains.
    // v1.18.0 (S5) — `gesundheitsakte` (the full health-record export) lifts
    // out of Export & Import into its own top-level entry, before `export`;
    // `coach` gathers the Coach preference cards out of the AI section and
    // sits right after `ai`.
    // v1.18.1 (D4) — `channels` + `sources` split out of the Integrations
    // sub-tabs into their own left-side entries, right after `integrations`.
    // v1.25.3 — `channels` folded back into Notifications as an in-page group;
    // `/settings/channels` 301-redirects to `/settings/notifications#channels`.
    // `sources` keeps its own entry.
    // v1.18.7 — `labs`, `illness`, `vorsorge` move into the shell as
    // first-class sections, right after `mood` (the three were standalone
    // `ModuleSettingsFrame` pages).
    // v1.18.7 — `sharing` (clinician share links) sits directly after
    // `gesundheitsakte`, before `export`: minting a read-only link to the
    // health record belongs next to the health-record export.
    expect([...SETTINGS_SECTION_SLUGS]).toEqual([
      "account",
      "security",
      // v1.36.0 — account sharing: who may open this record, and whose this
      // account may open. Beside `security`, and distinct from the `sharing`
      // slug further down (the clinician share LINK).
      "access",
      "modules",
      "integrations",
      "sources",
      "notifications",
      // v1.37.19 — the per-module personalization slugs (dashboard /
      // insights / medications / mood / labs / illness / vorsorge) and
      // `sharing` left the list: their URLs are owned by the permanent
      // redirects in next.config.ts, so the dynamic route could never
      // serve them.
      "layout",
      // v1.25 (W-ENV) — Environment (home location, travel overrides, backfill),
      // module-gated on the opt-in `environment` module.
      "environment",
      // v1.25 (W-RECORDS) — Anamnese (allergies + family history), always shown.
      "anamnesis",
      // v1.35.0 — the Health Score composition surface.
      "score",
      "thresholds",
      "ai",
      "coach",
      "api",
      "mcp",
      "gesundheitsakte",
      "export",
      "advanced",
      // v1.23 — "Data & Privacy" assembles the export / deletion / retention /
      // encryption / session / activity pieces into one pane, after `advanced`.
      "privacy",
      "about",
    ]);
  });

  it("`isSettingsSectionSlug` accepts known slugs and rejects others", () => {
    for (const slug of SETTINGS_SECTION_SLUGS) {
      expect(isSettingsSectionSlug(slug)).toBe(true);
    }
    expect(isSettingsSectionSlug("nope")).toBe(false);
    // The redirect-shadowed module slugs are no longer sections.
    expect(isSettingsSectionSlug("dashboard")).toBe(false);
    expect(isSettingsSectionSlug("sharing")).toBe(false);
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
  it("keeps meaningful non-interactive desktop groups while the mobile strip uses quiet separators", () => {
    const html = renderShell({ active: "account" });
    for (const label of [
      "Account",
      "Your data",
      "Display",
      "Health profile",
      "AI",
      "Connectivity",
      "System",
    ]) {
      expect(html).toContain(`>${label}</li>`);
    }
    // Seven groups produce six quiet separators in the mobile strip.
    expect(
      html.match(/aria-hidden="true"/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(6);
  });

  it("starts the sticky desktop sidebar on the heading row", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src",
        "components",
        "settings",
        "settings-shell.tsx",
      ),
      "utf8",
    );

    expect(source).toMatch(
      /<aside[\s\S]*?md:sticky[\s\S]*?md:col-start-1[\s\S]*?md:row-start-1/,
    );
    expect(source).not.toMatch(/<aside[\s\S]*?md:row-start-2/);
  });

  it("renders every navigable section link — once for the mobile strip and once for the desktop sidebar", () => {
    const html = renderShell({ active: "account" });
    // Every slug — including `about`, which returned to the shell nav
    // as the last entry after living dropdown-only since v1.4.33 IW7 —
    // renders in both layouts.
    const navigableSlugs = SETTINGS_SECTIONS.map((section) => section.slug);
    for (const slug of navigableSlugs) {
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

  it("highlights the Layout hub when on a Layout child editor (v1.17.1 F-2)", () => {
    // On `/settings/dashboard` (a Layout child reached through the hub) the
    // Layout nav entry must read active even though Dashboard has no nav
    // entry of its own. Both layouts emit the active link → two matches.
    for (const child of ["/settings/dashboard", "/settings/insights"]) {
      const html = renderShell({ pathname: child });
      const layoutActive =
        /<a\b[^>]*\baria-current="page"[^>]*\bhref="\/settings\/layout"|<a\b[^>]*\bhref="\/settings\/layout"[^>]*\baria-current="page"/g;
      expect(html.match(layoutActive)?.length ?? 0).toBe(2);
    }
  });

  // v1.37.19 — the Layout children left `SETTINGS_SECTION_SLUGS`, so no
  // page can pass one as the `active` override anymore; the pathname-based
  // case above is the remaining (defensive) mapping.

  it("no longer surfaces the per-module nav entries (folded into Darstellung, v1.25.7)", () => {
    // v1.25.7 — Medikamente / Stimmung / Labor / Krankheit / Vorsorge are no
    // longer standalone left-nav entries: their settings render inline inside
    // the "Darstellung" hub, gated on the same module key there. The shell
    // never emits a sidebar link for them regardless of the module map.
    for (const slug of ["medications", "mood", "labs", "illness", "vorsorge"]) {
      expect(renderShell({ active: "account" })).not.toContain(
        `href="/settings/${slug}"`,
      );
      // Even with the module explicitly enabled, no sidebar entry appears.
      expect(
        renderShell({ active: "account", modules: { [slug]: true } }),
      ).not.toContain(`href="/settings/${slug}"`);
    }
  });

  it("no longer surfaces the Sharing nav entry (folded into Gesundheitsakte, v1.25.7)", () => {
    expect(renderShell({ active: "account" })).not.toContain(
      'href="/settings/sharing"',
    );
  });

  it("surfaces the Coach entry on the fail-open default (v1.18.0 S5)", () => {
    // coach undefined → entry shown.
    expect(renderShell({ active: "account" })).toContain(
      'href="/settings/coach"',
    );
  });

  it("renders the full fail-open nav on the server pass, even for a disabled module (v1.25.9)", () => {
    // v1.25.9 — the module filter must NOT run during SSR / the first client
    // paint. `useAuth().user.modules` resolves at different times on the
    // server-rendered pass and the hydrating client pass, so filtering in the
    // SSR markup produced a different nav `<li>` count than the client's first
    // render — a React #418 hydration mismatch that regenerated the whole tree
    // and left every settings control non-interactive (dead disclosure /
    // download buttons). The shell now emits the full fail-open list on both
    // the server pass and the first client paint, and applies the module
    // filter once, after mount. So a disabled module's entry is STILL present
    // in the SSR markup here; its client-side removal after hydration is
    // covered by the e2e suite (settings pages must stay interactive).
    const ssr = renderShell({ active: "account", modules: { coach: false } });
    expect(ssr).toContain('href="/settings/coach"');
  });

  it("always surfaces the Health-record entry, regardless of `doctorReport` (v1.18.6.1)", () => {
    // The health-record (PDF / FHIR) entry is a flagship export capability
    // and is no longer nav-gated: a default/unset modules map shows it, and
    // even an explicit `doctorReport: false` keeps the Settings entry-point
    // reachable. The server-side `/api/export/health-record` route remains
    // the hard enforcement of the opt-out.
    expect(renderShell({ active: "account" })).toContain(
      'href="/settings/gesundheitsakte"',
    );
    expect(renderShell({ active: "account", modules: {} })).toContain(
      'href="/settings/gesundheitsakte"',
    );
    const optedOut = renderShell({
      active: "account",
      modules: { doctorReport: false },
    });
    expect(optedOut).toContain('href="/settings/gesundheitsakte"');
  });

  describe("inside somebody else's record", () => {
    /**
     * #939 — a guardian could turn a module off for the profile they look
     * after and had to find the page by URL to do it. The section is
     * classified `managed-guardian`, which is what the shell offers a managed
     * record; asserting it here is what stops a future narrowing of the filter
     * from silently taking the destination away again.
     */
    it("offers the Modules destination to a guardian on a managed record", () => {
      const html = renderShell({
        active: "account",
        activeRecord: { recordKind: "managed", level: "manage" },
      });
      expect(html).toContain('href="/settings/modules"');
      // Its own configuration is not the record's, and stays away.
      expect(html).not.toContain('href="/settings/security"');
    });

    it("does not offer it to an adult delegate holding MANAGE", () => {
      // A delegate manages somebody's health record, not their account:
      // modules, thresholds and notification routing stay with the owner.
      // Integrations remains status-only on a managed record, and unreachable
      // here — both are `managed-guardian`, which an adult record never opens.
      const html = renderShell({
        active: "account",
        activeRecord: { recordKind: "shared", level: "manage" },
      });
      expect(html).not.toContain('href="/settings/modules"');
      expect(html).not.toContain('href="/settings/integrations"');
      expect(html).toContain('href="/settings/anamnesis"');
    });
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
    // v1.9.0 — the section label is back to the shorter "Notifications"
    // (single-line; the longer "Notification channels" wrapped). The
    // `/notifications` inbox now shares the "Notifications" label.
    expect(html).toContain("Notifications");
    // v1.17.1 (F-2) — the view/arrangement editors are reached through one hub
    // entry (route stays `/settings/layout`). v1.25.3 — the hub is renamed
    // "Appearance" (DE "Darstellung") and indexes every module's view surface;
    // the route is unchanged.
    expect(html).toContain('href="/settings/layout"');
    expect(html).toContain(">Appearance</a>");
    // v1.25.3 — Channels folded into Notifications, so it is no longer a
    // left-side entry; Sources keeps its own.
    expect(html).not.toContain('href="/settings/channels"');
    expect(html).toContain('href="/settings/sources"');
    // v1.25.7 — Medikamente / Stimmung (and Labor / Krankheit / Vorsorge)
    // folded into "Darstellung" as inline sections, so they no longer have a
    // standalone left-nav entry.
    expect(html).not.toContain('href="/settings/medications"');
    expect(html).not.toContain('href="/settings/mood"');
    // v1.25.7 — Sharing folded into the Gesundheitsakte section.
    expect(html).not.toContain('href="/settings/sharing"');
    // The ampersand is HTML-escaped by React SSR — assert on the encoded
    // form so we don't accidentally match a parser that double-escapes.
    expect(html).toContain("API &amp; Tokens");
    // v1.18.0 (S5) — the health record is its own top-level entry.
    expect(html).toContain('href="/settings/gesundheitsakte"');
    expect(html).toContain("Health record");
    // v1.4.16 phase B7: the consolidated Export section is a top-level
    // entry in the sidebar; the link must be present in both locales.
    expect(html).toContain('href="/settings/export"');
    expect(html).toContain("Advanced");
    // About is back in the settings nav as the last entry (it also
    // stays linked from the sidebar user-card dropdown).
    expect(html).toContain('href="/settings/about"');
    // v1.18.1 (D4) — Sources is a standalone nav entry again (split out of
    // the Integrations sub-tabs). Targets keeps its own entry.
    expect(html).toContain('href="/settings/thresholds"');
    expect(html).toContain('href="/settings/sources"');
    expect(html).toContain("Targets");
  });

  it("resolves every section title via the i18n provider — German", () => {
    const html = renderShell({ active: "account", locale: "de" });
    expect(html).toContain("Konto");
    expect(html).toContain("Integrationen");
    // v1.9.0 — back to the shorter "Benachrichtigungen" (single-line; the
    // compound "Benachrichtigungs-Kanäle" wrapped). The `/notifications`
    // inbox now shares the "Benachrichtigungen" label.
    expect(html).toContain("Benachrichtigungen");
    // v1.17.1 (F-2) — the view editors are reached through one hub entry
    // (route stays `/settings/layout`). v1.25.3 — the German nav label reads
    // "Darstellung" (Appearance) to match the renamed hub.
    expect(html).toContain('href="/settings/layout"');
    expect(html).toContain(">Darstellung</a>");
    // v1.25.3 — Channels ("Kanäle") folded into Notifications; Sources keeps
    // its own left-side entry.
    expect(html).not.toContain('href="/settings/channels"');
    // v1.25.7 — Medikamente + Stimmung folded into "Darstellung", so they no
    // longer have their own nav entries.
    expect(html).not.toContain('href="/settings/medications"');
    expect(html).not.toContain('href="/settings/mood"');
    // Targets keeps its German nav entry ("Zielwerte").
    expect(html).toContain("Zielwerte");
    // v1.18.6 (W9) — the AI section is named "KI-Anbieter" in German: the
    // page is about the provider / BYOK, not an "Auswertung".
    expect(html).toContain("KI-Anbieter");
    // API & Tokens is identical in both locales (proper noun + ampersand)
    expect(html).toContain("API &amp; Tokens");
    expect(html).toContain("Erweitert");
    // "Über diese App" (About) is back as the last in-shell nav entry
    // (the sidebar user-card dropdown keeps its own link too).
    expect(html).toContain('href="/settings/about"');
    // v1.18.1 (D4) — Sources is a standalone nav entry again.
    expect(html).toContain('href="/settings/sources"');
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
