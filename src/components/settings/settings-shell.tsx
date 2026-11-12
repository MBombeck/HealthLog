"use client";

/**
 * `<SettingsShell>` — sidebar + main column shell for the v1.4 settings split.
 *
 * Each section lives at its own route (`/settings/[section]/page.tsx`) and
 * mounts inside this shell. The shell owns nothing but navigation: the active
 * section is read from the route, the section heading + content are rendered
 * by the page itself.
 *
 * Mobile-first per `docs/ui-guidelines.md`:
 *   - <md: one button naming the current section opens a bottom sheet with
 *     every section under its group (`SettingsMobileNav`).
 *   - >=md: sticky 220px sidebar, grouped the same way, beside a content
 *     column with `max-w-screen-xl`.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Blocks,
  Bot,
  ClipboardList,
  CloudSun,
  Download,
  FileHeart,
  Gauge,
  Info,
  KeyRound,
  Plug,
  Layers,
  Link2,
  Lock,
  Palette,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  User,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { SUB_SHELL_GRID_FLOOR } from "@/components/layout/shell-metrics";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { isSettingsDestinationListedForRecord } from "@/lib/record-settings/classification";
import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
} from "@/lib/settings/section-slugs";
import { SettingsHubBackLink } from "./settings-hub-back-link";
import { SettingsMobileNav } from "./settings-mobile-nav";
import { SettingsAnchorForward } from "./settings-anchor-forward";

// Re-export so existing call-sites importing from this module keep working.
// New server-side call-sites (e.g. `generateStaticParams()`) should import
// from `./section-slugs` directly, since this file is `"use client"` and
// values exported from a client module become unusable proxies on the
// server. (Discovered the hard way: `SETTINGS_SECTION_SLUGS.map(...)` in
// `generateStaticParams()` blows up at build time when imported through a
// client boundary.)
export {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
};

/**
 * The nine groups every section belongs to, in render order. The sidebar
 * paints a non-interactive header above the first visible entry of each, and
 * the phone's section sheet uses the same headers.
 *
 * Account: who you are and who can get in. Tracking: what the app records.
 * Arrangement: order and view only. Notifications: every reminder. Health
 * profile: what describes you. AI and Connections: what talks to the outside.
 * Data: export, import, privacy and deletion. System: previews and about.
 */
export type SettingsSectionGroup =
  | "account"
  | "tracking"
  | "arrangement"
  | "notifications"
  | "healthProfile"
  | "ai"
  | "connections"
  | "data"
  | "system";

/** i18n key for each group's header label, under `settings.shell.groups.*`. */
export const SETTINGS_SECTION_GROUP_LABEL_KEYS: Record<
  SettingsSectionGroup,
  string
> = {
  account: "settings.shell.groups.account",
  tracking: "settings.shell.groups.tracking",
  arrangement: "settings.shell.groups.arrangement",
  notifications: "settings.shell.groups.notifications",
  healthProfile: "settings.shell.groups.healthProfile",
  ai: "settings.shell.groups.ai",
  connections: "settings.shell.groups.connections",
  data: "settings.shell.groups.data",
  system: "settings.shell.groups.system",
};

interface SettingsSection {
  slug: SettingsSectionSlug;
  /** i18n key under `settings.sections.<slug>.title`. */
  titleKey: string;
  icon: LucideIcon;
  /** Which sidebar group this entry renders under. */
  group: SettingsSectionGroup;
}

