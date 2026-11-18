"use client";

// Google Health (Fitbit + Pixel Watch + Fitbit Air), read through the
// Google Health API, the successor of the Fitbit Web API Google turned off on
// 30 October 2026.
//
// It renders the shared OAuth integration card. What it adds is its own sync
// choreography: a manual sync may outlive its request, so the card polls the
// authenticated status route until the run settles, shows the run's progress
// while it does, and lists the resources that did not complete in the details.
// Google's 7-day refresh expiry in "Testing" publishing mode is no longer a
// banner of its own: the server reports it as `action_required` /
// `reauth_required`, and the card's one primary button reconnects.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { Badge } from "@/components/ui/badge";
import { TagChip } from "@/components/ui/tag-chip";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

import {
  completedGoogleHealthResourceCount,
  failedGoogleHealthResources,
  googleHealthReasonCode,
  readGoogleHealthProgress,
  type GoogleHealthProgress,
} from "./google-health-progress-view";
import {
  OAUTH_INTEGRATIONS,
  OAuthIntegrationCardView,
} from "./oauth-integration-card";
import type { IntegrationStatusViewModel } from "./shared";
import {
  readSyncOutcome,
  useSyncOutcomeMessage,
  type SyncOutcomeResource,
  type SyncOutcomeState,
} from "./sync-outcome";

