"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Bug,
  CalendarCheck,
  CalendarDays,
  FileText,
  Fingerprint,
  Flame,
  HelpCircle,
  Heart,
  KeyRound,
  Languages,
  Loader2,
  Lock,
  LogIn,
  Moon,
  Pill,
  Scale,
  ShieldCheck,
  SkipForward,
  Smile,
  Sparkles,
  Star,
  Sun,
  Target,
  Trophy,
  type LucideIcon,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/format";
import {
  ACHIEVEMENT_CATEGORY_ORDER,
  type AchievementCategory,
  type AchievementMetrics,
  type AchievementProgress,
  type AchievementSummary,
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
  CalendarDays,
  FileText,
  Pill,
  ShieldCheck,
  Target,
  Trophy,
  Heart,
  KeyRound,
  Fingerprint,
  Languages,
  LogIn,
  Bug,
  AlertTriangle,
  Moon,
  Scale,
  Smile,
  Sparkles,
  Sun,
  SkipForward,
};

const CATEGORY_LABEL_KEY: Record<AchievementCategory, string> = {
  medication: "achievements.categories.medication",
  vitals: "achievements.categories.vitals",
  mood: "achievements.categories.mood",
  security: "achievements.categories.security",
  engagement: "achievements.categories.engagement",
  hidden: "achievements.categories.hidden",
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

/**
 * Pure helper: bucket the achievements by their declared category in
 * ACHIEVEMENT_CATEGORY_ORDER's order. Categories with no badges (a
 * theoretical future state) are dropped from the output. Inside a
 * category, unlocked badges sort to the top so the user's progress is
 * always visible without scrolling.
 */
export function groupByCategory(
  achievements: AchievementProgress[],
): Array<{ category: AchievementCategory; items: AchievementProgress[] }> {
  const buckets = new Map<AchievementCategory, AchievementProgress[]>();
  for (const item of achievements) {
    const list = buckets.get(item.category) ?? [];
    list.push(item);
    buckets.set(item.category, list);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => {
      if (a.unlocked !== b.unlocked) return a.unlocked ? -1 : 1;
      // For locked items show the closest-to-unlock first; for unlocked
      // items keep them in insertion (definition) order — completedAt is
      // not always populated and would push newer unlocks below older
      // ones in a way that hides recent progress.
      if (a.unlocked && b.unlocked) return 0;
      return b.progressPercent - a.progressPercent;
    });
  }
  return ACHIEVEMENT_CATEGORY_ORDER.filter((category) =>
    buckets.has(category),
  ).map((category) => ({
    category,
    items: buckets.get(category) ?? [],
  }));
}

interface AchievementCardProps {
  achievement: AchievementProgress;
  t: ReturnType<typeof useTranslations>["t"];
}

