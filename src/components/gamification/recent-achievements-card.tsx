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
import { useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/format";
import { useAchievementsQuery } from "@/lib/queries/use-achievements-query";
import type { AchievementProgress } from "@/lib/gamification/achievements";

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
 * v1.4.15 phase-B4 — small dashboard card surfacing the user's three
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

  const { data } = useAchievementsQuery();

  const recent = pickRecentUnlocks(data?.achievements ?? [], RECENT_LIMIT);

  return (
    <div
      data-slot="recent-achievements-card"
      className="bg-card border-border space-y-3 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Trophy className="text-primary h-4 w-4" aria-hidden="true" />
          <h2 className="text-sm font-semibold">
            {t("achievements.dashboardCard.title")}
          </h2>
        </div>
        <Link
          href="/achievements"
          className="text-primary hover:text-primary/80 text-xs font-medium underline-offset-4 hover:underline"
        >
          {t("achievements.dashboardCard.viewAll")}
        </Link>
      </div>

      {recent.length === 0 ? (
        <p className="text-muted-foreground py-2 text-sm">
          {t("achievements.dashboardCard.empty")}
        </p>
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
                    {formatDate(achievement.completedAt)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
