"use client";

/**
 * Apple Health: the one integration with no ledger row and no cron.
 *
 * The iOS app pushes; nothing here polls. The card renders the shared
 * integration card from the server's `health`, so the flagship integration
 * speaks the same status language as its siblings. What only Apple Health
 * knows (how the last batch arrived, how far the first backfill reached, when
 * each data type last came in) lives in the card's details.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { HeartPulse, Upload } from "lucide-react";

import { formatRelative } from "./format-relative";
import { formatHealthInstant } from "./integration-health-copy";
import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { ConnectionHealth } from "@/lib/integrations/connection-health";
import type { HealthKitFreshnessEntry } from "@/lib/integrations/healthkit-type-sync";
import { queryKeys } from "@/lib/query-keys";

import { IntegrationCard } from "./integration-card";
import { MetricFreshnessList } from "./metric-freshness-list";

type SyncTrigger = "foreground" | "background" | "push" | "manual";

interface HealthKitStatus {
  lastSyncedAt: string | null;
  /** What the client said woke it for the most recent accepted batch. */
  lastSyncTrigger?: SyncTrigger | null;
  /** When data last arrived without the app being opened. */
  lastBackgroundSyncAt?: string | null;
  /** The unified connection state; null until the phone has delivered. */
  health?: ConnectionHealth | null;
  /** Per type: newest sample, plus when it last arrived and how (#1173). */
  metricFreshness?: HealthKitFreshnessEntry[];
  /**
   * The iPhones whose upload has gone quiet against their own rhythm, the
   * rule behind the stall notification.
   */
  quietDevices?: Array<{ model: string | null; quietSince: string }>;
  /** Server-side backfill progress (#778); null when the read failed. */
  syncProgress?: {
    recordsAccepted: number;
    oldestMeasuredAt: string | null;
  } | null;
}

/**
 * One line per iPhone whose Apple Health upload stalled: since when, and the
 * one thing that resumes it. The same rule the stall notification tells.
 */
