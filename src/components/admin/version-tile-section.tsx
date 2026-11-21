"use client";

/**
 * `<VersionTileSection>` — admin-overview version card.
 *
 * v1.15.12 — a dedicated tile that surfaces the running build's
 * version, short build SHA, and build timestamp, plus a best-effort
 * "update available" hint computed against the latest GitHub release
 * tag. The release comparison reuses the existing
 * `GET /api/version/check-updates` proxy (server-side `safeFetch` past
 * the CSP), so no new route or OpenAPI schema is introduced. The check
 * is day-stale (`staleTime`) and never blocks the render: on any
 * failure the tile simply omits the update hint.
 *
 * Cookie-admin only by construction — it lives under the admin layout
 * (`/admin`), which gates on `requireAdmin()`.
 */

import {
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  GitCommit,
  Tag,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ApiError, apiGet } from "@/lib/api/api-fetch";
import { StatusItem, usePublicVersion } from "./_shared";

type CheckUpdatesResult =
  | {
      status: "up_to_date";
      current: string;
      latest_tag: string;
      checked_at: string;
    }
  | {
      status: "newer_available";
      current: string;
      latest_tag: string;
      html_url: string | null;
      published_at: string | null;
      checked_at: string;
    }
  | { status: "unknown"; current: string; reason: string };

async function fetchUpdateCheck(): Promise<CheckUpdatesResult> {
  try {
    return await apiGet<CheckUpdatesResult>("/api/version/check-updates");
  } catch (err) {
    const reason =
      err instanceof ApiError ? `http_${err.status}` : "network_error";
    return { status: "unknown", current: "", reason };
  }
}

function shortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

export function VersionTileSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { data: version } = usePublicVersion();

  // Best-effort, day-stale, never throws into the render. The route is
  // auth-gated and proxies the GitHub Releases API through the server so
  // the production CSP doesn't block the call.
  const { data: update } = useQuery({
    queryKey: queryKeys.versionUpdateCheck(),
    queryFn: fetchUpdateCheck,
    staleTime: 24 * 60 * 60_000,
    retry: false,
  });

  const newer = update?.status === "newer_available";
  const upToDate = update?.status === "up_to_date";
  // The operator turned the GitHub request off (UPDATE_CHECK_DISABLED); say
  // so rather than leaving the slot empty like an unreachable feed.
  const checkOff = update?.status === "unknown" && update.reason === "disabled";
  const sha = shortSha(version?.buildSha ?? null);

  return (
    <SettingsCard as="section" aria-labelledby="admin-overview-version-heading">
      <SettingsCardHeader
        icon={Tag}
        titleId="admin-overview-version-heading"
        title={t("admin.overview.versionTileTitle")}
        status={
          newer ? (
            <a
              href={
                (update.status === "newer_available" && update.html_url) ||
                "https://github.com/MBombeck/HealthLog/releases/latest"
              }
              target="_blank"
              rel="noopener noreferrer"
              className="bg-warning/15 text-warning border-warning/30 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium underline-offset-2 hover:underline"
            >
              <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden="true" />
              {t("admin.overview.versionTileUpdateAvailable", {
                tag:
                  update.status === "newer_available" ? update.latest_tag : "",
              })}
            </a>
          ) : upToDate ? (
            <span className="text-success inline-flex items-center gap-1.5 text-xs font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {t("admin.overview.versionTileUpToDate")}
            </span>
          ) : checkOff ? (
            <span className="text-muted-foreground text-xs">
              {t("admin.overview.versionTileCheckOff")}
            </span>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatusItem
          icon={Tag}
          label={t("admin.overview.versionTileVersion")}
          value={version?.version ?? "—"}
        />
        <StatusItem
          icon={GitCommit}
          label={t("admin.overview.versionTileBuildSha")}
          value={sha ?? "—"}
        />
        <StatusItem
          icon={Clock}
          label={t("admin.overview.versionTileBuiltAt")}
          value={version?.builtAt ? fmt.dateTime(version.builtAt) : "—"}
        />
      </div>
    </SettingsCard>
  );
}
