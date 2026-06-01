import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";
import packageJson from "../../../../../package.json";

export const dynamic = "force-dynamic";

/**
 * GET /api/version/check-updates
 *
 * Server-side proxy for the GitHub Releases API. Required because the
 * production CSP only whitelists `'self'` + Withings for `connect-src`
 * — fetching `https://api.github.com/...` directly from the browser is
 * silently blocked, which is why the v1.4.2 "Check for updates" button
 * appeared to do nothing. Proxying through `/api` keeps the CSP locked
 * down while the server (no CSP attached) fetches GitHub on the user's
 * behalf.
 *
 * Compares the running app version (from `package.json`) against the
 * latest GitHub release tag and returns one of three states:
 *   - `up_to_date` — running version >= latest release
 *   - `newer_available` — running version < latest release; payload
 *     includes the tag name and HTML URL so the UI can deep-link
 *   - `unknown` — couldn't reach GitHub (network issue, rate-limit,
 *     repo missing the release manifest); UI surfaces a non-blocking
 *     warning so the user can retry
 *
 * Responses are not cached at the route level. The browser bears the
 * load with React Query's `staleTime`, so a single user spamming
 * "Check now" still hits the GH API at most every 30 seconds.
 */

const RELEASES_URL =
  "https://api.github.com/repos/MBombeck/HealthLog/releases/latest";

interface GithubReleaseShape {
  tag_name?: string;
  html_url?: string;
  name?: string;
  published_at?: string;
}

function stripV(s: string): string {
  return s.replace(/^v/i, "").trim();
}

function compareSemver(a: string, b: string): number {
  const partsA = stripV(a)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10));
  const partsB = stripV(b)
    .split(/[.-]/)
    .map((n) => Number.parseInt(n, 10));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const ai = partsA[i] ?? 0;
    const bi = partsB[i] ?? 0;
    if (Number.isNaN(ai) || Number.isNaN(bi)) {
      // Pre-release suffixes — fall back to lexical ordering of the
      // stripped strings so `1.4.3-rc.1` sorts before `1.4.3`.
      const sA = stripV(a);
      const sB = stripV(b);
      return sA < sB ? -1 : sA > sB ? 1 : 0;
    }
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

export const GET = apiHandler(async () => {
  // Auth-gated: there's no reason an anonymous client should poll the
  // GH API through us. Cookie OR bearer token both satisfy this.
  await requireAuth();
  annotate({ action: { name: "version.check_updates" } });

  const current = packageJson.version;

  let release: GithubReleaseShape | null = null;
  const callStart = Date.now();
  try {
    const res = await safeFetch(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
      // GitHub anon rate limit is 60/hr per IP — tight but not zero.
      // We don't pass a token because the repo is public and the route
      // is auth-gated against our users.
      cache: "no-store",
    });
    getEvent()?.addExternalCall({
      service: "github_releases_api",
      method: "GET",
      duration_ms: Date.now() - callStart,
      status: res.status,
    });
    if (!res.ok) {
      annotate({
        meta: {
          status: res.status,
          outcome: "github_unreachable",
        },
      });
      return apiSuccess({
        status: "unknown" as const,
        current,
        reason: `github_status_${res.status}`,
      });
    }
    release = (await res.json()) as GithubReleaseShape;
  } catch (error) {
    getEvent()?.addExternalCall({
      service: "github_releases_api",
      method: "GET",
      duration_ms: Date.now() - callStart,
      error: error instanceof Error ? error.message : "unknown",
    });
    // Network glitch, DNS hiccup, GH outage. Don't fail the request —
    // tell the UI it's unknown so it can retry without showing a red
    // banner the user can't act on.
    annotate({
      meta: {
        outcome: "fetch_threw",
        message: error instanceof Error ? error.message : "unknown",
      },
    });
    return apiSuccess({
      status: "unknown" as const,
      current,
      reason: "network_error",
    });
  }

  const latestTag = release?.tag_name?.trim();
  if (!latestTag) {
    return apiError("GitHub release manifest missing tag_name", 502);
  }

  const cmp = compareSemver(current, latestTag);
  if (cmp >= 0) {
    return apiSuccess({
      status: "up_to_date" as const,
      current,
      latest_tag: latestTag,
      checked_at: new Date().toISOString(),
    });
  }

  return apiSuccess({
    status: "newer_available" as const,
    current,
    latest_tag: latestTag,
    html_url: release.html_url ?? null,
    published_at: release.published_at ?? null,
    checked_at: new Date().toISOString(),
  });
});
