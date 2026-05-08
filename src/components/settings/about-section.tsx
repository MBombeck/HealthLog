"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Info,
  Loader2,
  Package,
  RefreshCw,
  Scale,
  Sparkles,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

interface VersionPayload {
  version: string;
  buildSha: string | null;
  builtAt: string | null;
  license: string;
  repository: string;
  changelog: string;
  docs: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  name: string;
}

const RELEASES_API_URL =
  "https://api.github.com/repos/MBombeck/HealthLog/releases/latest";

/**
 * Compare a semantic version (e.g. "1.4.0") with a release tag (e.g.
 * "v1.4.0", "1.4.1"). Returns `true` when `tag` is strictly newer than
 * `current`. Falls back to lexical compare when the strings don't parse,
 * which is intentional — better to surface "newer available" on a parse miss
 * than silently swallow a release.
 */
function isNewer(current: string, tag: string): boolean {
  const stripV = (s: string) => s.replace(/^v/i, "").trim();
  const a = stripV(current)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10));
  const b = stripV(tag)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10));
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) {
      // Fall back to lexical compare for pre-release suffixes etc.
      return stripV(tag) > stripV(current);
    }
    if (bi > ai) return true;
    if (bi < ai) return false;
  }
  return false;
}

export function AboutSection() {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const { data: version, isLoading } = useQuery({
    queryKey: ["api", "version"],
    queryFn: async () => {
      const res = await fetch("/api/version");
      if (!res.ok) throw new Error("version-fetch-failed");
      const json = await res.json();
      return json.data as VersionPayload;
    },
    // The endpoint is `force-static` — version doesn't change at runtime.
    staleTime: Infinity,
  });

  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<
    | { kind: "up_to_date" }
    | { kind: "newer"; tag: string; url: string }
    | { kind: "error" }
    | null
  >(null);

  async function handleCheckForUpdates() {
    if (!version) return;
    setChecking(true);
    setUpdateResult(null);
    try {
      const res = await fetch(RELEASES_API_URL, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        setUpdateResult({ kind: "error" });
        return;
      }
      const release = (await res.json()) as GithubRelease;
      if (isNewer(version.version, release.tag_name)) {
        setUpdateResult({
          kind: "newer",
          tag: release.tag_name,
          url: release.html_url,
        });
      } else {
        setUpdateResult({ kind: "up_to_date" });
      }
    } catch {
      setUpdateResult({ kind: "error" });
    } finally {
      setChecking(false);
    }
  }

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

      <div className="bg-card border-border rounded-xl border p-6">
        <div className="mb-4 flex items-center gap-2">
          <Info className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">HealthLog</h2>
        </div>

        {isLoading || !version ? (
          <div className="flex items-center gap-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">
              {t("common.loading")}
            </span>
          </div>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-start gap-3">
              <Package className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">
                  {t("settings.about.version")}
                </dt>
                <dd className="font-mono text-sm font-medium">
                  v{version.version}
                </dd>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Scale className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">
                  {t("settings.about.license")}
                </dt>
                <dd>
                  <Badge variant="outline" className="text-xs">
                    {version.license}
                  </Badge>
                </dd>
              </div>
            </div>

            {version.buildSha && (
              <div className="flex items-start gap-3">
                <GitBranch className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <dt className="text-muted-foreground text-xs">
                    {t("settings.about.gitSha")}
                  </dt>
                  <dd className="font-mono text-sm">
                    {version.buildSha.slice(0, 7)}
                  </dd>
                </div>
              </div>
            )}

            {version.builtAt && (
              <div className="flex items-start gap-3">
                <Sparkles className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <dt className="text-muted-foreground text-xs">
                    {t("settings.about.builtAt", {
                      time: fmt.dateTime(version.builtAt),
                    })}
                  </dt>
                  <dd className="text-muted-foreground text-xs">
                    {fmt.date(version.builtAt)}
                  </dd>
                </div>
              </div>
            )}
          </dl>
        )}
      </div>

      {/* Links */}
      {version && (
        <div className="bg-card border-border rounded-xl border p-6">
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

      {/* Check for updates */}
      {version && (
        <div className="bg-card border-border rounded-xl border p-6">
          <Button
            type="button"
            variant="outline"
            onClick={handleCheckForUpdates}
            disabled={checking}
          >
            {checking ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {t("settings.about.checkUpdates")}
          </Button>

          {updateResult?.kind === "up_to_date" && (
            <p
              role="status"
              className="text-dracula-green mt-3 flex items-center gap-1.5 text-sm"
            >
              <CheckCircle2 className="h-4 w-4" />
              {t("settings.about.upToDate")}
            </p>
          )}

          {updateResult?.kind === "newer" && (
            <p role="status" className="mt-3 flex items-center gap-1.5 text-sm">
              <Sparkles className="text-dracula-purple h-4 w-4" />
              <a
                href={updateResult.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                {t("settings.about.newerAvailable", {
                  tag: updateResult.tag,
                })}
              </a>
            </p>
          )}

          {updateResult?.kind === "error" && (
            <p
              role="alert"
              className="text-destructive mt-3 flex items-center gap-1.5 text-sm"
            >
              <XCircle className="h-4 w-4" />
              {t("settings.testConnection.errors.connection_failed")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
