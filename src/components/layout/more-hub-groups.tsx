"use client";

/**
 * The phone's More sheet: every feature destination the tab bar does not
 * carry, under the same group headings as the sidebar and in the same order
 * (`NAV_GROUPS`, #1113). A group none of whose entries is left loses its
 * heading. The tab bar itself is unchanged.
 */
import Link from "next/link";

import {
  groupNavDestinations,
  type MobileMoreHubEntry,
} from "@/components/layout/nav-model";
import { useMounted } from "@/hooks/use-mounted";
import { useNavCounts } from "@/hooks/use-nav-counts";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export function MoreHubGroups({
  entries,
  isActive,
  onNavigate,
}: {
  entries: ReadonlyArray<MobileMoreHubEntry>;
  isActive: (href: string) => boolean;
  onNavigate: () => void;
}) {
  const { t } = useTranslations();
  const counts = useNavCounts(useMounted());
  return (
    // It scrolls: a phone held sideways is shorter than the hub.
    <div className="min-h-0 space-y-4 overflow-y-auto overscroll-contain px-3 pt-4 pb-4">
      {groupNavDestinations(entries).map((group) => (
        <section
          key={group.id}
          data-slot="more-hub-group"
          data-group={group.id}
          aria-labelledby={group.labelKey ? `more-hub-${group.id}` : undefined}
        >
          {group.labelKey ? (
            <h3
              id={`more-hub-${group.id}`}
              className="text-muted-foreground mb-2 px-1 text-xs font-medium tracking-wide uppercase"
            >
              {t(group.labelKey)}
            </h3>
          ) : null}
          {/* Tight gutters (`px-3` on the sheet, `px-3` in the tile) give a
              long single-word label room to break onto a clean second line
              on a 320 px phone instead of clipping. */}
          <div className="grid grid-cols-2 gap-2">
            {group.items.map((item) => {
              const active = isActive(item.href);
              const label = t(item.tKey);
              const count = counts[item.href] ?? 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  aria-label={
                    count > 0 ? t("nav.dueCount", { label, count }) : undefined
                  }
                  // `min-h-14` matches the capture-picker tiles, so the
                  // equivalent tappable rows share one height.
                  className={cn(
                    "border-border flex min-h-14 items-center gap-2.5 rounded-lg border px-3 py-3 transition-colors",
                    active
                      ? "text-primary bg-primary/5"
                      : "text-foreground hover:bg-accent/40",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  {/* The full label, never an ellipsis: `text-xs`, and two
                      lines with breaking for the rare word that cannot fit. */}
                  <span
                    className="line-clamp-2 min-w-0 text-xs leading-tight font-medium [overflow-wrap:anywhere]"
                    title={label}
                  >
                    {label}
                  </span>
                  {count > 0 ? (
                    <span
                      aria-hidden="true"
                      data-slot="nav-count"
                      className="bg-primary text-primary-foreground text-2xs ml-auto h-4 min-w-4 shrink-0 rounded-full px-1 text-center leading-4 font-semibold tabular-nums"
                    >
                      {count}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
