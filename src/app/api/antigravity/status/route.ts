/**
 * GET /api/antigravity/status
 *
 * Returns the Antigravity CLI status for the authenticated user:
 * - CLI installation and version
 * - Saved configuration (profile ID, connection status, last test result)
 * - Whether this user may install or update the CLI (administrators only)
 *
 * The connection status changes through authentication, test, and disconnect
 * endpoints. This endpoint is read-only and never modifies the connection state.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  compareSemver,
  getLatestAntigravityRelease,
  isAntigravityBinaryManaged,
  resolveAntigravityBinary,
} from "@/lib/ai/antigravity-install";
import { probeCli } from "@/lib/ai/antigravity-probe";
import type { AntigravityConnectionStatus } from "../test/route";

export const dynamic = "force-dynamic";

export interface AntigravityStatusResponse {
  /** Whether the CLI binary was found */
  cliInstalled: boolean;
  /** CLI version string, if available */
  cliVersion: string | null;
  /** Whether this user may install the CLI. Only administrators may. */
  canInstallCli: boolean;
  /** Whether this user may update the CLI. Only administrators may, for managed binaries with updates available. */
  canUpdateCli: boolean;
  /** Whether the active CLI binary is managed by HealthLog in profile root */
  cliManaged: boolean;
  /** Whether an update to the latest available release is available */
  updateAvailable: boolean;
  /** Latest available Antigravity CLI version from GitHub releases, or null if discovery failed */
  latestVersion: string | null;
  /** Saved profile ID (not the path, just an opaque identifier) */
  profileId: string | null;
  /** Connection status from the last connection test */
  connectionStatus: AntigravityConnectionStatus;
  /** When the last successful connection test ran */
  connectedAt: string | null;
  /** Prompt input the CLI accepted in its last successful test */
  capabilities: {
    image: boolean;
    embeddedContext: boolean;
  } | null;
}

const CONNECTION_STATUSES: readonly AntigravityConnectionStatus[] = [
  "disconnected",
  "connected",
  "auth_required",
  "error",
];

function parseStatus(value: string): AntigravityConnectionStatus {
  return (CONNECTION_STATUSES as readonly string[]).includes(value)
    ? (value as AntigravityConnectionStatus)
    : "error";
}

export const GET = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  const binary = resolveAntigravityBinary();
  const cli = binary
    ? await probeCli(binary)
    : { installed: false, version: null };

  const row = await prisma.user.findUnique({
    where: { id: caller.id },
    select: {
      antigravityProfileId: true,
      antigravityConnectionStatus: true,
      antigravityConnectedAt: true,
      antigravityCapabilitiesJson: true,
    },
  });

  if (!row) {
    return apiError("User not found", 404);
  }

  let capabilities: AntigravityStatusResponse["capabilities"] = null;
  const stored = row.antigravityCapabilitiesJson as {
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
  } | null;
  if (stored?.promptCapabilities) {
    capabilities = {
      image: stored.promptCapabilities.image === true,
      embeddedContext: stored.promptCapabilities.embeddedContext === true,
    };
  }

  const isManaged = isAntigravityBinaryManaged();
  let updateAvailable = false;
  let latestVersion: string | null = null;
  try {
    const release = await getLatestAntigravityRelease();
    if (release) {
      latestVersion = release.version;
      if (cli.installed && isManaged && cli.version !== null) {
        updateAvailable = compareSemver(cli.version, release.version) < 0;
      }
    }
  } catch {
    // Safe fallback on GitHub API error, rate limit, or offline network.
    // The status endpoint continues to function without throwing.
    updateAvailable = false;
    latestVersion = null;
  }

  const canUpdateCli = caller.role === "ADMIN" && updateAvailable;

  const response: AntigravityStatusResponse = {
    cliInstalled: cli.installed,
    cliVersion: cli.version,
    canInstallCli: caller.role === "ADMIN",
    canUpdateCli,
    cliManaged: isManaged,
    updateAvailable,
    latestVersion,
    profileId: row.antigravityProfileId,
    connectionStatus: parseStatus(row.antigravityConnectionStatus),
    connectedAt: row.antigravityConnectedAt?.toISOString() ?? null,
    capabilities,
  };

  return apiSuccess(response);
});