function AchievementCard({ achievement, t }: AchievementCardProps) {
  const Icon = iconMap[achievement.icon] ?? Star;
  const unlocked = achievement.unlocked;

  // v1.4.18 — locked hidden achievements paint an opaque placeholder.
  // Critically, the actual title / description / metric / target are
  // never rendered to the DOM so the user can't peek into the source
  // to learn the trigger. Once unlocked the real strings appear.
  if (achievement.isHidden && !unlocked) {
    return (
      <div
        data-slot="achievement-card-hidden"
        aria-label={t("achievements.hiddenCard.ariaLabel")}
        className="border-border bg-card/40 rounded-xl border p-3 opacity-70"
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="bg-muted text-muted-foreground rounded-lg p-2">
              <HelpCircle className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">
                {t("achievements.hiddenCard.title")}
              </h3>
              <p className="text-muted-foreground line-clamp-2 text-xs">
                {t("achievements.hiddenCard.description")}
              </p>
            </div>
          </div>
          <Badge variant="secondary" className="shrink-0">
            <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
            {t("achievements.locked")}
          </Badge>
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot={
        unlocked ? "achievement-card-unlocked" : "achievement-card-locked"
      }
      className={
        unlocked
          ? "border-primary/30 from-primary/8 to-primary/0 rounded-xl border bg-gradient-to-br p-3"
          : "border-border bg-card/50 rounded-xl border p-3 opacity-70"
      }
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div
            className={
              unlocked
                ? "bg-primary/15 text-primary rounded-lg p-2"
                : "bg-muted text-muted-foreground rounded-lg p-2"
            }
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{t(achievement.titleKey)}</h3>
            <p className="text-muted-foreground line-clamp-2 text-xs">
              {t(achievement.descriptionKey)}
            </p>
          </div>
        </div>
        <Badge
          variant={unlocked ? "default" : "secondary"}
          className="shrink-0"
        >
          {unlocked ? (
            t("achievements.completed")
          ) : (
            <>
              <Lock className="mr-1 h-3 w-3" aria-hidden="true" />
              {t("achievements.locked")}
            </>
          )}
        </Badge>
      </div>

      {!unlocked && (
        <div className="mt-2 space-y-1.5">
          <p className="text-muted-foreground text-xs">
            {t("achievements.criterionHint", {
              current: formatMetric(achievement.format, achievement.current, t),
              target: formatMetric(achievement.format, achievement.target, t),
            })}
          </p>
          {/* v1.4.33 IW9 — aria-label so the bar carries an accessible name. */}
          <Progress
            value={achievement.progressPercent}
            className="h-1.5"
            aria-label={t("achievements.criterionHint", {
              current: formatMetric(
                achievement.format,
                achievement.current,
                t,
              ),
              target: formatMetric(achievement.format, achievement.target, t),
            })}
          />
        </div>
      )}

      <div className="text-muted-foreground mt-3 flex items-center justify-between text-xs">
        <span className="font-medium">
          {t("achievements.pointsValue", {
            points: achievement.points,
          })}
        </span>
        {unlocked ? (
          <span>
            {achievement.completedAt
              ? t("achievements.completedOn", {
                  date: formatDate(achievement.completedAt),
                })
              : t("achievements.goalReached")}
          </span>
        ) : (
          <span>
            {t("achievements.progressPercent", {
              percent: achievement.progressPercent,
            })}
          </span>
        )}
      </div>
    </div>
  );
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
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
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
  const grouped = groupByCategory(achievements);
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
          <p className="text-muted-foreground text-sm">
            {t("achievements.points")}
          </p>
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
            aria-label={t("achievements.points")}
          />
        </div>
        <div className="bg-card border-border flex min-h-34 flex-col justify-between rounded-xl border p-5">
          <p className="text-muted-foreground text-sm">
            {t("achievements.unlocked")}
          </p>
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
          <p className="text-muted-foreground text-sm">
            {t("achievements.nextGoal")}
          </p>
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
            aria-label={t("achievements.nextProgressLabel")}
          />
        </div>
      </div>

      {grouped.length === 0 ? (
        // v1.4.15 phase-C5: upgrade to the EmptyState primitive so the
        // surface matches the rest of the app. Trophy icon makes the
        // intent obvious before the user reads the copy. Reuses the
        // existing `noneUnlockedYet` string to avoid C4 i18n churn.
        <EmptyState
          icon={<Trophy className="size-6" />}
          title={t("achievements.noneUnlockedYet")}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(({ category, items }) => {
            const unlockedInCategory = items.filter(
              (item) => item.unlocked,
            ).length;
            return (
              <section
                key={category}
                aria-labelledby={`achievements-category-${category}`}
                data-slot="achievements-category"
                data-category={category}
              >
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h2
                    id={`achievements-category-${category}`}
                    className="text-base font-semibold tracking-tight"
                  >
                    {t(CATEGORY_LABEL_KEY[category])}
                  </h2>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {unlockedInCategory} / {items.length}
                  </span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((achievement) => (
                    <AchievementCard
                      key={achievement.id}
                      achievement={achievement}
                      t={t}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
