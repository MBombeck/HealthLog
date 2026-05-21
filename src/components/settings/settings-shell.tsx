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
 *   - <md: section selector renders as a horizontal scroll strip at the top so
 *     a thumb-tap can swap sections without leaving the viewport.
 *   - >=md: sticky 220px sidebar + content column with `max-w-screen-xl`.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Download,
  KeyRound,
  LayoutDashboard,
  Link2,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { scrollBehaviorForUser } from "@/lib/motion";
import { useTranslations } from "@/lib/i18n/context";
import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
} from "./section-slugs";

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

interface SettingsSection {
  slug: SettingsSectionSlug;
  /** i18n key under `settings.sections.<slug>.title`. */
  titleKey: string;
  icon: LucideIcon;
}

/**
 * Source of truth for the section list that the settings shell renders
 * in its sidebar + mobile chip-strip. Order matches the in-app
 * navigation order. Don't reorder without updating tests.
 *
 * v1.4.33 IW7 — "About" was folded into the sidebar user-card
 * dropdown (sidebar-nav.tsx -> "Über HealthLog" / "About HealthLog")
 * because its three small cards (identity / links / update check)
 * collectively read once or twice a year and didn't earn a top-level
 * settings slot. The route `/settings/about` is still alive — the
 * slug stays in `SETTINGS_SECTION_SLUGS` so `generateStaticParams()`
 * keeps emitting the page — but it no longer appears in the in-page
 * navigation. Direct links (the user-card dropdown, the public
 * `/about` permalink) continue to resolve to the same component.
 *
 * v1.4.34 IW-D — `sources` was merged into `thresholds` (now titled
 * "Targets & Sources" / "Zielwerte & Quellen"). The combined section
 * surfaces per-metric source priority alongside the threshold inputs
 * on a single page. `/settings/sources` stays alive as a
 * `permanentRedirect` so external bookmarks keep working; the slug
 * was dropped from `SETTINGS_SECTION_SLUGS` because the dynamic
 * `[section]` route no longer serves it. Per
 * `.planning/research/v1434-r-2-carryover-scope.md` §7.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { slug: "account", titleKey: "settings.sections.account.title", icon: User },
  {
    slug: "integrations",
    titleKey: "settings.sections.integrations.title",
    icon: Link2,
  },
  {
    slug: "notifications",
    titleKey: "settings.sections.notifications.title",
    icon: Bell,
  },
  {
    slug: "dashboard",
    titleKey: "settings.sections.dashboard.title",
    icon: LayoutDashboard,
  },
  {
    slug: "thresholds",
    titleKey: "settings.sections.thresholds.title",
    icon: SlidersHorizontal,
  },
  { slug: "ai", titleKey: "settings.sections.ai.title", icon: Sparkles },
  { slug: "api", titleKey: "settings.sections.api.title", icon: KeyRound },
  {
    slug: "export",
    titleKey: "settings.sections.export.title",
    icon: Download,
  },
  {
    slug: "advanced",
    titleKey: "settings.sections.advanced.title",
    icon: Settings2,
  },
] as const;

export interface SettingsShellProps {
  /**
   * Optional override for the active section. When omitted the shell reads
   * the active slug from `usePathname()` (the production behaviour). Tests
   * pass an explicit value so they don't need to mock the router.
   */
  active?: SettingsSectionSlug;
  children: React.ReactNode;
}

function deriveActiveSlug(
  pathname: string | null,
  override?: SettingsSectionSlug,
): SettingsSectionSlug {
  if (override) return override;
  if (!pathname) return "account";
  // Match `/settings/<slug>` and ignore any trailing segments (none today,
  // but cheap insurance for future nested routes).
  const match = pathname.match(/^\/settings\/([^/]+)/);
  const candidate = match?.[1] ?? "";
  return isSettingsSectionSlug(candidate) ? candidate : "account";
}

