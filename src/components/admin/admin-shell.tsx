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
  AlertTriangle,
  Bell,
  Database,
  FileText,
  KeyRound,
  Inbox,
  Plug,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
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
    icon: Plug,
  },
  {
    slug: "integrations",
    titleKey: "admin.section.integrations.title",
    icon: AlertTriangle,
  },
  {
    slug: "ai-quality",
    titleKey: "admin.section.ai-quality.title",
    icon: Sparkles,
  },
  {
    slug: "assistant",
    titleKey: "admin.section.assistant.title",
    icon: Sparkles,
  },
  {
    slug: "coach-feedback",
    titleKey: "admin.section.coach-feedback.title",
    icon: Sparkles,
  },
  {
    slug: "feedback",
    titleKey: "admin.section.feedback.title",
    icon: Inbox,
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
  {
    slug: "danger-zone",
    titleKey: "admin.section.danger-zone.title",
    icon: ShieldAlert,
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
          painted scrollbar at the top of every admin page; the
          horizontal swipe + keyboard arrow scrolling still work, the
          bar just doesn't draw. Without this the 13-section strip
          would render an always-on scrollbar that the maintainer kept
          mis-attributing to the api-tokens table below it. */}
      <nav
        aria-label={t("admin.shell.sectionsNav")}
        className="no-scrollbar -mx-4 mb-4 overflow-x-auto px-4 md:hidden"
      >
        <ul className="flex min-w-max gap-2">
          <li>
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
              <li key={section.slug}>
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

      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        {/* Desktop sticky sidebar */}
        <aside
          aria-label={t("admin.shell.sectionsNav")}
          className="hidden md:block"
        >
          <div className="sticky top-20">
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
          </div>
        </aside>

        {/* Main column — page renders its own h1 + subtitle. Same
            `min-h-[calc(100dvh-12rem)]` reserve as `<SettingsShell>`
            so navigating between admin sub-pages (e.g. system-status
            → login-overview) does not jump the page height while the
            new section is still fetching. */}
        <main className="min-h-[calc(100dvh-12rem)] min-w-0">{children}</main>
      </div>
    </div>
  );
}
