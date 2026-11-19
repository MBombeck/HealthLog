/**
 * POST /api/antigravity/install
 *
 * Downloads and installs or updates the Antigravity CLI binary on the
 * server. The binary is shared by every user, so only an administrator may
 * install or update it. Any other signed-in user gets 403.
 *
 * When called with `{ action: "update" }`, verifies that the binary is
 * currently installed and HealthLog-managed, checks that we are not
 * downgrading a newer binary, and atomically replaces it with the latest
 * official release after SHA-256 and version verification.
 *
 * When called with `{ force: true }`, authorized administrators can force
 * a reinstall/repair of a HealthLog-managed binary even if a healthy binary
 * is already detected.
 *
 * On fresh installation, discovers the latest official release from GitHub,
 * falling back to the build-pinned version (`AGY_PINNED_VERSION`) if discovery fails.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, isJsonContentType } from "@/lib/api-response";
import { envValue } from "@/lib/env";
import { normalizeAntigravityProfileRoot } from "@/lib/ai/antigravity-profile-cleanup";
import { parseJsonBody } from "@/lib/api/body";
import {
  compareSemver,
  getLatestAntigravityRelease,
  installAntigravityCli,
  isAntigravityBinaryManaged,
  resolveAntigravityBinary,
} from "@/lib/ai/antigravity-install";
import { probeCli } from "@/lib/ai/antigravity-probe";
import {
  type AntigravityInstallInput,
  antigravityInstallSchema,
} from "@/lib/validations/antigravity";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (req: Request) => {
  await requireAdmin();

  const binaryOverride = envValue("ANTIGRAVITY_BIN_PATH");
  if (binaryOverride) {
    return apiError(
      "Antigravity CLI is externally managed via ANTIGRAVITY_BIN_PATH and cannot be installed or modified by HealthLog",
      400,
    );
  }

  const rawProfileRoot = envValue("ANTIGRAVITY_PROFILE_ROOT");
  if (rawProfileRoot) {
    const normalizedRoot = normalizeAntigravityProfileRoot(rawProfileRoot);
    if (!normalizedRoot) {
      return apiError(
        "Configured ANTIGRAVITY_PROFILE_ROOT must be a valid absolute path",
        400,
      );
    }
  }

  const contentType = req.headers.get("content-type");
  if (req.body && !isJsonContentType(contentType)) {
    return apiError("Content-Type must be application/json", 415);
  }

  let body: AntigravityInstallInput = {};
  if (req.body) {
    const parsed = await parseJsonBody(req, antigravityInstallSchema, {
      maxBytes: 1024,
      action: "antigravity.install.invalid_shape",
    });
    if (!parsed.ok) return parsed.error;
    body = parsed.data;
  }

  const isUpdate = body.action === "update";

  if (isUpdate) {
    const existing = resolveAntigravityBinary();
    if (!existing) {
      return apiError("Antigravity CLI is not installed", 400);
    }

    if (!isAntigravityBinaryManaged()) {
      return apiError(
        "Antigravity CLI is externally managed and cannot be updated",
        400,
      );
    }

    const cli = await probeCli(existing);
    if (!cli.installed || !cli.version) {
      return apiError("Cannot determine current Antigravity CLI version", 400);
    }

    let latestRelease;
    try {
      latestRelease = await getLatestAntigravityRelease({ forceFresh: true });
    } catch {
      return apiError(
        "Failed to discover latest Antigravity CLI release from GitHub",
        502,
      );
    }

    const comparison = compareSemver(cli.version, latestRelease.version);
    if (comparison === 0) {
      return apiError("Antigravity CLI is already up to date", 400);
    }
    if (comparison > 0) {
      return apiError(
        "Cannot downgrade Antigravity CLI from a newer version",
        400,
      );
    }

    try {
      const result = await installAntigravityCli({
        force: true,
        release: latestRelease,
      });
      return apiSuccess(result);
    } catch {
      return apiError("Failed to update Antigravity CLI", 500);
    }
  }

  const isForced = body.force === true;
  const existing = resolveAntigravityBinary();
  if (existing) {
    const isManaged = isAntigravityBinaryManaged();
    const cli = await probeCli(existing);

    if (cli.installed && !isForced) {
      return apiSuccess({
        alreadyInstalled: true,
        binaryPath: existing,
        ...(cli.version ? { version: cli.version } : {}),
      });
    }

    if (!isManaged) {
      return apiError(
        "Antigravity CLI is externally managed and cannot be repaired",
        400,
      );
    }

    let release;
    try {
      release = await getLatestAntigravityRelease();
    } catch {
      return apiError(
        "Failed to discover latest Antigravity CLI release from GitHub",
        502,
      );
    }

    if (cli.version && compareSemver(cli.version, release.version) > 0) {
      return apiError(
        "Cannot downgrade Antigravity CLI from a newer version",
        400,
      );
    }

    try {
      const result = await installAntigravityCli({ force: true, release });
      return apiSuccess(result);
    } catch {
      return apiError("Failed to install Antigravity CLI", 500);
    }
  }

  let release;
  try {
    release = await getLatestAntigravityRelease();
  } catch {
    // Fall back to pinned version if discovery fails
  }

  try {
    const result = await installAntigravityCli({ force: isForced, release });
    return apiSuccess(result);
  } catch {
    return apiError("Failed to install Antigravity CLI", 500);
  }
});