/**
 * Source of truth for the section list that the settings shell renders in
 * its sidebar and in the phone's section sheet, pre-ordered by group.
 *
 * `SETTINGS_SECTION_SLUGS` (`section-slugs.ts`) is the route registry and
 * keeps its own order (it drives `generateStaticParams()` and the record
 * landing order); this list decides only where each entry is shown. Every
 * slug a person ever reached keeps its URL: a section that moved between
 * groups moved here, not in the route.
 *
 * The card titles people cite stay as they are: "Export & import",
 * "Integrations", "API tokens", "Shared access", "Modules".
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // ── Account ── profile and display, sign-in and sessions, who else may open
  // this record.
  {
    slug: "account",
    titleKey: "settings.sections.account.title",
    icon: User,
    group: "account",
  },
  // Second factors, passkeys, password, and (since v1.44) the active
  // sessions, trusted devices and security activity that used to sit on the
  // privacy page.
  {
    slug: "security",
    titleKey: "settings.sections.security.title",
    icon: ShieldCheck,
    group: "account",
  },
  {
    slug: "access",
    titleKey: "settings.sections.access.title",
    icon: UsersRound,
    group: "account",
  },
  // ── Tracking ── which areas are recorded; each module's own settings
  // (biomarkers, mood tags, injection sites) open from its row.
  {
    slug: "modules",
    titleKey: "settings.sections.modules.title",
    icon: Blocks,
    group: "tracking",
  },
  // ── Arrangement ── order and view, nothing else. The slug stays `layout`.
  {
    slug: "layout",
    titleKey: "settings.sections.layout.title",
    icon: Palette,
    group: "arrangement",
  },
  // ── Notifications ── every reminder kind, or the link to where it lives.
  {
    slug: "notifications",
    titleKey: "settings.sections.notifications.title",
    icon: Bell,
    group: "notifications",
  },
  // ── Health profile ──
  {
    slug: "score",
    titleKey: "settings.sections.score.title",
    icon: Gauge,
    group: "healthProfile",
  },
  {
    slug: "thresholds",
    titleKey: "settings.sections.thresholds.title",
    icon: SlidersHorizontal,
    group: "healthProfile",
  },
  {
    slug: "anamnesis",
    titleKey: "settings.sections.anamnesis.title",
    icon: ClipboardList,
    group: "healthProfile",
  },
  // Module-gated on the opt-in `environment` module.
  {
    slug: "environment",
    titleKey: "settings.sections.environment.title",
    icon: CloudSun,
    group: "healthProfile",
  },
  // ── AI ──
  {
    slug: "ai",
    titleKey: "settings.sections.ai.title",
    icon: Sparkles,
    group: "ai",
  },
  // Module-gated on the coach module (`settings:coach`).
  {
    slug: "coach",
    titleKey: "settings.sections.coach.title",
    icon: Bot,
    group: "ai",
  },
  // ── Connections ── data coming in (integrations, which source wins) and
  // programmatic access going out (tokens, the MCP connector).
  {
    slug: "integrations",
    titleKey: "settings.sections.integrations.title",
    icon: Link2,
    group: "connections",
  },
  {
    slug: "sources",
    titleKey: "settings.sections.sources.title",
    icon: Layers,
    group: "connections",
  },
  {
    slug: "api",
    titleKey: "settings.sections.api.title",
    icon: KeyRound,
    group: "connections",
  },
  // Not module-gated: the page shows the connector's state and links to the
  // one switch in Modules.
  {
    slug: "mcp",
    titleKey: "settings.sections.mcp.title",
    icon: Plug,
    group: "connections",
  },
  // ── Data ── getting data out and in, what is stored, and deleting it.
  {
    slug: "export",
    titleKey: "settings.sections.export.title",
    icon: Download,
    group: "data",
  },
  // Not module-gated: the health record is a flagship export, and its only
  // entry point must not vanish behind the `doctorReport` opt-out.
  {
    slug: "gesundheitsakte",
    titleKey: "settings.sections.gesundheitsakte.title",
    icon: FileHeart,
    group: "data",
  },
  {
    slug: "privacy",
    titleKey: "settings.sections.privacy.title",
    icon: Lock,
    group: "data",
  },
  {
    slug: "advanced",
    titleKey: "settings.sections.advanced.title",
    icon: Settings2,
    group: "data",
  },
  // ── System ──
  {
    slug: "about",
    titleKey: "settings.sections.about.title",
    icon: Info,
    group: "system",
  },
] as const;

export interface SettingsShellProps {
  /**
   * Optional override for the active section. When omitted the shell reads
   * the active slug from `usePathname()` (the production behaviour). Tests
   * pass an explicit value so they don't need to mock the router.
   */
  active?: SettingsSectionSlug;
  /**
   * v1.18.6.1 — the page heading + subtitle now live in the shell, not in
   * the section body. The shell places them in their own grid row that
   * spans ONLY the content column, so the left nav's first item lines up
   * with the top of the first card by construction — no fixed-height
   * spacer to drift across locales or subtitle line-wraps.
   *
   * Title comes from `settings.sections.<active>.title` when omitted; pass
   * an explicit value for the per-module pages (Vorsorge / Illness / Labs)
   * that stay out of the slug registry. `headingId` keeps the historic
   * `settings-section-<slug>-title` anchor for `aria-labelledby` and the
   * spotlight tour.
   */
  heading?: {
    title: string;
    subtitle: string;
    headingId: string;
    /** Rendered above the heading (e.g. a "← back to hub" link). */
    topSlot?: React.ReactNode;
    /** Rendered inline at the top-right of the heading row. */
    headingAccessory?: React.ReactNode;
  };
  children: React.ReactNode;
}

