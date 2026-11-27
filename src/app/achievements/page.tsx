"use client";

import { useId, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bug,
  CalendarCheck,
  Check,
  CalendarDays,
  FileText,
  Fingerprint,
  Flame,
  HelpCircle,
  Heart,
  KeyRound,
  Languages,
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
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useAuth } from "@/hooks/use-auth";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useAchievementsQuery } from "@/lib/queries/use-achievements-query";
import {
  ACHIEVEMENT_CATEGORY_ORDER,
  type AchievementCategory,
  type AchievementProgress,
} from "@/lib/gamification/achievements";
import { TrendTile } from "@/components/ui/trend-tile";
import { cn } from "@/lib/utils";

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
  i18n: Pick<ReturnType<typeof useTranslations>, "t" | "tCount">,
) {
  if (format === "percent")
    return i18n.t("achievements.metricPercent", { count: value });
  // "1 Tag", not "1 Tage": the day count takes the plural form.
  if (format === "days") return i18n.tCount("achievements.metricDays", value);
  return i18n.t("achievements.metricCount", { count: value });
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

/**
 * One achievement as one row of its category's card (ui-standards §20):
 * the icon, the title over one meta line, the progress on the right. A tap
 * opens the row and shows what the achievement asks for, the count so far
 * and its points. A locked row says so once, through its progress, rather
 * than in a chip, a fraction and a percentage at once.
 */
function AchievementRow({ achievement }: { achievement: AchievementProgress }) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const i18n = { t, tCount };
  const Icon = iconMap[achievement.icon] ?? Star;
  const unlocked = achievement.unlocked;
  const fraction = t("achievements.criterionHint", {
    current: formatMetric(achievement.format, achievement.current, i18n),
    target: formatMetric(achievement.format, achievement.target, i18n),
  });
  const points = t("achievements.pointsValue", { points: achievement.points });

  return (
    <ListItem
      data-slot={
        unlocked ? "achievement-row-unlocked" : "achievement-row-locked"
      }
      onSelect={() => setOpen((v) => !v)}
      expanded={open}
      controls={detailId}
      icon={
        <span
          className={cn(
            "flex size-8 items-center justify-center rounded-lg",
            unlocked
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </span>
      }
      title={t(achievement.titleKey)}
      meta={
        unlocked
          ? achievement.completedAt
            ? t("achievements.completedOn", {
                date: fmt.date(achievement.completedAt),
              })
            : t("achievements.goalReached")
          : fraction
      }
      trailing={
        unlocked ? (
          <Check
            className="text-primary size-4"
            aria-label={t("achievements.completed")}
          />
        ) : (
          <span className="text-muted-foreground text-xs font-medium">
            {t("achievements.progressPercent", {
              percent: achievement.progressPercent,
            })}
          </span>
        )
      }
    >
      {open ? (
        <div
          id={detailId}
          data-slot="achievement-row-detail"
          className="space-y-2 px-4 pb-3 pl-15 text-sm"
        >
          <p>{t(achievement.descriptionKey)}</p>
          {unlocked ? null : (
            <Progress
              value={achievement.progressPercent}
              className="h-1.5"
              aria-label={fraction}
            />
          )}
          <p className="text-muted-foreground text-xs">{points}</p>
        </div>
      ) : null}
    </ListItem>
  );
}

/**
 * The hidden achievements not yet found, as one row. Their title,
 * description, metric and target never reach the DOM, so the source gives
 * nothing away; once one is unlocked it appears as an ordinary row.
 */
function HiddenRow({ count }: { count: number }) {
  const { t } = useTranslations();
  return (
    <ListItem
      data-slot="achievement-row-hidden"
      aria-label={t("achievements.hiddenCard.ariaLabel")}
      icon={
        <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-lg">
          <HelpCircle className="size-4" aria-hidden />
        </span>
      }
      title={t("achievements.hiddenCard.title")}
      meta={t("achievements.hiddenCard.description")}
      trailing={
        <span className="text-muted-foreground text-xs font-medium">
          {count}
        </span>
      }
    />
  );
}

export default function AchievementsPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();

  // v1.18.0 — the achievements module gate. When the account has the
  // module turned off the whole page disappears: an empty state stands in
  // for the badge grid and the data query never fires (the API would 403
  // anyway). Default-on: an absent key reads as enabled, so the page only
  // hides on an explicit `false`.
  const achievementsEnabled = user?.modules?.achievements !== false;

  // v1.4.34 — mother page rides the shared cache slot
  // alongside `<RecentAchievementsCard>` and
  // `<AchievementUnlockNotifier>` so the three consumers never trigger
  // more than one network call on a cold dashboard mount.
  const { data, isLoading, isError, error, refetch } = useAchievementsQuery({
    enabled: isAuthenticated && achievementsEnabled,
  });

  if (authLoading || (achievementsEnabled && isLoading)) {
    return <PageAuthGate label={t("common.loading")} />;
  }

  // Module off: the shell answers this URL with the module notice
  // (`ModulePageGate`) before the page renders, so there is no branch for it
  // here. `achievementsEnabled` above only keeps the query from firing.

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("achievements.title")}
          description={t("achievements.loginRequired")}
        />
      </div>
    );
  }

  // A failed load must never fall through to the zeroed summary tiles + the
  // "none unlocked yet" empty grid (ui-standards.md §6). Surface an honest
  // retry instead.
  if (isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("achievements.title")} />
        <QueryErrorCard error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  const summary = data?.summary;
  const achievements = data?.achievements ?? [];
  const grouped = groupByCategory(achievements);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span data-tour-id="achievements-hero">
            {t("achievements.title")}
          </span>
        }
      />

      <section
        data-slot="achievements-summary"
        aria-label={t("achievements.title")}
        className="space-y-2"
      >
        <TrendTile className="gap-3">
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-muted-foreground text-sm">
                {t("achievements.points")}
              </dt>
              <dd className="text-3xl leading-none font-bold tabular-nums">
                {fmt.integer(summary?.earnedPoints ?? 0)}
                <span className="text-muted-foreground ml-1.5 text-sm font-medium">
                  / {fmt.integer(summary?.totalPoints ?? 0)}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-sm">
                {t("achievements.unlocked")}
              </dt>
              <dd className="text-3xl leading-none font-bold tabular-nums">
                {summary?.unlockedCount ?? 0}
                <span className="text-muted-foreground ml-1.5 text-sm font-medium">
                  / {summary?.totalCount ?? 0}
                </span>
              </dd>
            </div>
          </dl>
          <Progress
            value={
              summary?.totalPoints
                ? Math.round((summary.earnedPoints / summary.totalPoints) * 100)
                : 0
            }
            className="h-1.5"
            aria-label={t("achievements.points")}
          />
        </TrendTile>
        {summary && !summary.nextAchievement && summary.totalCount > 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("achievements.allCompleted")}
          </p>
        ) : null}
      </section>

      {summary?.nextAchievement ? (
        <section
          aria-labelledby="achievements-next"
          data-slot="achievements-next"
          className="space-y-2"
        >
          <h2 id="achievements-next" className="text-sm font-semibold">
            {t("achievements.nextGoal")}
          </h2>
          <ListGroup>
            <AchievementRow achievement={summary.nextAchievement} />
          </ListGroup>
        </section>
      ) : null}

      {grouped.length === 0 ? (
        <EmptyState
          variant="plain"
          size="compact"
          icon={<Trophy className="size-6" />}
          title={t("achievements.noneUnlockedYet")}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(({ category, items }) => {
            const unlockedInCategory = items.filter(
              (item) => item.unlocked,
            ).length;
            const shown = items.filter(
              (item) => !(item.isHidden && !item.unlocked),
            );
            const hiddenLocked = items.length - shown.length;
            return (
              <section
                key={category}
                aria-labelledby={`achievements-category-${category}`}
                data-slot="achievements-category"
                data-category={category}
                className="space-y-2"
              >
                <h2
                  id={`achievements-category-${category}`}
                  className="flex items-baseline gap-2 text-sm font-semibold"
                >
                  {t(CATEGORY_LABEL_KEY[category])}
                  <span className="text-muted-foreground font-normal tabular-nums">
                    {unlockedInCategory} / {items.length}
                  </span>
                </h2>
                <ListGroup>
                  {shown.map((achievement) => (
                    <AchievementRow
                      key={achievement.id}
                      achievement={achievement}
                    />
                  ))}
                  {hiddenLocked > 0 ? <HiddenRow count={hiddenLocked} /> : null}
                </ListGroup>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
