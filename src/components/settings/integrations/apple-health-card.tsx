"use client";

/**
 * Apple Health — the one integration with no ledger row and no cron.
 *
 * The iOS app pushes; nothing here polls. The card used to derive its status
 * from the mere presence of `lastSyncedAt`, so any timestamp at all painted the
 * green "data received" chip — a pipe dead for three weeks looked exactly like
 * one that delivered this morning. It now reads the server's verdict, which
 * applies a seven-day threshold to the same timestamp, and renders the shared
 * pill instead of a bespoke badge so the flagship integration speaks the same
 * status language as its siblings.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { HeartPulse, Upload } from "lucide-react";

import { SettingsCardHeader } from "@/components/settings/_card-header";
import { SettingsCard } from "@/components/settings/settings-card";
import {
  formatRelative,
  IntegrationStatusPill,
} from "@/components/settings/integration-status-pill";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { HealthKitFreshnessEntry } from "@/lib/integrations/healthkit-type-sync";
import type { SyncHealth } from "@/lib/integrations/sync-verdict";
import { queryKeys } from "@/lib/query-keys";

import { MetricFreshnessDisclosure } from "./metric-freshness-disclosure";
import { IntegrationErrorMessage, pillStateForVerdict } from "./shared";

type SyncTrigger = "foreground" | "background" | "push" | "manual";

interface HealthKitStatus {
  lastSyncedAt: string | null;
  /** What the client said woke it for the most recent accepted batch. */
  lastSyncTrigger?: SyncTrigger | null;
  /** When data last arrived without the app being opened. */
  lastBackgroundSyncAt?: string | null;
  syncHealth?: SyncHealth;
  /** Per type: newest sample, plus when it last arrived and how (#1173). */
  metricFreshness?: HealthKitFreshnessEntry[];
  /** Server-side backfill progress (#778); null when the read failed. */
  syncProgress?: {
    recordsAccepted: number;
    oldestMeasuredAt: string | null;
  } | null;
}

/**
 * How long after the last accepted batch the progress line stops claiming
 * data is flowing. The server tracks no device-side throttle or queue state,
 * so the only honest signal is the age of the newest batch: within the hour
 * reads as "still arriving", beyond it as "waiting for the iPhone app" — a
 * backfill that iOS has parked and a backfill that finished look identical
 * from here, and the copy says neither is an error.
 */
const PROGRESS_WAITING_AFTER_MS = 60 * 60 * 1000;

const TRIGGER_KEYS: Record<SyncTrigger, string> = {
  foreground: "settings.appleHealth.delivery.trigger.foreground",
  background: "settings.appleHealth.delivery.trigger.background",
  push: "settings.appleHealth.delivery.trigger.push",
  manual: "settings.appleHealth.delivery.trigger.manual",
};

/**
 * Whether the phone is delivering on its own, or only while someone is looking
 * at it. `lastSyncedAt` cannot tell those apart — a card that reports nothing
 * but "last sync 10 minutes ago" reads identically in both cases, which is why
 * "is background delivery working?" was unanswerable from either side. The
 * trigger of the most recent batch and the date of the last background arrival
 * are the two facts that settle it, and each is shown only when it exists: a
 * client that reports no trigger says so rather than being guessed at.
 */
function DeliveryDiagnostic({
  status,
  t,
  now,
}: {
  status: HealthKitStatus;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Injectable reference instant, mirroring the pill's own prop. */
  now?: Date;
}) {
  const reference = now ?? new Date();
  const trigger = status.lastSyncTrigger ?? null;
  const triggerLabel = t(
    trigger
      ? TRIGGER_KEYS[trigger]
      : "settings.appleHealth.delivery.trigger.unknown",
  );
  const backgroundAt = status.lastBackgroundSyncAt;

  return (
    <div className="space-y-2" data-testid="apple-health-delivery">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("settings.appleHealth.delivery.title")}
      </h3>
      {status.lastSyncedAt ? (
        <dl className="space-y-1 text-sm">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("settings.appleHealth.delivery.lastTriggerLabel")}
            </dt>
            <dd data-testid="apple-health-last-trigger">{triggerLabel}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("settings.appleHealth.delivery.lastBackgroundLabel")}
            </dt>
            <dd data-testid="apple-health-last-background">
              {backgroundAt
                ? formatRelative(
                    Math.max(
                      0,
                      reference.getTime() - new Date(backgroundAt).getTime(),
                    ),
                    t,
                  )
                : t("settings.appleHealth.delivery.backgroundNever")}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("settings.appleHealth.delivery.noSyncYet")}
        </p>
      )}
    </div>
  );
}

/**
 * The second line of a type's row: when a live sync last carried the type,
 * under which trigger, and when one last brought a new value. The newest
 * sample's time on the right of the row says when the reading was TAKEN; this
 * says when the server RECEIVED it, which is what tells a type that only
 * arrives on "Sync all" from one the phone delivers by itself (#1173). Nothing
 * renders when the server sent no arrival facts (the workouts row, or a failed
 * ledger read), so absence is never painted as "not received".
 */
