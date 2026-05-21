import { apiHandler } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { offlineGeoReady } from "@/lib/geo";
import packageJson from "../../../../package.json";

// v1.4.27 R5 — `offlineGeoEnabled` reads from the same source the geo
// resolver uses for the runtime fallback gate, so the public state and
// the runtime behaviour cannot disagree. The check hits the filesystem
// (`existsSync` on the `.empty` marker + the City MMDB) which forces
// the route to be dynamic — the previous `force-static` setting would
// have frozen the answer at build time.
export const dynamic = "force-dynamic";

/**
 * GET /api/version
 *
 * Public endpoint exposing the running build's version. Used by the
 * Settings → About surface, the footer of every page, the
 * "Check for updates" button (which compares against the GHCR API),
 * and the admin status-summary row that surfaces the offline-geo
 * availability state.
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
 *
 * `offlineGeoEnabled` is `true` when the GeoLite2-City MMDB is present
 * at the configured `GEOLITE2_DIR` and no `.empty` marker is set.
 * When `false` the runtime falls back to the online `ipwho.is`
 * provider and the resolver emits a one-shot admin notification on
 * first use.
 */
export const GET = apiHandler(async () => {
  // v1.4.43 B11 — prefer the build-arg-injected env var so the runtime
  // version cannot drift from the CI release tag. The Dockerfile takes
  // `NEXT_PUBLIC_APP_VERSION` as a build arg from the docker-publish
  // workflow (`build-args: NEXT_PUBLIC_APP_VERSION=${{ github.ref_name
  // }}`); when present it wins over the package.json fallback so a
  // BuildKit-layer cache hit on `pnpm build` can never re-ship the
  // prior release's version string. Local `pnpm dev` (env unset) falls
  // through to package.json as before.
  const version = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || packageJson.version;
  const buildSha = process.env.NEXT_PUBLIC_APP_BUILD_SHA?.trim() || null;
  const builtAt = process.env.NEXT_PUBLIC_APP_BUILT_AT?.trim() || null;
  const offlineGeoEnabled = offlineGeoReady();

  return apiSuccess({
    version,
    buildSha,
    builtAt,
    license: "AGPL-3.0",
    repository: "https://github.com/MBombeck/HealthLog",
    changelog: "https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md",
    docs: "https://docs.healthlog.dev",
    offlineGeoEnabled,
  });
});
