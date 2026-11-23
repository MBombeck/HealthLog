"use client";

import {
  Activity,
  AlertTriangle,
  Bug,
  CalendarCheck,
  Fingerprint,
  Flame,
  Heart,
  KeyRound,
  LogIn,
  Pill,
  ShieldCheck,
  SkipForward,
  Star,
  Target,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useAccountOnceMounted, useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useAchievementsQuery } from "@/lib/queries/use-achievements-query";
import type { AchievementProgress } from "@/lib/gamification/achievements";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InlineAction } from "@/components/ui/inline-action";

const iconMap: Record<string, LucideIcon> = {
  Activity,
  Flame,
  CalendarCheck,
  Pill,
  ShieldCheck,
  Target,
  Trophy,
  Heart,
  KeyRound,
  Fingerprint,
  LogIn,
  Bug,
  AlertTriangle,
  SkipForward,
};

/**
 * Pure helper — pick the N most-recently unlocked achievements.
 * Achievements without a `completedAt` (legacy unlocks pre-persistence)
 * sort to the bottom by definition order so newer entries always win.
 * Exported for unit testing.
 */
export function pickRecentUnlocks(
  achievements: AchievementProgress[],
  limit: number,
): AchievementProgress[] {
  const unlocked = achievements.filter((a) => a.unlocked);
  unlocked.sort((a, b) => {
    if (a.completedAt && b.completedAt) {
      return b.completedAt.localeCompare(a.completedAt);
    }
    if (a.completedAt) return -1;
    if (b.completedAt) return 1;
    return 0;
  });
  return unlocked.slice(0, limit);
}

const RECENT_LIMIT = 3;

/**
 * v1.4.15 — small dashboard card surfacing the user's three
 * most-recently unlocked achievements. Empty-states with a CTA to
 * /achievements when nothing is unlocked yet so the user discovers the
 * feature exists. Visibility is controlled from Settings → Dashboard
 * (`achievements` widget id).
 *
 * Reuses the same `/api/gamification/achievements` endpoint as the
 * dedicated page and the unlock notifier; v1.4.34 IW-F-Perf folds all
 * three consumers onto the shared `useAchievementsQuery()` hook so a
 * single cache slot and a single network call back this dashboard
 * tile, the mother page, and the toast notifier.
 */
export function RecentAchievementsCard() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();
  // Withheld until mounted for the same reason the skeleton gate below is:
  // this card paints inside the dashboard's streamed boundary, and a module
  // gate that reads the account on the hydration render disagrees with the
  // server, which had none. See `useAccountOnceMounted`.
  const user = useAccountOnceMounted();

  // v1.18.0 — the achievements module gate. When the account has the
  // module turned off the dashboard tile disappears entirely (the data
  // query never fires; the API would 403 anyway). Default-on: an absent
  // key reads as enabled, so the tile only hides on an explicit `false`.
  const achievementsEnabled = user?.modules?.achievements !== false;

  // `isPending` (no data yet, fetch in flight or gated) drives the
  // loading branch. Rendering the empty / content branch before the
  // query settles caused an appear-then-retract flash on a cold load:
  // the card painted its "no achievements yet" empty state (or stale
  // content) for the fetch window, then swapped once the real payload
  // landed. A skeleton holds the card's footprint without committing to
  // a content shape it may have to retract.
  const { data, isPending } = useAchievementsQuery({
    enabled: isAuthenticated && achievementsEnabled,
  });

  // The dashboard is a streamed Suspense boundary and hydrates after the app
  // shell. `<AchievementUnlockNotifier>` mounts with the shell and shares this
  // exact cache cell, so by the time this card replays its first render on the
  // client the payload is often already there — where the server had nothing
  // and painted the skeleton. Pinning the loading branch to the mount snapshot
  // keeps the hydration render identical to the server's; the unlocks land on
  // the re-render right after. See `useMounted`.
  const mounted = useMounted();
  const showSkeleton = !mounted || isPending;

  const recent = pickRecentUnlocks(data?.achievements ?? [], RECENT_LIMIT);

  // Module off ⇒ render nothing so the tile vanishes from the dashboard.
  if (!achievementsEnabled) {
    return null;
  }

  return (
    <Card data-slot="recent-achievements-card" className="gap-3 md:gap-3">
      {/* Canonical tile header (foreground h-5 icon, text-base h2) so the
          dashboard card matches its sibling tiles instead of the old muted
          h-4 / text-sm row. The "view all" link rides the header's right slot
          (§11 inline-action-row). */}
      <CardHeader>
        <TileHeader
          icon={Trophy}
          titleAs="h2"
          title={t("achievements.dashboardCard.title")}
          right={
            <InlineAction asChild tone="muted">
              <Link href="/achievements">
                {t("achievements.dashboardCard.viewAll")}
              </Link>
            </InlineAction>
          }
        />
      </CardHeader>

      <CardContent>
        {showSkeleton ? (
          <ul
            data-slot="recent-achievements-skeleton"
            aria-hidden="true"
            className="space-y-2 motion-reduce:animate-none"
          >
            {Array.from({ length: RECENT_LIMIT }).map((_, idx) => (
              <li
                key={`achievement-skeleton-${idx}`}
                className="border-border bg-background/40 flex items-center gap-3 rounded-md border p-2"
              >
                <Skeleton className="h-7 w-7 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-1/2 rounded" />
                  <Skeleton className="h-2.5 w-3/4 rounded" />
                </div>
              </li>
            ))}
          </ul>
        ) : recent.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("achievements.dashboardCard.empty")}
          />
        ) : (
          <ul className="space-y-2">
            {recent.map((achievement) => {
              const Icon = iconMap[achievement.icon] ?? Star;
              return (
                <li
                  key={achievement.id}
                  data-slot="recent-achievement-item"
                  className="border-border bg-background/40 flex items-center gap-3 rounded-md border p-2"
                >
                  <div className="bg-primary/15 text-primary rounded-md p-1.5">
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {t(achievement.titleKey)}
                    </p>
                    <p className="text-muted-foreground line-clamp-1 text-xs">
                      {t(achievement.descriptionKey)}
                    </p>
                  </div>
                  {achievement.completedAt && (
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {fmt.date(achievement.completedAt)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
