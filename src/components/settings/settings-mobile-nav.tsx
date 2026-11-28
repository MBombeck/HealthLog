"use client";

/**
 * Settings navigation below `md`: the page title is the switcher. The H1
 * names where the person is and opens a bottom sheet listing every section
 * under its group.
 *
 * The phone used to stack the title, then a full-width button naming the same
 * section again, then the page's first heading: the page's name two or three
 * times before any setting. The title and the switcher are now one control.
 *
 * The phone used to carry every section as a chip in one horizontal strip,
 * more than twenty of them, so most of Settings sat off screen and the groups
 * the desktop sidebar shows were reduced to thin dividers. The sheet shows the
 * same groups and order as the sidebar, one 44 px row per section, and closes
 * on choice. Both read the visible-section list the shell computes, so the
 * module and record filters apply to both alike.
 */

import * as React from "react";
import Link from "next/link";
import { ChevronsUpDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";

export interface SettingsNavEntry {
  slug: string;
  title: string;
  groupLabel: string;
  icon: LucideIcon;
}

export function SettingsMobileNav({
  entries,
  activeSlug,
  heading,
}: {
  entries: readonly SettingsNavEntry[];
  activeSlug: string;
  /**
   * The page title the switcher stands in for. Without it (a test that
   * mounts the nav alone) the switcher names the active section.
   */
  heading?: {
    title: string;
    titleId: string;
    topSlot?: React.ReactNode;
    actions?: React.ReactNode;
  };
}) {
  const { t } = useTranslations();
  const [open, setOpen] = React.useState(false);
  const active = entries.find((entry) => entry.slug === activeSlug);

  // Group the flat, pre-ordered list for rendering; the order of first
  // appearance is the group order.
  const groups: { label: string; entries: SettingsNavEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.label === entry.groupLabel) last.entries.push(entry);
    else groups.push({ label: entry.groupLabel, entries: [entry] });
  }

  return (
    <nav
      aria-label={t("settings.shell.sectionsNav")}
      className="mb-4 md:hidden"
    >
      <PageHeader
        headingAs="div"
        titleId={heading?.titleId}
        topSlot={heading?.topSlot}
        actions={heading?.actions}
        title={
          <button
            type="button"
            data-slot="settings-mobile-nav-trigger"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="focus-visible:ring-ring/50 -mx-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1 text-left focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="min-w-0 truncate">
              {heading?.title ??
                active?.title ??
                t("settings.shell.allSections")}
            </span>
            <ChevronsUpDown
              className="text-muted-foreground size-5 shrink-0"
              aria-hidden="true"
            />
          </button>
        }
      />

      <ResponsiveSheet
        open={open}
        onOpenChange={setOpen}
        title={t("settings.shell.allSections")}
      >
        <div className="space-y-4 pb-2" data-slot="settings-mobile-nav-list">
          {groups.map((group) => (
            <section key={group.label} className="space-y-1">
              <h2 className="text-muted-foreground px-1 text-xs font-medium tracking-wide uppercase">
                {group.label}
              </h2>
              <ul className="space-y-0.5">
                {group.entries.map((entry) => {
                  const isActive = entry.slug === activeSlug;
                  const Icon = entry.icon;
                  return (
                    <li key={entry.slug}>
                      <Link
                        href={`/settings/${entry.slug}`}
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-foreground hover:bg-accent",
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {entry.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </ResponsiveSheet>
    </nav>
  );
}