export function GoogleHealthCard({
  viewModel,
  callbackUrl,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
  /** Server-resolved OAuth callback URL; see `getIntegrationCallbackUrls`. */
  callbackUrl: IntegrationCallbackUrls["google-health"];
}) {
  const { t } = useTranslations();
  const describeSyncOutcome = useSyncOutcomeMessage();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncOutcomeState | null>(null);
  const [syncProgress, setSyncProgress] = useState<GoogleHealthProgress | null>(
    null,
  );
  const queryClient = useQueryClient();

  function invalidateCommittedWorkout(resources: SyncOutcomeResource[]) {
    const workoutCommitted = resources.some(
      (resource) =>
        resource.resource === "workout" &&
        typeof resource.written === "number" &&
        resource.written > 0,
    );
    if (!workoutCommitted) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.workouts() });
    // prettier-ignore
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSnapshot() });
    queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
  }

  async function pollSyncStatus(
    maxAttempts = 20,
  ): Promise<GoogleHealthProgress | null> {
    let latest: GoogleHealthProgress | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await apiFetchRaw("/api/google-health/sync/status");
        const progress = readGoogleHealthProgress(await response.json());
        if (response.ok && progress) {
          latest = progress;
          setSyncProgress(progress);
          if (progress.state !== "in_progress") return progress;
        }
      } catch {
        // The POST may have committed even when its response was lost. Keep
        // this bounded poll best-effort; the status CTA can retry it.
      }
      if (attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    return latest;
  }

  function showProgress(progress: GoogleHealthProgress): void {
    setSyncProgress(progress);
    invalidateCommittedWorkout(progress.resources);
    if (progress.state === "in_progress") {
      setSyncResult(null);
      return;
    }
    const failed =
      progress.state === "failed" || progress.state === "interrupted";
    const outcome =
      progress.state === "partial" || progress.state === "truncated"
        ? "partial"
        : failed
          ? "failed"
          : progress.imported > 0
            ? "success"
            : "empty";
    const resolved = {
      imported: progress.imported,
      failed: failed || outcome === "partial",
      outcome,
    } as const;
    setSyncResult({
      outcome: resolved.outcome,
      message: describeSyncOutcome(
        resolved,
        t("settings.googleHealthSyncResult", { count: progress.imported }),
      ),
    });
  }

  function progressFromOutcome(
    result: ReturnType<typeof readSyncOutcome>,
  ): GoogleHealthProgress | null {
    if (!result?.resources) return null;
    return {
      state:
        result.outcome === "failed"
          ? "failed"
          : result.outcome === "partial"
            ? "partial"
            : result.outcome === "empty"
              ? "zero"
              : "complete",
      imported: result.imported,
      resources: result.resources,
    };
  }

  async function refreshSyncStatus() {
    setSyncing(true);
    try {
      const progress = await pollSyncStatus(4);
      if (progress) showProgress(progress);
      else {
        setSyncResult({
          outcome: "failed",
          message: t("settings.googleHealthSyncFailed"),
        });
      }
    } finally {
      setSyncing(false);
    }
  }

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncResult(null);
    setSyncProgress(null);
    try {
      const res = await apiFetchRaw("/api/google-health/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      const result = res.ok ? readSyncOutcome(json) : null;
      if (result) {
        // The tone comes off what the run wrote, not off `res.ok`.
        setSyncResult({
          outcome: result.outcome,
          message: describeSyncOutcome(
            result,
            t("settings.googleHealthSyncResult", { count: result.imported }),
          ),
        });
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.googleHealth() });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
        const progress =
          readGoogleHealthProgress(json) ?? progressFromOutcome(result);
        if (progress) showProgress(progress);
      } else {
        const progress = await pollSyncStatus();
        if (progress) {
          showProgress(progress);
        } else {
          setSyncResult({
            outcome: "failed",
            message: json?.error || t("settings.googleHealthSyncFailed"),
          });
        }
      }
    } catch {
      const progress = await pollSyncStatus();
      if (progress) {
        showProgress(progress);
      } else {
        setSyncResult({
          outcome: "failed",
          message: t("settings.googleHealthSyncFailed"),
        });
      }
    } finally {
      setSyncing(false);
    }
  }

  function resourceLabel(resource: string): string {
    switch (resource) {
      case "workout":
        return t("settings.googleHealthResource.workout");
      case "sleep":
        return t("settings.googleHealthResource.sleep");
      case "bounded-metrics":
        return t("settings.googleHealthResource.boundedMetrics");
      case "activity":
        return t("settings.googleHealthResource.activity");
      case "dense-heart-rate":
        return t("settings.googleHealthResource.heartRate");
      default:
        return t("settings.googleHealthResource.other");
    }
  }

  function resourceFailureMessage(resource: SyncOutcomeResource): string {
    switch (googleHealthReasonCode(resource)) {
      case "collection_failed":
        return t("settings.googleHealthReason.collectionFailed");
      case "token_failed":
        return t("settings.googleHealthReason.tokenFailed");
      case "upsert_failed":
        return t("settings.googleHealthReason.upsertFailed");
      case "rollup_failed":
        return t("settings.googleHealthReason.rollupFailed");
      case "existing_page_limit":
        return t("settings.googleHealthReason.pageLimit");
      default:
        return t("settings.googleHealthReason.generic");
    }
  }

  const resourceFailures = failedGoogleHealthResources(syncProgress);
  const completedResources = completedGoogleHealthResourceCount(syncProgress);
  const inProgress = syncProgress?.state === "in_progress";

  return (
    <OAuthIntegrationCardView
      config={OAUTH_INTEGRATIONS["google-health"]}
      viewModel={viewModel}
      callbackUrl={callbackUrl}
      titleAccessory={
        <>
          <TagChip>{t("settings.googleHealthTag")}</TagChip>
          <Badge
            variant="outline"
            data-testid="google-health-beta-badge"
            className="border-warning/50 text-warning"
          >
            {t("settings.googleHealthBetaBadge")}
          </Badge>
        </>
      }
      sync={{
        syncing,
        result: syncResult,
        run: (fullSync) => {
          if (!fullSync && syncProgress?.state === "in_progress") {
            void refreshSyncStatus();
          } else {
            void handleSync(fullSync);
          }
        },
      }}
      syncLabel={
        inProgress
          ? t("settings.googleHealthSyncCheckStatus")
          : t("settings.googleHealthSync")
      }
      fullSyncDisabled={inProgress}
      syncResults={
        inProgress || syncResult ? (
          <div className="space-y-2">
            {inProgress ? (
              <p
                role="status"
                aria-live="polite"
                className="text-muted-foreground text-xs"
                data-testid="google-health-sync-progress"
              >
                {t("settings.googleHealthSyncInProgress", {
                  count: syncProgress.imported,
                  completed: completedResources,
                  total: syncProgress.resources.length,
                })}
              </p>
            ) : null}
            {syncResult ? (
              <WrittenOutcomeLine
                outcome={syncResult.outcome}
                message={syncResult.message}
                testId="google-health-sync-result"
              />
            ) : null}
          </div>
        ) : null
      }
      details={
        resourceFailures.length > 0 ? (
          <div
            data-testid="google-health-resource-failures"
            className="space-y-1"
          >
            <p className="text-sm font-medium">
              {t("settings.googleHealthResourceFailuresTitle")}
            </p>
            <ul className="space-y-1 text-sm">
              {resourceFailures.map((resource) => (
                <li key={resource.resource}>
                  <span className="font-medium">
                    {resourceLabel(resource.resource)}
                  </span>
                  {": "}
                  {resourceFailureMessage(resource)}
                </li>
              ))}
            </ul>
          </div>
        ) : undefined
      }
    />
  );
}
