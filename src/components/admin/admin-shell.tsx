"use client";

/**
 * `<AdminShell>` — sidebar + main column shell for the v1.5 admin split.
 *
 * Mirrors `<SettingsShell>` (`src/components/settings/settings-shell.tsx`):
 * each section lives at its own route under `/admin/[section]/page.tsx` and
 * mounts inside this shell. The shell only owns navigation; the page itself
 * renders the section heading and content.
 *
 * Mobile-first per `docs/ui-guidelines.md`:
 *   - <md: section selector renders as a horizontal scroll strip at the top.
 *   - >=md: sticky 220px sidebar + content column with `max-w-screen-xl`.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Blocks,
  Database,
  FileText,
  Info,
  KeyRound,
  Plug,
  Radio,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Ticket,
  Users,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { SUB_SHELL_GRID_FLOOR } from "@/components/layout/shell-metrics";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { isAdminSectionSlug, type AdminSectionSlug } from "./section-slugs";

interface AdminSection {
  slug: AdminSectionSlug;
  /** i18n key under `admin.section.<slug>.title`. */
  titleKey: string;
  icon: LucideIcon;
}

/**
 * Source of truth for the admin section list. Order matches the in-app
 * navigation order so the sidebar, mobile strip, and `generateStaticParams()`
 * all line up. Don't reorder without updating tests.
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    slug: "system-status",
    titleKey: "admin.section.system-status.title",
    icon: Server,
  },
  {
    slug: "general",
    titleKey: "admin.section.general.title",
    icon: Settings,
  },
  {
    slug: "services",
    titleKey: "admin.section.services.title",
    icon: Radio,
  },
  {
    slug: "integrations",
    titleKey: "admin.section.integrations.title",
    icon: Plug,
  },
  // v1.18.1 — single "Coach" entry replacing the former ai-quality,
  // assistant, and coach-feedback trio. The section body stacks all
  // three surfaces so the coach-quality picture lives in one place.
  {
    slug: "coach",
    titleKey: "admin.section.coach.title",
    icon: Sparkles,
  },
  // v1.18.6 (W9) — server-wide module availability split out of Coach into
  // its own entry, sitting next to it.
  {
    slug: "module-availability",
    titleKey: "admin.section.module-availability.title",
    icon: Blocks,
  },
  {
    slug: "reminders",
    titleKey: "admin.section.reminders.title",
    icon: Bell,
  },
  {
    slug: "users",
    titleKey: "admin.section.users.title",
    icon: Users,
  },
  // v1.16.0 — invites as their own section, directly after Users
  // (admission lives next to the accounts it creates).
  {
    slug: "invites",
    titleKey: "admin.section.invites.title",
    icon: Ticket,
  },
  {
    slug: "api-tokens",
    titleKey: "admin.section.api-tokens.title",
    icon: KeyRound,
  },
  {
    slug: "login-overview",
    titleKey: "admin.section.login-overview.title",
    icon: ScrollText,
  },
  {
    slug: "app-logs",
    titleKey: "admin.section.app-logs.title",
    icon: FileText,
  },
  {
    slug: "backups",
    titleKey: "admin.section.backups.title",
    icon: Database,
  },
  // v1.23 — encryption coverage + key-rotation status / safe trigger.
  {
    slug: "encryption",
    titleKey: "admin.section.encryption.title",
    icon: ShieldCheck,
  },
  {
    slug: "danger-zone",
    titleKey: "admin.section.danger-zone.title",
    icon: ShieldAlert,
  },
  // v1.4.36 W4e — About / version / update check folded into Admin.
  {
    slug: "about",
    titleKey: "admin.section.about.title",
    icon: Info,
  },
] as const;

export interface AdminShellProps {
  /**
   * Optional override for the active section. When omitted the shell reads
   * the active slug from `usePathname()` (the production behaviour). Tests
   * pass an explicit value so they don't need to mock the router.
   */
  active?: AdminSectionSlug;
  children: React.ReactNode;
}

function deriveActiveSlug(
  pathname: string | null,
  override?: AdminSectionSlug,
): AdminSectionSlug | null {
  if (override) return override;
  if (!pathname) return null;
  // Match `/admin/<slug>` and ignore any trailing segments. The
  // `/admin` overview page falls through to `null` so no entry is
  // marked active.
  const match = pathname.match(/^\/admin\/([^/]+)/);
  const candidate = match?.[1] ?? "";
  return isAdminSectionSlug(candidate) ? candidate : null;
}

