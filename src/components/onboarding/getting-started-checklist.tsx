"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bell, Check, Pill, User2, Wifi, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  buildChecklist,
  checklistProgress,
  shouldShowChecklist,
  visibleChecklist,
  type ChecklistItemId,
} from "@/lib/onboarding/checklist";

const DISMISSED_ITEMS_KEY = "healthlog-getting-started-dismissed";
const DISMISSED_ALL_KEY = "healthlog-getting-started-hidden";

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

interface MedicationsResponse {
  data?: { medications?: Array<{ id: string }> };
}

interface AnalyticsResponse {
  data?: {
    summaries?: Record<string, { count?: number } | undefined>;
  };
}

interface WithingsStatusResponse {
  data?: { connected?: boolean };
}

interface NotificationChannel {
  type?: string;
  enabled?: boolean;
}

interface NotificationsResponse {
  data?: { channels?: NotificationChannel[] };
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

  // Light-weight queries: each fetch is small and cached by tanstack.
  // We rely on the React Query cache the dashboard already uses for
  // analytics, so this won't fire a second request when the dashboard
  // and the checklist mount together.
  const { data: analyticsRes } = useQuery<AnalyticsResponse>({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: medsRes } = useQuery<MedicationsResponse>({
    queryKey: ["medications"],
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: withingsRes } = useQuery<WithingsStatusResponse>({
    queryKey: ["withings", "status"],
    queryFn: async () => {
      const res = await fetch("/api/withings/status");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: notificationsRes } = useQuery<NotificationsResponse>({
    queryKey: ["notifications", "preferences"],
    queryFn: async () => {
      const res = await fetch("/api/notifications/preferences");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!user,
  });

  const measurementCount = useMemo(() => {
    const summaries = analyticsRes?.data?.summaries ?? {};
    let total = 0;
    for (const key of Object.keys(summaries)) {
      total += summaries[key]?.count ?? 0;
    }
    return total;
  }, [analyticsRes]);

  const medicationCount = medsRes?.data?.medications?.length ?? 0;
  const withingsConnected = withingsRes?.data?.connected === true;
  const notificationsConfigured = (notificationsRes?.data?.channels ?? []).some(
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

  if (!user || !show) return null;

  return (
    <section
      aria-labelledby="getting-started-title"
      className="bg-card border-border space-y-4 rounded-2xl border p-5 sm:p-6"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2
            id="getting-started-title"
            className="text-base font-semibold tracking-tight"
          >
            {t("gettingStarted.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("gettingStarted.subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setDismissedAll(true)}
        >
          {t("gettingStarted.dismissAll")}
        </Button>
      </header>

      {/* Progress meter — non-decorative, exposed to screen readers. */}
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
          <span className="font-mono tabular-nums">{progress.percent}%</span>
        </div>
        <div className="bg-muted h-1.5 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      <ul className="space-y-1.5">
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
                className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
              >
                <X className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