export function SettingsShell({ active, children }: SettingsShellProps) {
  const pathname = usePathname();
  const { t } = useTranslations();
  const activeSlug = deriveActiveSlug(pathname, active);

  // v1.4.33 IW4 — scroll the active chip into view inside the
  // horizontal mobile strip. On a 393 CSS px viewport the strip
  // is 11 chips wide and the rightmost four sit below the fold; a
  // user who tapped one of those chips lands on the new route
  // with the strip still scrolled to the leftmost chip, which
  // reads as if the navigation is broken. `inline: "center"`
  // anchors the active chip in the visible middle of its scroll
  // container so the user keeps spatial orientation between
  // sections.
  const mobileStripRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const strip = mobileStripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    active.scrollIntoView({
      block: "nearest",
      // v1.4.36 W4b — `inline: "start"` pins the active chip to the
      // left edge of the scroller. `inline: "center"` over-scrolled
      // and the first one or two chips were unreachable on narrow
      // viewports.
      inline: "start",
      // v1.4.43 W5-H5 — respect `prefers-reduced-motion`.
      behavior: scrollBehaviorForUser(),
    });
  }, [activeSlug]);

  // v1.4.25 W8 — AuthShell wraps the page in `px-4 py-6 md:px-6`
  // already, so this inner shell only carries the wider max-width.
  // Previously the duplicate `px-4 py-6 md:px-6 md:py-8` here was
  // producing visibly more top/bottom whitespace on Settings/Admin
  // pages than on Dashboard/Insights/Measurements.
  return (
    <div className="mx-auto w-full max-w-screen-xl">
      {/* Mobile section strip — horizontal scroll, hidden on md+.
          `no-scrollbar` (defined in `globals.css`) suppresses the
          painted scrollbar; the horizontal swipe + keyboard arrow
          scrolling still work. Without it the 10-section strip
          renders an always-on scrollbar at the top of every settings
          page, which makes the page feel like every section card has
          an overflow problem.

          v1.4.33 IW7 — `snap-x snap-mandatory` lets a swipe-flick land
          on the next chip's leading edge instead of the in-between
          dead zone. The auto `scrollIntoView({inline: "center"})`
          effect above stays the canonical positioner for the active
          chip; snap is the polish layer when the user manually flicks
          through the strip without tapping. */}
      <nav
        ref={mobileStripRef}
        aria-label={t("settings.shell.sectionsNav")}
        className="no-scrollbar -mx-4 mb-4 snap-x snap-mandatory overflow-x-auto px-4 md:hidden"
      >
        <ul className="flex min-w-max gap-2">
          {SETTINGS_SECTIONS.map((section) => {
            const isActive = section.slug === activeSlug;
            const Icon = section.icon;
            return (
              <li key={section.slug} className="snap-start">
                <Link
                  href={`/settings/${section.slug}`}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    // v1.4.25 W8 — chip strip is the primary mobile-settings
                    // navigation surface. Pad to WCAG 2.5.5 44 px so the
                    // chips can be tapped without zoom on a Pixel-5.
                    "flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                    isActive
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-foreground hover:bg-accent",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t(section.titleKey)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        {/* Desktop sticky sidebar */}
        <aside
          aria-label={t("settings.shell.sectionsNav")}
          className="hidden md:block"
        >
          <div className="sticky top-20">
            <ul className="space-y-1">
              {SETTINGS_SECTIONS.map((section) => {
                const isActive = section.slug === activeSlug;
                const Icon = section.icon;
                return (
                  <li key={section.slug}>
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
                );
              })}
            </ul>
          </div>
        </aside>

        {/* Main column — page renders its own h1 + subtitle. The
            `min-h-[calc(100dvh-12rem)]` reserve keeps the column tall
            enough that swapping a short loading state for a long
            section list (Thresholds, Sources) does not jump the page
            height under the sticky sidebar.

            v1.4.33 F14 — `pb-24 md:pb-0` reserves a 96 px bottom gutter
            on `<md` so the last form field on
            `/settings/account` (Geschlecht / Gender) and
            `/settings/ai` (Aktiver Provider) is not eaten by the
            floating mobile bottom-nav. Desktop reverts to the parent's
            own padding because the bottom-nav doesn't render on `md+`. */}
        <main className="min-h-[calc(100dvh-12rem)] min-w-0 pb-24 md:pb-0">
          {children}
        </main>
      </div>
    </div>
  );
}
