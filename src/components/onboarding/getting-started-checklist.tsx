"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  Check,
  ChevronDown,
  Pill,
  User2,
  Wifi,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import {
  buildChecklist,
  checklistProgress,
  shouldShowChecklist,
  visibleChecklist,
  type ChecklistItemId,
} from "@/lib/onboarding/checklist";

const DISMISSED_ITEMS_KEY = "healthlog-getting-started-dismissed";
const DISMISSED_ALL_KEY = "healthlog-getting-started-hidden";
const EXPANDED_KEY = "healthlog-getting-started-expanded";

const ITEM_ICONS: Record<ChecklistItemId, LucideIcon> = {
  profile: User2,
  measurement: Activity,
  medication: Pill,
  withings: Wifi,
  notifications: Bell,
};

const ITEM_LABEL_KEYS: Record<
  ChecklistItemId,
  { title: string; description: string; cta: string }
> = {
  profile: {
    title: "gettingStarted.items.profileTitle",
    description: "gettingStarted.items.profileDescription",
    cta: "gettingStarted.items.profileCta",
  },
  measurement: {
    title: "gettingStarted.items.measurementTitle",
    description: "gettingStarted.items.measurementDescription",
    cta: "gettingStarted.items.measurementCta",
  },
  medication: {
    title: "gettingStarted.items.medicationTitle",
    description: "gettingStarted.items.medicationDescription",
    cta: "gettingStarted.items.medicationCta",
  },
  withings: {
    title: "gettingStarted.items.withingsTitle",
    description: "gettingStarted.items.withingsDescription",
    cta: "gettingStarted.items.withingsCta",
  },
  notifications: {
    title: "gettingStarted.items.notificationsTitle",
    description: "gettingStarted.items.notificationsDescription",
    cta: "gettingStarted.items.notificationsCta",
  },
};

interface AnalyticsData {
  summaries?: Record<string, { count?: number } | undefined>;
}

interface WithingsStatus {
  connected?: boolean;
}

interface NotificationChannel {
  type?: string;
  enabled?: boolean;
}

interface NotificationsPreferences {
  channels?: NotificationChannel[];
}

function readDismissedSet(): Set<ChecklistItemId> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_ITEMS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(
        parsed.filter((id): id is ChecklistItemId => typeof id === "string"),
      );
    }
  } catch {
    /* ignore corrupt storage */
  }
  return new Set();
}

function readDismissedAll(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISSED_ALL_KEY) === "1";
  } catch {
    return false;
  }
}