// v1.17.1 — the personalization editors live under the Layout
// hub. They keep their own routes but are NOT standalone nav entries, so
// when the user is on one of them the Layout nav entry is the one that
// reads active.
//
// v1.18.0 — `mood` (Stimmung) and `medications` (Medikamente)
// graduated to their own nav entries, so they are no longer Layout-hub
// children for highlighting purposes.
const LAYOUT_CHILD_SLUGS: ReadonlySet<string> = new Set([
  "dashboard",
  "insights",
  // v1.25.7 — the per-module view/sort/order surfaces moved into the
  // "Darstellung" hub. v1.25.11 (#148) — each lives on its own subpage at
  // `/settings/layout/<slug>`; the legacy `/settings/<slug>` routes
  // 301-redirect there, and a direct hit still highlights the hub.
  "medications",
  "mood",
  "labs",
  "illness",
  "vorsorge",
]);

/** Map a Layout child editor onto the Layout hub for nav highlighting. */
function navHighlightSlug(slug: SettingsSectionSlug): SettingsSectionSlug {
  return LAYOUT_CHILD_SLUGS.has(slug) ? "layout" : slug;
}

function deriveActiveSlug(
  pathname: string | null,
  override?: SettingsSectionSlug,
): SettingsSectionSlug {
  if (override) return navHighlightSlug(override);
  if (!pathname) return "account";
  // Match `/settings/<slug>` and ignore any trailing segments (none today,
  // but cheap insurance for future nested routes).
  const match = pathname.match(/^\/settings\/([^/]+)/);
  const candidate = match?.[1] ?? "";
  if (LAYOUT_CHILD_SLUGS.has(candidate)) return "layout";
  return isSettingsSectionSlug(candidate) ? candidate : "account";
}

