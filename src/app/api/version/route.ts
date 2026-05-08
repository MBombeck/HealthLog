import { apiHandler } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import packageJson from "../../../../package.json";

export const dynamic = "force-static";
export const revalidate = false;

/**
 * GET /api/version
 *
 * Public endpoint exposing the running build's version. Used by the
 * Settings → About surface, the footer of every page, and the
 * "Check for updates" button (which compares against the GHCR API).
 *
 * The build SHA and built-at timestamp come from environment variables
 * baked at image build time:
 *   - `NEXT_PUBLIC_APP_BUILD_SHA` — short Git SHA, set by the
 *     `docker-publish` workflow.
 *   - `NEXT_PUBLIC_APP_BUILT_AT` — ISO-8601 build timestamp, same
 *     workflow.
 *
 * For local `pnpm dev` neither is set; the route returns `null` and
 * the UI falls back to "development" wording.
 */
export const GET = apiHandler(async () => {
  const version = packageJson.version;
  const buildSha = process.env.NEXT_PUBLIC_APP_BUILD_SHA?.trim() || null;
  const builtAt = process.env.NEXT_PUBLIC_APP_BUILT_AT?.trim() || null;

  return apiSuccess({
    version,
    buildSha,
    builtAt,
    license: "AGPL-3.0",
    repository: "https://github.com/MBombeck/HealthLog",
    changelog: "https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
    docs: "https://docs.healthlog.dev",
  });
});
