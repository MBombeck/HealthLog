"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bug,
  CalendarCheck,
  Fingerprint,
  Flame,
  Heart,
  KeyRound,
  Loader2,
  LogIn,
  Pill,
  ShieldCheck,
  SkipForward,
  Star,
  Target,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/format";
import type {
  AchievementMetrics,
  AchievementProgress,
  AchievementSummary,
} from "@/lib/gamification/achievements";

interface AchievementsData {
  summary: AchievementSummary;
  achievements: AchievementProgress[];
  metrics: AchievementMetrics;
}

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

function formatMetric(
  format: AchievementProgress["format"],
  value: number,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (format === "percent")
    return t("achievements.metricPercent", { count: value });
  if (format === "days") return t("achievements.metricDays", { count: value });
  return t("achievements.metricCount", { count: value });
}

export default function AchievementsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: ["gamification", "achievements"],
    queryFn: async () => {
      const res = await fetch("/api/gamification/achievements");
      if (!res.ok) throw new Error("Failed to load achievements");
      const json = await res.json();
      return json.data as AchievementsData;
    },
    enabled: isAuthenticated,
  });

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="text-primary h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">
          {t("achievements.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("achievements.loginRequired")}
        </p>
      </div>
    );
  }

  const summary = data?.summary;
  const achievements = data?.achievements ?? [];
  const unlockedAchievements = achievements.filter((item) => item.unlocked);
  const remainingUnlocks = Math.max(
    0,
    (summary?.totalCount ?? 0) - (summary?.unlockedCount ?? 0),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("achievements.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("achievements.subtitle")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="bg-card border-border flex min-h-34 flex-col justify-between rounded-xl border p-5">
          <p className="text-muted-foreground text-sm">{t("achievements.points")}</p>
          <p className="text-4xl leading-none font-bold md:text-5xl">
            {summary?.earnedPoints ?? 0}
            <span className="text-muted-foreground ml-2 text-base font-medium">
              / {summary?.totalPoints ?? 0}
            </span>
          </p>
          <Progress
            value={
              summary?.totalPoints
                ? Math.round((summary.earnedPoints / summary.totalPoints) * 100)
                : 0
            }
            className="h-1.5"
          />
        </div>
        <div className="bg-card border-border flex min-h-34 flex-col justify-between rounded-xl border p-5">
          <p className="text-muted-foreground text-sm">{t("achievements.unlocked")}</p>
          <p className="text-4xl leading-none font-bold md:text-5xl">
            {summary?.unlockedCount ?? 0}
            <span className="text-muted-foreground ml-2 text-base font-medium">
              / {summary?.totalCount ?? 0}
            </span>
          </p>
          <p className="text-muted-foreground text-xs">
            {t("achievements.remainingUnlocks", { count: remainingUnlocks })}
          </p>
        </div>
        <div className="bg-card border-border min-h-34 rounded-xl border p-5 sm:col-span-2 lg:col-span-1">
          <p className="text-muted-foreground text-sm">{t("achievements.nextGoal")}</p>
          {summary?.nextAchievement ? (
            <div className="mt-3 space-y-2">
              <p className="text-base font-semibold">
                {t(summary.nextAchievement.titleKey)}
              </p>
              <p className="text-muted-foreground line-clamp-2 text-xs">
                {t(summary.nextAchievement.descriptionKey)}
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {t("achievements.nextProgressLabel")}:{" "}
                {formatMetric(
                  summary.nextAchievement.format,
                  summary.nextAchievement.current,
                  t,
                )}{" "}
                /{" "}
                {formatMetric(
                  summary.nextAchievement.format,
                  summary.nextAchievement.target,
                  t,
                )}{" "}
                ({summary.nextAchievement.progressPercent}%)
              </p>
              <p className="text-muted-foreground text-xs">
                {t("achievements.pointsValue", {
                  points: summary.nextAchievement.points,
                })}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm font-medium">
              {t("achievements.allCompleted")}
            </p>
          )}
          <Progress
            value={summary?.nextAchievement?.progressPercent ?? 100}
            className="mt-3 h-1.5"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {unlockedAchievements.map((achievement) => {
          const Icon = iconMap[achievement.icon] ?? Star;

          return (
            <div
              key={achievement.id}
              className="border-primary/30 from-primary/8 to-primary/0 rounded-xl border bg-gradient-to-br p-3"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/15 text-primary rounded-lg p-2">
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold">
                      {t(achievement.titleKey)}
                    </h2>
                    <p className="text-muted-foreground line-clamp-2 text-xs">
                      {t(achievement.descriptionKey)}
                    </p>
                  </div>
                </div>
                <Badge variant="default" className="shrink-0">
                  {t("achievements.completed")}
                </Badge>
              </div>

              <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
                <span className="font-medium">
                  {t("achievements.pointsValue", {
                    points: achievement.points,
                  })}
                </span>
                <span>
                  {achievement.completedAt
                    ? t("achievements.completedOn", {
                        date: formatDate(achievement.completedAt),
                      })
                    : t("achievements.goalReached")}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {unlockedAchievements.length === 0 && (
        <div className="bg-card border-border rounded-xl border p-6 text-center">
          <p className="text-muted-foreground text-sm">
            {t("achievements.noneUnlockedYet")}
          </p>
        </div>
      )}
    </div>
  );
}
