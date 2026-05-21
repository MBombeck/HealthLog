"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpCircle,
  BookOpen,
  ExternalLink,
  GitBranch,
  Info,
  Loader2,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface VersionPayload {
  version: string;
  buildSha: string | null;
  builtAt: string | null;
  license: string;
  repository: string;
  changelog: string;
  docs: string;
}

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

const LAST_CHECKED_KEY = "healthlog-about-last-checked-iso";
// One day between auto-checks. We don't want every page-mount to spend a
// GitHub-API rate-limit slot just to confirm the version is unchanged
// 30 seconds after the previous one resolved. The user can always force
// a re-check via the button.
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readLastCheckedISO(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_CHECKED_KEY);
  } catch {
    return null;
  }
}

function writeLastCheckedISO(iso: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CHECKED_KEY, iso);
  } catch {
    /* storage may be full or disabled — silently skip */
  }
}

/**
 * v1.4.36 QA H7 — keyboard- and touch-accessible update badge.
 *
 * Renders as a 44 px-square hit target (anchor when a release URL is
 * known, span fallback otherwise) with a focus-visible ring, semantic
 * `text-primary` colour, and a real `aria-label` describing the
 * available version. Exported so the SSR test can pin the contract
 * without driving the parent's auto-check effect.
 */
export function UpdateBadge({
  latestTag,
  htmlUrl,
  ariaLabel,
}: {
  latestTag: string;
  htmlUrl: string | null;
  ariaLabel: string;
}) {
  if (htmlUrl) {
    return (
      <a
        href={htmlUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={ariaLabel}
        title={ariaLabel}
        className="text-primary focus-visible:ring-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <ArrowUpCircle className="h-4 w-4" />
        <span className="sr-only">{latestTag}</span>
      </a>
    );
  }
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      title={ariaLabel}
      className="text-primary inline-flex min-h-11 min-w-11 items-center justify-center"
    >
      <ArrowUpCircle className="h-4 w-4" />
    </span>
  );
}

export function AboutSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data: version, isLoading } = useQuery({
    queryKey: queryKeys.apiVersion(),
    queryFn: async () => {
      const res = await fetch("/api/version");
      if (!res.ok) throw new Error("version-fetch-failed");
      const json = await res.json();
      return json.data as VersionPayload;
    },
    // The endpoint is `force-static` — version doesn't change at runtime.
    staleTime: Infinity,
  });

  // v1.4.36 W4f — the explicit "Check for updates" button is gone;
  // only the 24 h auto-check stays. When the auto-check reports
  // `newer_available`, a subtle upward-arrow badge appears next to
  // the version line with the latest tag in its tooltip.
  const [updateResult, setUpdateResult] = useState<CheckUpdatesResult | null>(
    null,
  );

  async function runCheck(): Promise<void> {
    try {
      const res = await fetch("/api/version/check-updates");
      if (!res.ok) {
        setUpdateResult({
          status: "unknown",
          current: version?.version ?? "",
          reason: `http_${res.status}`,
        });
        return;
      }
      const json = await res.json();
      const result = json.data as CheckUpdatesResult;
      setUpdateResult(result);
      if (result.status !== "unknown") {
        writeLastCheckedISO(new Date().toISOString());
      }
    } catch {
      setUpdateResult({
        status: "unknown",
        current: version?.version ?? "",
        reason: "network_error",
      });
    }
  }

  // Auto-check on mount when the last successful check is older than the
  // refresh interval (or has never run). Keeps the badge fresh without a
  // click — but won't spam GitHub on every navigation.
  // The setState inside runCheck() is intentional: the check is the
  // whole point of the effect, and the staleness gate prevents a
  // cascading-render loop because the timestamp resets after the run.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!version) return;
    const last = readLastCheckedISO();
    const lastMs = last ? Date.parse(last) : NaN;
    const stale =
      Number.isNaN(lastMs) || Date.now() - lastMs > AUTO_CHECK_INTERVAL_MS;
    if (stale) {
      void runCheck();
    }
  }, [version?.version]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  return (
    <section
      aria-labelledby="settings-section-about-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1
          id="settings-section-about-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {t("settings.sections.about.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.about.description")}
        </p>
      </header>

      {/* Identity card — version + license inline. The v1.4.2 layout
          stacked the license under the version inside its own boxed Badge,
          which read as a separate field even though the two values belong
          on the same row. */}
      <div className="bg-card border-border rounded-xl border p-6">
        <div className="mb-4 flex items-center gap-2">
          <Info className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">HealthLog</h2>
        </div>

        {isLoading || !version ? (
          <div className="flex items-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin motion-reduce:animate-none" />
            <span className="text-muted-foreground text-sm">
              {t("common.loading")}
            </span>
          </div>
        ) : (
          <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-3 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("settings.about.version")}
              </dt>
              <dd className="font-mono font-medium">v{version.version}</dd>
              {/* v1.4.36 W4f — subtle upward-arrow badge that
                  appears only when the 24 h auto-check reports a
                  newer release. Hover/tap reveals the latest tag via
                  the title attribute (read by screen readers + as a
                  native tooltip on desktop, and announced inline as
                  the link copy on mobile). No bouncing, no badge
                  counter, no manual recheck button — the badge is
                  the entire surface. */}
              {updateResult?.status === "newer_available" && (
                <UpdateBadge
                  latestTag={updateResult.latest_tag}
                  htmlUrl={updateResult.html_url}
                  ariaLabel={t("settings.about.newerAvailable", {
                    tag: updateResult.latest_tag,
                  })}
                />
              )}
            </div>

            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("settings.about.license")}
              </dt>
              <dd className="font-mono">{version.license}</dd>
            </div>

            {version.buildSha && (
              <div className="flex items-baseline gap-2">
                <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                  {t("settings.about.gitSha")}
                </dt>
                <dd className="font-mono">{version.buildSha.slice(0, 7)}</dd>
              </div>
            )}

            {version.builtAt && (
              <div className="flex items-baseline gap-2">
                <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                  {t("settings.about.builtAtLabel")}
                </dt>
                <dd className="text-muted-foreground">
                  {fmt.date(version.builtAt)}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {/* Sources & docs — every link card was untitled in the v1.4.2
          About surface, so the buttons floated alone with no heading
          telling the user what the section was for. */}
      {version && (
        <div className="bg-card border-border rounded-xl border p-6">
          <div className="mb-4 flex items-center gap-2">
            <BookOpen className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">
              {t("settings.about.linksHeading")}
            </h2>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button asChild variant="outline" size="sm">
              <a
                href={version.repository}
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitBranch className="mr-2 h-4 w-4" />
                {t("settings.about.repository")}
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a
                href={version.changelog}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                {t("settings.about.changelog")}
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={version.docs} target="_blank" rel="noopener noreferrer">
                <BookOpen className="mr-2 h-4 w-4" />
                {t("settings.about.docs")}
                <ExternalLink className="ml-2 h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        </div>
      )}

      {/* v1.4.36 W4f — the dedicated "Updates" card with the
          manual "Check for updates" button is gone. The 24 h auto-
          check still runs on mount and writes its result into the
          local `updateResult` state; the consequence renders as the
          subtle upward-arrow badge next to the version line above
          rather than as a separate panel. The card-level last-check
          timestamp, success / failure states, and the explicit
          button were collectively never the point of the surface —
          the only signal users ever cared about was "is a newer
          release out?", and the badge answers that with no clicks. */}
    </section>
  );
}