export function AdminShell({ active, children }: AdminShellProps) {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const activeSlug = deriveActiveSlug(pathname, active);

  // v1.4.34 IW-G — mirror the settings-shell auto-scroll pattern so
  // the active chip stays in view when the user lands on a deeper
  // admin route. Without it the 16-chip strip stays scrolled to the
  // left and the active chip lives off-screen, reading as a broken nav.
  const mobileStripRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const strip = mobileStripRef.current;
    if (!strip) return;
    const activeChip = strip.querySelector<HTMLElement>(
      '[aria-current="page"]',
    );
    if (!activeChip) return;
    // Adjust only the strip's own horizontal offset, instantly. The old
    // `scrollIntoView` walked every scrollable ancestor and could nudge the
    // document vertically, and a smooth behaviour animated the strip from a
    // reset `scrollLeft: 0` to the target on every tap — an unwanted "scroll
    // from the start" sweep. `scrollTo({ left, behavior: "auto" })` confines
    // the motion to the strip's horizontal axis and jumps without animation.
    const maxScroll = strip.scrollWidth - strip.clientWidth;
    const target = Math.max(0, Math.min(activeChip.offsetLeft, maxScroll));
    strip.scrollTo({ left: target, behavior: "auto" });
  }, [activeSlug]);

  // The section bodies are already role-gated, but the shell frame
  // itself (the full section nav in two layouts) used to paint for a
  // non-admin during the frames between auth resolving and AuthShell's
  // redirect effect replacing the route. Render nothing — frame AND
  // children — until the role is confirmed ADMIN.
  if (!user || user.role !== "ADMIN") return null;

  // v1.18.6.1 — the heading lives in the shell so it can occupy its own grid
  // row spanning only the content column; the nav's first item then lines up
  // with the top of the first card by construction. `/admin` overview
  // (activeSlug === null) shows the console title; each section shows its own.
  const headingTitle =
    activeSlug === null
      ? t("admin.title")
      : t(`admin.section.${activeSlug}.title`);
  const headingSubtitle =
    activeSlug === null
      ? t("admin.subtitle")
      : t(`admin.section.${activeSlug}.subtitle`);

  const headingBlock = (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{headingTitle}</h1>
      <p className="text-muted-foreground text-sm">{headingSubtitle}</p>
    </div>
  );

  // v1.4.25 W8 — AuthShell wraps the page in `px-4 py-6 md:px-6`
  // already, so this inner shell only carries the wider max-width.
  // Previously the duplicate `px-4 py-6 md:px-6 md:py-8` here was
  // producing visibly more top/bottom whitespace on Settings/Admin
  // pages than on Dashboard/Insights/Measurements.
  return (
    <div className="mx-auto w-full max-w-screen-xl">
      {/* v1.18.6.1 — heading above the chip strip on mobile; on desktop it
          renders inside the grid (row 1 / content column). */}
      <div className="mb-4 md:hidden">{headingBlock}</div>

      {/* Mobile section strip — horizontal scroll, hidden on md+.
          `no-scrollbar` (defined in `globals.css`) suppresses the
          painted scrollbar at the top of every admin page; the
          horizontal swipe + keyboard arrow scrolling still work, the
          bar just doesn't draw. Without this the 13-section strip
          would render an always-on scrollbar that the maintainer kept
          mis-attributing to the api-tokens table below it.

          v1.4.34 IW-G — `snap-x snap-mandatory` plus per-chip
          `snap-start` lets a swipe-flick land on the next chip's
          leading edge instead of the in-between dead zone, matching
          the settings-shell polish. */}
      <nav
        ref={mobileStripRef}
        aria-label={t("admin.shell.sectionsNav")}
        className="no-scrollbar relative -mx-4 mb-4 snap-x snap-mandatory overflow-x-auto px-4 md:hidden"
      >
        <ul className="flex min-w-max gap-2">
          <li className="snap-start">
            <Link
              href="/admin"
              aria-current={activeSlug === null ? "page" : undefined}
              className={cn(
                // v1.4.25 W8 — chip strip is the primary mobile-admin
                // navigation surface. Pad to WCAG 2.5.5 44 px so the
                // chips can be tapped without zoom on a Pixel-5.
                "flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                activeSlug === null
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-foreground hover:bg-accent",
              )}
            >
              <ScrollText className="h-4 w-4" aria-hidden="true" />
              {t("admin.shell.overview")}
            </Link>
          </li>
          {ADMIN_SECTIONS.map((section) => {
            const isActive = section.slug === activeSlug;
            const Icon = section.icon;
            return (
              <li key={section.slug} className="snap-start">
                <Link
                  href={`/admin/${section.slug}`}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    // v1.4.25 W8 — chip strip is the primary mobile-admin
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

      {/* v1.18.6.1 — two-row grid: heading in row 1 / col 2, nav in row 2 /
          col 1, cards in row 2 / col 2. The nav's first item starts the same
          grid row as the first card, so they align by construction across
          locales and however the heading wraps — no fixed-height spacer. */}
      <div
        className={cn(
          "grid gap-6 md:grid-cols-[220px_1fr] md:grid-rows-[auto_1fr]",
          SUB_SHELL_GRID_FLOOR,
        )}
      >
        {/* Heading — desktop only (mobile renders it above the strip). */}
        <div className="hidden md:col-start-2 md:row-start-1 md:block">
          {headingBlock}
        </div>

        {/* Desktop sticky sidebar — starts at the cards row (row 2).

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
          aria-label={t("admin.shell.sectionsNav")}
          className="no-scrollbar hidden max-h-[calc(100dvh-5.5rem)] overflow-y-auto md:sticky md:top-6 md:col-start-1 md:row-start-2 md:block md:self-start"
        >
          <ul className="space-y-1">
            <li>
              <Link
                href="/admin"
                aria-current={activeSlug === null ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  activeSlug === null
                    ? "bg-primary/10 text-primary"
                    : "text-foreground hover:bg-accent",
                )}
              >
                <ScrollText className="h-4 w-4" aria-hidden="true" />
                {t("admin.shell.overview")}
              </Link>
            </li>
            {ADMIN_SECTIONS.map((section) => {
              const isActive = section.slug === activeSlug;
              const Icon = section.icon;
              return (
                <li key={section.slug}>
                  <Link
                    href={`/admin/${section.slug}`}
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
        </aside>

        {/* Cards column — row 2 / col 2, the grid's `1fr` row, so it
            stretches to fill the shared `SUB_SHELL_GRID_FLOOR` on the grid
            (matches `<SettingsShell>`) without over-shooting. The loading-jump
            floor lives on the GRID, not here: a column-level
            `min-h-[calc(100dvh-12rem)]` reserve (the pre-#154 shape this used
            to carry) over-reserves on short sections and on mobile, scrolling
            the page into a dark band below the last card. AuthShell already
            owns the page's single `<main>` landmark. */}
        <div className="min-w-0 md:col-start-2 md:row-start-2">{children}</div>
      </div>
    </div>
  );
}
