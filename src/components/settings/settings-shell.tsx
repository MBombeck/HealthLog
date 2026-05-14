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
  Info,
  KeyRound,
  Layers,
  LayoutDashboard,
  Link2,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
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
 * Source of truth for the section list. Order matches the in-app navigation
 * order so the sidebar, mobile strip, and `generateStaticParams()` all line
 * up. Don't reorder without updating tests.
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
  {
    slug: "sources",
    titleKey: "settings.sections.sources.title",
    icon: Layers,
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
  { slug: "about", titleKey: "settings.sections.about.title", icon: Info },
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
          an overflow problem. */}
      <nav
        aria-label={t("settings.shell.sectionsNav")}
        className="no-scrollbar -mx-4 mb-4 overflow-x-auto px-4 md:hidden"
      >
        <ul className="flex min-w-max gap-2">
          {SETTINGS_SECTIONS.map((section) => {
            const isActive = section.slug === activeSlug;
            const Icon = section.icon;
            return (
              <li key={section.slug}>
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

        {/* Main column — page renders its own h1 + subtitle */}
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