export function ArrivalDetail({
  entry,
  t,
  now,
}: {
  entry: HealthKitFreshnessEntry;
  t: (key: string, params?: Record<string, string | number>) => string;
  now?: Date;
}) {
  if (entry.lastReceivedAt === undefined) return null;
  if (entry.lastReceivedAt === null) {
    return (
      <span data-testid="apple-health-arrival" data-state="never">
        {t("settings.appleHealth.freshness.never")}
      </span>
    );
  }
  const reference = (now ?? new Date()).getTime();
  const relative = (iso: string) =>
    formatRelative(Math.max(0, reference - new Date(iso).getTime()), t);
  const trigger = entry.lastTrigger ?? null;
  const parts = [
    t("settings.appleHealth.freshness.lastReceived", {
      relative: relative(entry.lastReceivedAt),
    }),
    t(
      trigger
        ? TRIGGER_KEYS[trigger]
        : "settings.appleHealth.delivery.trigger.unknown",
    ),
  ];
  // Only worth a mention when the last arrival brought duplicates alone.
  if (entry.lastNewSampleAt && entry.lastNewSampleAt !== entry.lastReceivedAt) {
    parts.push(
      t("settings.appleHealth.freshness.lastNewValue", {
        relative: relative(entry.lastNewSampleAt),
      }),
    );
  }
  return (
    <span
      data-testid="apple-health-arrival"
      data-state="received"
      data-trigger={trigger ?? "unknown"}
    >
      {parts.join(" · ")}
    </span>
  );
}

/**
 * First-run backfill progress (#778). During the initial HealthKit backfill
 * the card said nothing about how much had arrived or how far back it
 * reached, so a working first run looked broken. This renders the figures
 * the server actually holds — accepted-row count and the oldest instant
 * reached — plus one honest state line derived from the age of the newest
 * batch. No ETA and no percentage: the remaining queue lives on the phone
 * and the server cannot see it.
 */
function SyncProgress({
  status,
  t,
  now,
}: {
  status: HealthKitStatus;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Injectable reference instant, mirroring the pill's own prop. */
  now?: Date;
}) {
  const formatters = useFormatters();
  const progress = status.syncProgress;
  // Nothing accepted and nothing synced: the delivery section's "no sync yet"
  // line already covers the blank state — a zero-row table would only repeat it.
  if (!progress || (progress.recordsAccepted <= 0 && !status.lastSyncedAt)) {
    return null;
  }
  const reference = now ?? new Date();
  const lastBatchAge = status.lastSyncedAt
    ? Math.max(0, reference.getTime() - new Date(status.lastSyncedAt).getTime())
    : null;
  const flowing =
    lastBatchAge !== null && lastBatchAge < PROGRESS_WAITING_AFTER_MS;

  return (
    <div className="space-y-2" data-testid="apple-health-progress">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("settings.appleHealth.progress.title")}
      </h3>
      <dl className="space-y-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-muted-foreground">
            {t("settings.appleHealth.progress.receivedLabel")}
          </dt>
          <dd data-testid="apple-health-progress-received">
            {formatters.integer(progress.recordsAccepted)}
          </dd>
        </div>
        {progress.oldestMeasuredAt ? (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">
              {t("settings.appleHealth.progress.oldestLabel")}
            </dt>
            <dd data-testid="apple-health-progress-oldest">
              {formatters.date(new Date(progress.oldestMeasuredAt))}
            </dd>
          </div>
        ) : null}
      </dl>
      {lastBatchAge !== null ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="apple-health-progress-state"
          data-state={flowing ? "flowing" : "waiting"}
        >
          {flowing
            ? t("settings.appleHealth.progress.flowing")
            : t("settings.appleHealth.progress.waiting")}
        </p>
      ) : null}
    </div>
  );
}

export function AppleHealthCard({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const {
    data: status,
    isLoading,
    isError,
  } = useQuery({
    queryKey: queryKeys.healthKitStatus(),
    queryFn: () => apiGet<HealthKitStatus>("/api/integrations/healthkit"),
    enabled,
    refetchOnWindowFocus: true,
  });

  const verdict = status?.syncHealth?.verdict;
  const pillState = pillStateForVerdict(verdict);
  // A failed status read is an error line, not a status state — the card says
  // nothing about the pipe it could not ask about.
  const showPill = !isLoading && !isError && !!status;

  return (
    <SettingsCard
      as="section"
      aria-labelledby="apple-health-card-title"
      data-testid="apple-health-card"
    >
      <SettingsCardHeader
        icon={HeartPulse}
        titleId="apple-health-card-title"
        title={t("settings.appleHealth.title")}
        description={t("settings.appleHealth.description")}
        status={
          showPill ? (
            <IntegrationStatusPill
              testId="apple-health-status"
              state={pillState}
              lastSyncAt={status?.lastSyncedAt ?? null}
            />
          ) : null
        }
      />

      <div className="space-y-4">
        {isError && (
          <IntegrationErrorMessage
            message={t("settings.appleHealth.status.unavailable")}
          />
        )}

        {verdict === "stale" && (
          <p className="text-warning text-sm" data-testid="apple-health-stale">
            {t("settings.appleHealth.staleNote")}
          </p>
        )}

        {showPill && <DeliveryDiagnostic status={status} t={t} />}

        {showPill && <SyncProgress status={status} t={t} />}

        <MetricFreshnessDisclosure
          entries={status?.metricFreshness}
          idPrefix="apple-health"
          title={t("settings.appleHealth.freshness.title")}
          detail={(entry) => <ArrivalDetail entry={entry} t={t} />}
        />

        <div className="space-y-2">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("settings.appleHealth.setupTitle")}
          </h3>
          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
            <li>{t("settings.appleHealth.permissionStep")}</li>
            <li>{t("settings.appleHealth.backgroundStep")}</li>
          </ol>
        </div>

        <div className="border-border bg-muted/30 flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs sm:max-w-xl">
            {t("settings.appleHealth.importNote")}
          </p>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="min-h-11 shrink-0 sm:min-h-9"
          >
            <Link
              href="/settings/export#settings-section-import-title"
              data-testid="apple-health-import-link"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              {t("settings.appleHealth.importAction")}
            </Link>
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}
