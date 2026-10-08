"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import { SettingsCard } from "./settings-card";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { LAYOUT_GROUPS } from "./layout-groups";

/**
 * v1.25.11 (#148) — the "Layout" hub (slug stays `layout`).
 *
 * The hub is a navigable index, NOT a stacked composition: it lists each
 * module as a clickable row (title + description + chevron) that opens the
 * module's own subpage at `/settings/layout/<id>`. Nothing is stacked inline;
 * the per-module view/sort surfaces live on their subpages so the hub reads as
 * a short, scannable directory. The visible page heading + subtitle
 * ("Layout" / "Choose what …") are painted by `SettingsShell` from the
 * `layout` slug; this body renders only the row list.
 *
 * Per-module gating fails OPEN (`!== false`): a missing key reads as enabled so
 * a section never silently disappears. Groups with no owner in the surface
 * map (`settings-layout:<id>`) always
 * render. The filter is gated on a post-mount flag (`useMounted()`) so SSR and
 * the first client paint ALWAYS emit the same fail-open list — the same
 * hydration-stability contract the shell nav uses, so the module filter can
 * never produce a React #418 mismatch on this surface.
 */
export function LayoutSection() {
  const { t } = useTranslations();
  const { user } = useAuth();

  const hydrated = useMounted();
  const modules = user?.modules;
  const visibleGroups = LAYOUT_GROUPS.filter(
    (group) =>
      !hydrated || isSurfaceVisible(`settings-layout:${group.id}`, modules),
  );

  return (
    <SettingsCard flush className="divide-border divide-y">
      {visibleGroups.map((group) => (
        <Link
          key={group.id}
          href={`/settings/layout/${group.id}`}
          className="hover:bg-accent/50 flex items-center justify-between gap-4 p-4 transition-colors md:p-6"
        >
          <div className="min-w-0 space-y-0.5">
            <p className="text-foreground text-sm font-medium">
              {t(group.titleKey)}
            </p>
            <p className="text-muted-foreground text-sm">
              {t(group.descriptionKey)}
            </p>
          </div>
          <ChevronRight
            className="text-muted-foreground h-5 w-5 shrink-0"
            aria-hidden="true"
          />
        </Link>
      ))}
    </SettingsCard>
  );
}