function QuietDevices({ status }: { status: HealthKitStatus }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const devices = status.quietDevices ?? [];
  if (devices.length === 0) return null;
  return (
    <ul className="space-y-1" data-slot="apple-health-quiet-devices">
      {devices.map((device) => (
        <li
          key={`${device.model ?? ""}:${device.quietSince}`}
          className="text-sm"
          data-testid="apple-health-quiet-device"
        >
          {t("settings.appleHealth.quietSince", {
            device:
              device.model ?? t("settings.appleHealth.quietDeviceUnnamed"),
            since: formatHealthInstant(device.quietSince, t, fmt),
          })}
        </li>
      ))}
    </ul>
  );
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
      <h3 className="text-muted-foreground text-xs font-medium">
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
 * arrives on "Sync all" from one the phone delivers by itself (#1173), plus
 * the last background arrival when a later one came another way. Nothing
 * renders when the server sent no arrival facts (the workouts row, or a failed
 * ledger read), so absence is never painted as "not received". A type the app
 * writes back to the phone also names when a reading was last entered here
 * (#1247), since those never arrive back.
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
  const reference = (now ?? new Date()).getTime();
  const relative = (iso: string) =>
    formatRelative(Math.max(0, reference - new Date(iso).getTime()), t);
  const enteredHere = entry.lastEnteredHereAt
    ? t("settings.appleHealth.freshness.lastEnteredHere", {
        relative: relative(entry.lastEnteredHereAt),
      })
    : null;
  if (entry.lastReceivedAt === undefined) {
    return enteredHere ? (
      <span data-testid="apple-health-arrival" data-state="entered-here">
        {enteredHere}
      </span>
    ) : null;
  }
  // v1.43 (ios #77) — a history catch-up is named apart from the live
  // arrivals, and never counts as one.
  const backfill = entry.lastBackfillAt
    ? t("settings.appleHealth.freshness.lastBackfill", {
        relative: relative(entry.lastBackfillAt),
      })
    : null;
  if (entry.lastReceivedAt === null) {
    return (
      <span data-testid="apple-health-arrival" data-state="never">
        {[t("settings.appleHealth.freshness.never"), backfill, enteredHere]
          .filter((part): part is string => part !== null)
          .join(", ")}
      </span>
    );
  }
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
  // Only worth a mention on a row last written before duplicates stopped
  // counting as an arrival (#1259); since then the two move together.
  if (entry.lastNewSampleAt && entry.lastNewSampleAt !== entry.lastReceivedAt) {
    parts.push(
      t("settings.appleHealth.freshness.lastNewValue", {
        relative: relative(entry.lastNewSampleAt),
      }),
    );
  }
  // The phone kept re-sending the type after its last new value: the
  // arrival above stays put, and this says the type is still being sent.
  if (
    entry.lastSeenDuplicateAt &&
    Date.parse(entry.lastSeenDuplicateAt) > Date.parse(entry.lastReceivedAt)
  ) {
    parts.push(
      t("settings.appleHealth.freshness.lastDuplicate", {
        relative: relative(entry.lastSeenDuplicateAt),
      }),
    );
  }
  // The last background arrival, when a later one came another way: opening
  // the app to look would otherwise hide that the phone delivers by itself.
  if (
    entry.lastBackgroundAt &&
    entry.lastBackgroundAt !== entry.lastReceivedAt
  ) {
    parts.push(
      t("settings.appleHealth.freshness.lastBackground", {
        relative: relative(entry.lastBackgroundAt),
      }),
    );
  }
  if (backfill) parts.push(backfill);
  if (enteredHere) parts.push(enteredHere);
  return (
    <span
      data-testid="apple-health-arrival"
      data-state="received"
      data-trigger={trigger ?? "unknown"}
    >
      {parts.join(", ")}
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
      <h3 className="text-muted-foreground text-xs font-medium">
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
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.healthKitStatus(),
    queryFn: () => apiGet<HealthKitStatus>("/api/integrations/healthkit"),
    enabled,
    refetchOnWindowFocus: true,
  });

  const health = status?.health ?? null;
  // Apple Health has nothing to connect: it counts as connected once the
  // phone has delivered anything, which is exactly when the server resolves a
  // health for it. A failed read is neither, so the card says it could not
  // ask instead of claiming "not connected".
  const connected = isError || health !== null;

  const importLink = (
    <Button
      asChild
      variant="outline"
      size="sm"
      className="min-h-11 w-full sm:min-h-9 sm:w-auto"
    >
      <Link
        href="/settings/export#settings-section-import-title"
        data-testid="apple-health-import-link"
      >
        <Upload className="size-3.5" aria-hidden="true" />
        {t("settings.appleHealth.importAction")}
      </Link>
    </Button>
  );

  return (
    <IntegrationCard
      provider="apple-health"
      providerName={t("settings.appleHealth.title")}
      icon={HeartPulse}
      description={t("settings.appleHealth.description")}
      loading={enabled && isLoading}
      connected={connected}
      health={health}
      appleHealth
      setup={
        <div className="space-y-3">
          <div className="space-y-2">
            <h3 className="text-muted-foreground text-xs font-medium">
              {t("settings.appleHealth.setupTitle")}
            </h3>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>{t("settings.appleHealth.permissionStep")}</li>
              <li>{t("settings.appleHealth.backgroundStep")}</li>
            </ol>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("settings.appleHealth.importNote")}
          </p>
        </div>
      }
      connectAction={importLink}
      menu={[
        {
          id: "import",
          label: t("settings.appleHealth.importAction"),
          icon: Upload,
          href: "/settings/export#settings-section-import-title",
        },
      ]}
      details={
        status && !isError ? (
          <>
            <DeliveryDiagnostic status={status} t={t} />
            <SyncProgress status={status} t={t} />
            <MetricFreshnessList
              entries={status.metricFreshness}
              title={t("settings.appleHealth.freshness.title")}
              detail={(entry) => <ArrivalDetail entry={entry} t={t} />}
            />
          </>
        ) : undefined
      }
    >
      {status && !isError ? <QuietDevices status={status} /> : null}
      {isError ? (
        <QueryErrorRow
          error={error}
          slot="apple-health-status-error"
          message={t("settings.appleHealth.status.unavailable")}
          onRetry={() => void refetch()}
        />
      ) : null}
    </IntegrationCard>
  );
}