export function SettingsShell({
  active,
  heading,
  children,
}: SettingsShellProps) {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const activeSlug = deriveActiveSlug(pathname, active);

  // v1.18.0 — per-submodule entries are listed only when their module
  // is enabled. Read from the resolved `useAuth().user.modules` map (the
  // same map the Module hub, nav, and Insights pills gate off). Fail OPEN
  // (`!== false`): a missing key, or a not-yet-resolved `/me` payload,
  // reads as enabled so an entry never silently disappears. A section's
  // owner comes from the surface map (`settings:<slug>`); sections with no
  // owner (global / CORE) are always shown.
  //
  // v1.25.9 — the module filter must NOT run during SSR / the first client
  // paint. `useAuth().user` resolves from the `/api/auth/me` query, which is
  // populated on the server-rendered pass and the hydrating client pass at
  // DIFFERENT times (a cache race): the server may render the full list while
  // the client hydrates with `modules` already resolved (or vice versa),
  // producing a different number of nav `<li>`s and a React #418 hydration
  // mismatch. On a mismatch React discards and regenerates the whole tree,
  // which dropped the event handlers on every settings page (dead toggles /
  // download buttons). Gate the filter on a post-mount flag so SSR and the
  // first client render ALWAYS emit the same fail-open list; the real filter
  // applies once, after hydration, as an ordinary client update.
  // `useMounted()` is the SSR-safe hydration probe: it returns the server
  // snapshot (`false`) on the server render AND the first client paint, then
  // the client snapshot (`true`) after hydration commits. No setState in an
  // effect (which the lint rule flags as a cascading render), and no risk of
  // the two passes disagreeing.
  const hydrated = useMounted();
  const modules = user?.modules;
  const activeRecord = user?.accountAccess?.active ?? null;
  const allVisibleSections = SETTINGS_SECTIONS.filter(
    (section) =>
      !hydrated || isSurfaceVisible(`settings:${section.slug}`, modules),
  );

  // The server has already resolved which record is active, and which
  // destinations that record offers depends on what kind of record it is. The
  // section gate remains responsible for refusing any direct URL that is not
  // on the list; this filter only stops the nav from offering one.
  //
  // Keep `allVisibleSections` for the active heading so a direct unavailable
  // link identifies itself before the gate explains why it cannot open.
  //
  // Which destinations a record lists is answered by
  // `isSettingsDestinationListedForRecord`, the same predicate the app
  // navigation reads to decide whether to offer a Settings entry at all and
  // where it lands. Its docblock carries the per-kind rules.
  const visibleSections =
    activeRecord === null
      ? allVisibleSections
      : allVisibleSections.filter((section) =>
          isSettingsDestinationListedForRecord(section.slug, activeRecord),
        );
  const activeSection = allVisibleSections.find(
    (section) => section.slug === activeSlug,
  );

  // v1.18.6.1 — resolve the heading once. Pages pass an explicit `heading`
  // (the canonical path); the slug fallback keeps the shell renderable on
  // its own (and in tests that mount it without a heading) by deriving the
  // title from the active section. The heading lives in the shell so it can
  // occupy its own grid row spanning only the content column — see the grid
  // below.
  const resolvedHeading =
    heading ??
    (activeSection
      ? {
          title: t(activeSection.titleKey),
          subtitle: t(`settings.sections.${activeSection.slug}.subtitle`),
          headingId: `settings-section-${activeSection.slug}-title`,
          topSlot: LAYOUT_CHILD_SLUGS.has(activeSection.slug) ? (
            <SettingsHubBackLink
              href="/settings/layout"
              labelKey="settings.sections.layout.backToHub"
            />
          ) : undefined,
          headingAccessory: undefined,
        }
      : null);

  // The shell paints the heading twice — above the mobile chip strip and
  // inside the desktop grid row — so only the desktop copy may be a real
  // `<h1>`. Both go through `PageHeader`: the block used to be hand-rolled
  // here and in `admin-shell.tsx`, which is how Settings and Admin ended up
  // a step off every module page (and off each other).
  const headingBlock = (mobile = false) =>
    resolvedHeading ? (
      <PageHeader
        headingAs={mobile ? "div" : "h1"}
        titleId={
          mobile
            ? `${resolvedHeading.headingId}-mobile`
            : resolvedHeading.headingId
        }
        title={resolvedHeading.title}
        description={resolvedHeading.subtitle}
        topSlot={resolvedHeading.topSlot}
        actions={resolvedHeading.headingAccessory}
      />
    ) : null;

  // v1.4.25 — AuthShell wraps the page in `px-4 py-6 md:px-6`
  // already, so this inner shell only carries the wider max-width.
  // Previously the duplicate `px-4 py-6 md:px-6 md:py-8` here was
  // producing visibly more top/bottom whitespace on Settings/Admin
  // pages than on Dashboard/Insights/Measurements.
  return (
    <div
      className="mx-auto w-full max-w-screen-xl"
      data-active-record-id={activeRecord?.accountId}
      data-record-kind={activeRecord?.recordKind}
    >
      {/* v1.18.6.1 — on mobile the heading sits above the chip strip; on
          desktop it is rendered inside the grid (row 1 / content column) so
          it does not paint twice. */}
      {resolvedHeading ? (
        <div className="mb-4 md:hidden">{headingBlock(true)}</div>
      ) : null}

      <SettingsAnchorForward />
      {/* Below `md`: one button naming the current section, opening the
          grouped section sheet. Hidden on md+, where the sidebar shows. */}
      <SettingsMobileNav
        activeSlug={activeSlug}
        entries={visibleSections.map((section) => ({
          slug: section.slug,
          title: t(section.titleKey),
          groupLabel: t(SETTINGS_SECTION_GROUP_LABEL_KEYS[section.group]),
          icon: section.icon,
        }))}
      />

      {/* v1.18.6.1 — two-row grid on desktop:
            row 1 / col 2 = heading (content column only)
            row 2 / col 1 = nav     row 2 / col 2 = cards
          The nav's first item lines up with the top of the first card BY
          CONSTRUCTION — both start the grid's second row — so the alignment
          holds across locales and however the title or subtitle wraps. No
          fixed-height spacer to guess. The `gap-6` between rows reproduces
          the `space-y-6` the heading-to-first-card gap used to carry. */}
      <div
        className={cn(
          "grid gap-6 md:grid-cols-[220px_1fr] md:grid-rows-[auto_1fr]",
          SUB_SHELL_GRID_FLOOR,
        )}
      >
        {/* Heading — desktop only here (mobile renders it above the strip). */}
        {resolvedHeading ? (
          <div className="hidden md:col-start-2 md:row-start-1 md:block">
            {headingBlock()}
          </div>
        ) : null}

        {/* Desktop sticky sidebar — starts on the heading row and spans the
            two desktop rows. Its top therefore shares the heading's grid
            line while the content column keeps the natural heading-to-card
            gap in row 2.

            The sticky lives on the `<aside>` grid item itself, with
            `self-start` so it shrinks to its content instead of stretching
            to the full row height. A sticky CHILD inside a stretched grid
            item resolves its containing block to the stretched item, which
            in some engines lets the nav scroll away with the content rather
            than pin. Sticking the grid item directly — sized to content and
            offset `top-6` to clear the scroll viewport's padding — keeps the
            nav fixed while only the content column scrolls. `max-h` +
            `overflow-y-auto` let a long section list scroll within the
            pinned panel on short viewports. */}
        <aside
          aria-label={t("settings.shell.sectionsNav")}
          className="no-scrollbar hidden max-h-[calc(100dvh-10.5rem)] overflow-y-auto md:sticky md:top-6 md:col-start-1 md:row-span-2 md:row-start-1 md:block md:self-start"
        >
          <ul className="space-y-1">
            {visibleSections.map((section, index) => {
              const isActive = section.slug === activeSlug;
              const Icon = section.icon;
              // A non-interactive header
              // precedes the first VISIBLE entry of each group so a
              // module-gated entry never leaves an orphan header above an
              // empty cluster.
              const startsNewGroup =
                index === 0 ||
                visibleSections[index - 1].group !== section.group;
              return (
                <React.Fragment key={section.slug}>
                  {startsNewGroup ? (
                    <li
                      className={cn(
                        "text-muted-foreground px-3 pb-1 text-xs font-medium tracking-wide uppercase",
                        index === 0 ? "" : "pt-4",
                      )}
                    >
                      {t(SETTINGS_SECTION_GROUP_LABEL_KEYS[section.group])}
                    </li>
                  ) : null}
                  <li>
                    <Link
                      href={`/settings/${section.slug}`}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-accent",
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {t(section.titleKey)}
                    </Link>
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        </aside>

        {/* Main column — page renders its own h1 + subtitle.

            v1.25.11 (#154) — the column no longer carries its own
            `min-h-[calc(100dvh-12rem)]`. That reserve was tuned without
            the AuthShell wrapper's `pt-6 pb-20` (104 px) in the budget, so
            on a short section it forced the column ~100 px past the
            viewport: the page scrolled into a dark empty band below the
            last card. Instead the GRID carries `md:min-h-[calc(100dvh-
            10.5rem)]` (top bar 4rem + wrapper pt-6/pb-20 = 10.5rem), and
            this column is the grid's `1fr` row, so it stretches to fill
            the viewport EXACTLY on a short section (no over-scroll, no dark
            band) and grows past it on a long one (normal scroll). The floor
            still prevents the short-loading-state → long-list height jump
            the old reserve guarded, just measured against the real budget.

            The column carries NO bottom gutter of its own. AuthShell's
            `<main>` already reserves `pb-[calc(4rem+safe-area)]` on `<md` to
            clear the floating bottom-nav, and its wrapper reserves `pb-20` for
            the Coach FAB. The old `pb-24 md:pb-0` (v1.4.33 F14) double-counted
            that same 64 px nav clearance and stacked ~96 px of dead scroll
            below the last card on mobile — removed so the shell owns all
            bottom-space (over-scroll class, #154 lineage).

            v1.16.4 — a `<div>`, not `<main>`: the surrounding AuthShell
            already provides the page's single `<main>` landmark and a
            nested second one is an a11y violation. */}
        <div className="min-w-0 md:col-start-2">{children}</div>
      </div>
    </div>
  );
}
