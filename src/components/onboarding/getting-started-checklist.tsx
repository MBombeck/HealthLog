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
  Sparkles,
  Stethoscope,
  User2,
  UserPlus,
  Wifi,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAccountOnceMounted } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { useDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { queryKeys } from "@/lib/query-keys";
import {
  buildChecklist,
  checklistProgress,
  shouldShowChecklist,
  upcomingVisitCountFrom,
  visibleChecklist,
  type ChecklistItemId,
} from "@/lib/onboarding/checklist";
import { apiGet } from "@/lib/api/api-fetch";
import {
  CHECKLIST_DISMISSED_ALL_KEY as DISMISSED_ALL_KEY,
  CHECKLIST_DISMISSED_ITEMS_KEY as DISMISSED_ITEMS_KEY,
  CHECKLIST_EXPANDED_KEY as EXPANDED_KEY,
} from "@/lib/onboarding/checklist-storage";
import { questionOptionLabelKey } from "@/lib/onboarding/question-config";
import { isBrowserConnectableSource } from "@/lib/onboarding/wizard-steps";

const ITEM_ICONS: Record<ChecklistItemId, LucideIcon> = {
  profile: User2,
  measurement: Activity,
  medication: Pill,
  dataSource: Wifi,
  notifications: Bell,
  insights: Sparkles,
  visit: Stethoscope,
  managedProfile: UserPlus,
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
  dataSource: {
    title: "gettingStarted.items.dataSourceTitle",
    description: "gettingStarted.items.dataSourceDescription",
    cta: "gettingStarted.items.dataSourceCta",
  },
  notifications: {
    title: "gettingStarted.items.notificationsTitle",
    description: "gettingStarted.items.notificationsDescription",
    cta: "gettingStarted.items.notificationsCta",
  },
  insights: {
    title: "gettingStarted.items.insightsTitle",
    description: "gettingStarted.items.insightsDescription",
    cta: "gettingStarted.items.insightsCta",
  },
  visit: {
    title: "gettingStarted.items.visitTitle",
    description: "gettingStarted.items.visitDescription",
    cta: "gettingStarted.items.visitCta",
  },
  managedProfile: {
    title: "gettingStarted.items.managedProfileTitle",
    description: "gettingStarted.items.managedProfileDescription",
    cta: "gettingStarted.items.managedProfileCta",
  },
};

interface IntegrationsStatus {
  integrations?: Array<{ connected?: boolean; enabled?: boolean }>;
}

interface NotificationChannel {
  type?: string;
  enabled?: boolean;
}

interface NotificationsPreferences {
  channels?: NotificationChannel[];
}

interface AiProviderStatus {
  /**
   * True iff any provider can serve the user — personal key, local
   * model, OAuth sign-in, or the operator's shared key. Mirrors the
   * `insights` checklist row's `done` predicate.
   */
  aiAvailable?: boolean;
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
  // Withheld until mounted: this card lives inside the dashboard's streamed
  // boundary and its whole render turns on `if (!user) return null` below. The
  // shell has usually answered `/api/auth/me` before the boundary hydrates, so
  // reading the payload on the hydration render would paint a card where the
  // server painted nothing — a mismatch that discards the streamed dashboard.
  // See `useAccountOnceMounted`.
  const user = useAccountOnceMounted();
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

  // v1.15.20 — the measurement count is derived from the dashboard
  // snapshot the page already fetches (`tiles.summaries` is the same
  // `computeSummariesSlice` payload the legacy `?slice=summaries`
  // analytics query carried), so the checklist no longer fires its own
  // analytics request on every dashboard load. Subscribing to the shared
  // `queryKeys.dashboardSnapshot()` cell costs zero extra network.
  const snapshotQuery = useDashboardSnapshot(!!user);
  const snapshotData = snapshotQuery.data;

  const measurementCount = useMemo(() => {
    const summaries = snapshotData?.tiles?.summaries ?? {};
    let total = 0;
    for (const key of Object.keys(summaries)) {
      total += summaries[key]?.count ?? 0;
    }
    return total;
  }, [snapshotData]);

  // v1.15.20 — only fetch the checklist's supporting data while the card
  // can actually render: the user is still in setup (`shouldShowChecklist`'s
  // `onboardingCompletedAt == null || measurementCount < 5` rule) and has
  // not dismissed it. Established users used to pay this medications fetch
  // (and, pre-v1.5, two more) on every dashboard load for a card that
  // never mounts. Gated on the snapshot having resolved so the count is
  // real, not the loading-default 0.
  const checklistRelevant =
    !!user &&
    !dismissedAll &&
    snapshotData !== undefined &&
    (user.onboardingCompletedAt == null || measurementCount < 5);

  const { data: medsData } = useQuery<Array<{ id: string }>>({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      return apiGet("/api/medications");
    },
    enabled: checklistRelevant,
  });

  // v1.28 — the "Turn on insights" row self-satisfies from real provider
  // state. `/api/user/ai-provider` reports `aiAvailable` presence-only
  // (personal key OR local model OR OAuth OR the operator's shared key),
  // so connecting a provider — or landing on a shared-key deployment —
  // flips the row done with no client-side credential handling. Gated on
  // `checklistRelevant` so it only fetches while the card can render.
  const { data: aiProviderData } = useQuery<AiProviderStatus>({
    queryKey: queryKeys.userAiProvider(),
    queryFn: async () => {
      return apiGet("/api/user/ai-provider");
    },
    enabled: checklistRelevant,
  });

  // v1.5 perf audit: skip these two fetches once the card can't render at
  // all (`checklistRelevant`, same gate the meds/AI queries above use).
  // withings/status and notifications/preferences are unique to this
  // component and were burning ~950 ms of network on every dashboard load
  // for established users. See docs/audit/v15-performance.md.
  //
  // 2026-07-17 UX audit M1 — this used to read a separate `onboardingPending`
  // (`onboardingCompletedAt == null`) instead of `checklistRelevant`, so a
  // user who finished the wizard but still had under 5 measurements kept
  // seeing the card (`shouldShowChecklist` allows that) while these two
  // queries stayed disabled forever: "Connect a data source" and
  // "Configure notifications" could never flip done even after the user
  // actually connected Withings or a push channel post-wizard.

  // v1.17.0 — any connected data source satisfies the step, so we read
  // the consolidated integrations envelope (Withings / WHOOP / Fitbit /
  // Google Health / …) rather than the Withings-only status route.
  const { data: integrationsData } = useQuery<IntegrationsStatus>({
    queryKey: queryKeys.integrationsStatus(),
    queryFn: async () => {
      return apiGet("/api/integrations/status");
    },
    enabled: checklistRelevant,
  });

  const { data: notificationsData } = useQuery<NotificationsPreferences>({
    queryKey: queryKeys.notificationsPreferences(),
    queryFn: async () => {
      return apiGet("/api/notifications/preferences");
    },
    enabled: checklistRelevant,
  });

  // v1.39 (C2) — the "prepare the visit" row, only for the answer that asked
  // for it: a visit within a month. Reads the visits list's own meta count so
  // the row flips done the moment one is on the calendar.
  // Answers given for somebody else's record (Q1 "someone I look after") are
  // the child's, not this dashboard's: no visit row, no named source here.
  const answersAreOwn = user?.onboarding?.needs.recordTarget !== "someone-else";
  const visitAsked =
    answersAreOwn && user?.onboarding?.needs.visit === "within-a-month";
  const { data: upcomingVisitCount } = useQuery<number>({
    queryKey: queryKeys.onboardingUpcomingVisits(),
    queryFn: async () =>
      upcomingVisitCountFrom(
        await apiGet<{ upcoming: unknown[] }>("/api/encounters"),
      ),
    enabled: checklistRelevant && visitAsked,
  });

  // The named source: "Connect Oura" rather than "Connect a data source"
  // for somebody who said their readings come from one.
  const namedSource = answersAreOwn
    ? (user?.onboarding?.needs.sources.find(isBrowserConnectableSource) ?? null)
    : null;
  const managedProfileCount = (user?.accountAccess?.accounts ?? []).filter(
    (entry) => entry.recordKind === "managed",
  ).length;

  const medicationCount = medsData?.length ?? 0;
  const dataSourceConnected = (integrationsData?.integrations ?? []).some(
    (integration) =>
      integration?.connected === true || integration?.enabled === true,
  );
  const notificationsConfigured = (notificationsData?.channels ?? []).some(
    (channel) => channel?.enabled === true,
  );
  const insightsConfigured = aiProviderData?.aiAvailable === true;

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
        dataSourceConnected,
        notificationsConfigured,
        insightsConfigured,
        dismissedIds,
        upcomingVisitCount: upcomingVisitCount ?? 0,
        managedProfileCount,
        // v1.39 (C1) — the setup answers order these rows: medication first
        // for somebody who said they take one daily, the data-source row first
        // for somebody who named a wearable. The payload resolves them for the
        // ACTIVE record, which is the same record the counts above describe.
        // Null until the payload resolves, and for a record that never entered
        // the flow.
        onboarding: user?.onboarding ?? null,
      }),
    [
      user?.heightCm,
      user?.dateOfBirth,
      user?.gender,
      user?.onboarding,
      measurementCount,
      medicationCount,
      dataSourceConnected,
      notificationsConfigured,
      insightsConfigured,
      dismissedIds,
      upcomingVisitCount,
      managedProfileCount,
    ],
  );

  const visible = visibleChecklist(items);
  const progress = checklistProgress(items);

  const show = shouldShowChecklist({
    onboardingCompletedAt: user?.onboardingCompletedAt ?? null,
    measurementCount,
    dismissedAll,
    items,
    // v1.39 (C1) — five readings are not evidence the setup finished. While a
    // step is still pending, the answers were never confirmed, or the one task
    // the flow offered never produced its result, the list stays.
    onboarding: user?.onboarding ?? null,
  });

  // v1.4.15 phase-A3 fix #3 — flicker guard. Until BOTH the auth user
  // AND the snapshot query have resolved we render NOTHING. The
  // previous version rendered a default-true `show` branch while
  // `measurementCount` was still 0 (because the data hadn't returned),
  // so a user whose actual `measurementCount >= 5` saw the card flash
  // for ~500 ms before `shouldShowChecklist` flipped to false. We rely
  // on `snapshotData === undefined` as the loading sentinel —
  // tanstack-query writes `data` exactly once per fetch, so this is
  // race-free across hot-reloads and stale-cache invalidation. (The
  // dashboard's snapshot query shares the cache key, so the checklist
  // almost always sees the cached value synchronously on mount and
  // never blocks UI.)
  if (!user) return null;
  if (snapshotData === undefined) return null;
  if (!show) return null;

  return (
    <section
      data-testid="onboarding-card"
      aria-labelledby="getting-started-title"
      className="bg-card border-border space-y-4 rounded-xl border p-4 md:p-6"
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
          // v1.4.37 W-CI — lift the toggle to clear the WCAG 2.5.5 mobile
          // tap-target floor on Pixel-5 (the maintainer's iOS-textarea-zoom sweep
          // pinned the floor at 44 px; the previous `p-1` padding left
          // the toggle at 32 px). `sm:min-h-10` returns to the desktop
          // 40 px tier so the dashboard header rhythm is unchanged.
          className="hover:text-foreground -m-1 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors sm:min-h-10"
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
          // v1.4.37 W-CI — the shadcn `default` Button is `h-10` (40 px)
          // across breakpoints; lift to 44 px on mobile to clear the
          // WCAG 2.5.5 floor that the rest of the input primitives
          // follow via `h-11 sm:h-10`. The dismiss CTA is one of the
          // few primary buttons rendered above the fold on the
          // onboarded-user dashboard so the regression was visible to
          // the touch-target spec.
          // v1.4.38 W-D P3-3 — align the desktop floor with the
          // dashboard +Hinzufügen pattern (`sm:min-h-9`); the
          // `sm:min-h-10` here was a no-op against the Button default
          // of `h-10`.
          className="text-muted-foreground hover:text-foreground min-h-11 sm:min-h-9"
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
                data-item-id={item.id}
                data-done={item.done}
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
                    {item.id === "dataSource" && namedSource
                      ? t("gettingStarted.items.dataSourceNamedTitle", {
                          source: t(
                            questionOptionLabelKey("sources", namedSource),
                          ),
                        })
                      : t(labels.title)}
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