function readExpanded(): boolean {
  // Default = collapsed. v1.4.15 phase-A3 fix #3: the card auto-opening
  // on every page-load was the dominant complaint after the flicker —
  // it pushed the actual dashboard tiles below the fold every visit.
  // We persist the user's last choice so a deliberate expand survives
  // reloads, but the *default* for a brand-new user (no key set) is
  // collapsed.
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Persistent dashboard checklist surfaced to brand-new users. Mirrors
 * the Linear/Notion pattern: visible until the user has either
 * completed every step or explicitly hidden it. Each row is one line
 * with status icon + label + CTA + dismiss-x.
 */
export function GettingStartedChecklist() {
  const { user } = useAuth();
  const { t } = useTranslations();

  const [dismissedIds, setDismissedIds] = useState<Set<ChecklistItemId>>(() =>
    readDismissedSet(),
  );
  const [dismissedAll, setDismissedAll] = useState<boolean>(() =>
    readDismissedAll(),
  );
  // v1.4.15 phase-A3 fix #3 — collapsed by default. The card used to
  // render expanded on every load, pushing actual dashboard tiles below
  // the fold. The collapsed shell still surfaces the progress meter +
  // CTA-row count via `gettingStarted.progress`, so users see at a
  // glance how much setup is left without the visual noise.
  const [expanded, setExpanded] = useState<boolean>(() => readExpanded());

  // Sync state to localStorage. Effect, not setState-in-effect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        DISMISSED_ITEMS_KEY,
        JSON.stringify([...dismissedIds]),
      );
    } catch {
      /* storage may be full or disabled */
    }
  }, [dismissedIds]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(DISMISSED_ALL_KEY, dismissedAll ? "1" : "0");
    } catch {
      /* storage may be full or disabled */
    }
  }, [dismissedAll]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
    } catch {
      /* storage may be full or disabled */
    }
  }, [expanded]);

  // Light-weight queries: each fetch is small and cached by tanstack.
  // We rely on the React Query cache the dashboard already uses for
  // analytics, so this won't fire a second request when the dashboard
  // and the checklist mount together. v1.4.33 IW2 routes the checklist
  // onto IW1's slim `?slice=summaries` branch — the only field
  // consumed is `summaries[METRIC].count`, which the slim slice fills
  // directly. The cache slot is distinct from the dashboard's thick
  // slice but each consumer's payload is byte-correct for its own
  // reads, and the shared hook keeps the legacy `?.data` unwrap so the
  // canonical consumers still see `{summaries, …}` not `{data: …}`.
  const analyticsQuery = useAnalyticsQuery({
    slice: "summaries",
    enabled: !!user,
  });
  const analyticsData = analyticsQuery.data as AnalyticsData | undefined;

  const { data: medsData } = useQuery<Array<{ id: string }>>({
    queryKey: ["medications"],
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data;
    },
    enabled: !!user,
  });

  // v1.5 perf audit: skip these two fetches once the user is past
  // onboarding. The checklist hides itself anyway via shouldShowChecklist
  // when onboardingCompletedAt != null AND measurementCount >= 5; the
  // analytics + medications queries above piggy-back on the dashboard's
  // shared cache, but withings/status and notifications/preferences are
  // unique to this component and were burning ~950 ms of network on every
  // dashboard load for established users. See docs/audit/v15-performance.md.
  const onboardingPending = !!user && user.onboardingCompletedAt == null;

  const { data: withingsData } = useQuery<WithingsStatus>({
    queryKey: ["withings", "status"],
    queryFn: async () => {
      const res = await fetch("/api/withings/status");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data;
    },
    enabled: onboardingPending,
  });

  const { data: notificationsData } = useQuery<NotificationsPreferences>({
    queryKey: ["notifications", "preferences"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/preferences");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data;
    },
    enabled: onboardingPending,
  });

  const measurementCount = useMemo(() => {
    const summaries = analyticsData?.summaries ?? {};
    let total = 0;
    for (const key of Object.keys(summaries)) {
      total += summaries[key]?.count ?? 0;
    }
    return total;
  }, [analyticsData]);

  const medicationCount = medsData?.length ?? 0;
  const withingsConnected = withingsData?.connected === true;
  const notificationsConfigured = (notificationsData?.channels ?? []).some(
    (channel) => channel?.enabled === true,
  );

  const items = useMemo(
    () =>
      buildChecklist({
        profile: {
          heightCm: user?.heightCm ?? null,
          dateOfBirth: user?.dateOfBirth ?? null,
          gender: user?.gender ?? null,
        },
        measurementCount,
        medicationCount,
        withingsConnected,
        notificationsConfigured,
        dismissedIds,
      }),
    [
      user?.heightCm,
      user?.dateOfBirth,
      user?.gender,
      measurementCount,
      medicationCount,
      withingsConnected,
      notificationsConfigured,
      dismissedIds,
    ],
  );

  const visible = visibleChecklist(items);
  const progress = checklistProgress(items);

  const show = shouldShowChecklist({
    onboardingCompletedAt: user?.onboardingCompletedAt ?? null,
    measurementCount,
    dismissedAll,
    items,
  });

  // v1.4.15 phase-A3 fix #3 — flicker guard. Until BOTH the auth user
  // AND the analytics query have resolved we render NOTHING. The
  // previous version rendered a default-true `show` branch while
  // `measurementCount` was still 0 (because analytics hadn't returned),
  // so a user whose actual `measurementCount >= 5` saw the card flash
  // for ~500 ms before `shouldShowChecklist` flipped to false. We rely
  // on `analyticsQuery.data === undefined` as the loading sentinel —
  // tanstack-query writes `data` exactly once per fetch, so this is
  // race-free across hot-reloads and stale-cache invalidation. (The
  // dashboard's `/api/analytics` query shares the cache key, so the
  // checklist almost always sees the cached value synchronously on
  // mount and never blocks UI.)
  if (!user) return null;
  if (analyticsQuery.data === undefined) return null;
  if (!show) return null;

  return (
    <section
      data-testid="onboarding-card"
      aria-labelledby="getting-started-title"
      className="bg-card border-border space-y-4 rounded-2xl border p-5 sm:p-6"
    >
      {/* v1.4.27 MB7 / CF-44 — `flex-wrap` on the header lets the
          dismiss button drop to its own row when the German title +
          subtitle overflow the visible width on Galaxy Fold / Pixel 5
          (the previous `flex` layout collided the dismiss caption
          against the chevron). `min-w-0` on the toggle button lets
          the inner `<h2>` shrink + truncate cleanly instead of
          pushing the chevron off-screen. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          aria-controls="getting-started-body"
          className="hover:text-foreground -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors"
        >
          <ChevronDown
            aria-hidden="true"
            className={
              expanded
                ? "size-4 shrink-0 transition-transform"
                : "size-4 shrink-0 -rotate-90 transition-transform"
            }
          />
          <div className="min-w-0 space-y-1">
            <h2
              id="getting-started-title"
              className="truncate text-base font-semibold tracking-tight"
            >
              {t("gettingStarted.title")}
            </h2>
            {expanded ? (
              <p className="text-muted-foreground text-sm">
                {t("gettingStarted.subtitle")}
              </p>
            ) : null}
          </div>
        </button>
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissedAll(true)}
        >
          {t("gettingStarted.dismissAll")}
        </Button>
      </header>

      {/* Progress meter — non-decorative, exposed to screen readers.
          Stays visible in both expanded and collapsed states so a
          glance at the card tells the user how much setup is left
          without forcing the full row-list back open. */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label={t("gettingStarted.progress", {
          done: progress.done,
          total: progress.total,
        })}
        className="space-y-1"
      >
        <div className="text-muted-foreground flex justify-between text-xs">
          <span>
            {t("gettingStarted.progress", {
              done: progress.done,
              total: progress.total,
            })}
          </span>
          <span className="tabular-nums">{progress.percent}%</span>
        </div>
        <div className="bg-muted h-1.5 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      {expanded ? (
        <ul id="getting-started-body" className="space-y-1.5">
          {visible.map((item) => {
            const Icon = ITEM_ICONS[item.id];
            const labels = ITEM_LABEL_KEYS[item.id];
            return (
              <li
                key={item.id}
                className="hover:bg-accent/40 group flex items-center gap-3 rounded-md px-2 py-2"
              >
                <span
                  aria-hidden="true"
                  className={
                    item.done
                      ? "bg-primary/20 text-primary flex size-7 shrink-0 items-center justify-center rounded-full"
                      : "bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full"
                  }
                >
                  {item.done ? (
                    <Check className="size-4" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={
                      item.done
                        ? "text-muted-foreground truncate text-sm line-through"
                        : "truncate text-sm font-medium"
                    }
                  >
                    {t(labels.title)}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {t(labels.description)}
                  </p>
                </div>
                {!item.done ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={item.href}>{t(labels.cta)}</Link>
                  </Button>
                ) : null}
                <button
                  type="button"
                  onClick={() =>
                    setDismissedIds((prev) => {
                      const next = new Set(prev);
                      next.add(item.id);
                      return next;
                    })
                  }
                  aria-label={t("gettingStarted.dismissTooltip")}
                  className="text-muted-foreground hover:text-foreground inline-flex h-11 w-11 items-center justify-center rounded transition-colors"
                >
                  <X className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
