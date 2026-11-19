/**
 * POST /api/antigravity/test
 *
 * Connection test for the user's Antigravity profile. It starts the CLI on that
 * profile and opens a session. No prompt and no health data are sent. The
 * outcome is stored on the user record, so the status endpoint reports it.
 */
import { apiHandler, HttpError, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { Prisma } from "@/generated/prisma/client";
import { setAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";
import {
  antigravityProfileLocation,
  antigravityReasonOf,
  probeAntigravity,
  type AntigravityFailureReason,
  type AntigravityPromptCapabilities,
} from "@/lib/ai/antigravity-client";

export const dynamic = "force-dynamic";

export type AntigravityConnectionStatus =
  "disconnected" | "connected" | "auth_required" | "error";

type AntigravityTestReason =
  AntigravityFailureReason | "not_set_up" | "profile_missing";

export interface AntigravityTestResponse {
  status: AntigravityConnectionStatus;
  /** Why the test did not pass. Null when the profile is connected. */
  reason: AntigravityTestReason | null;
  capabilities: AntigravityPromptCapabilities | null;
}

async function probe(profileId: string): Promise<AntigravityTestResponse> {
  const profile = antigravityProfileLocation(profileId);
  if (!profile) {
    return { status: "error", reason: "profile_missing", capabilities: null };
  }
  try {
    const { capabilities } = await probeAntigravity(profile);
    return { status: "connected", reason: null, capabilities };
  } catch (error) {
    const reason = antigravityReasonOf(error);
    const status: AntigravityConnectionStatus =
      reason === "auth_required" ? "auth_required" : "error";
    return { status, reason, capabilities: null };
  }
}

export const POST = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  // Each test starts the CLI. The limit stops a loop of tests from tying up the server.
  const rl = await checkRateLimit(`antigravity-test:${caller.id}`, 10, 60_000);
  if (!rl.allowed) throw new HttpError(429, "Too many requests");

  const row = await prisma.user.findUnique({
    where: { id: caller.id },
    select: {
      antigravityProfileId: true,
      antigravityConnectionStatus: true,
    },
  });
  const profileId = row?.antigravityProfileId ?? null;
  const isConnected = row?.antigravityConnectionStatus === "connected";
  const rawStatus = row?.antigravityConnectionStatus;
  const fallbackStatus: AntigravityConnectionStatus =
    rawStatus === "auth_required" || rawStatus === "error"
      ? rawStatus
      : "disconnected";

  // Retained profiles from failed wipes/cleanups and disconnected/auth_required profiles
  // cannot reconnect via test without completing sign-in. Only actively connected profiles
  // can be re-probed. With no profile configured, always return disconnected.
  const result: AntigravityTestResponse =
    profileId && isConnected
      ? await probe(profileId)
      : {
          status: !profileId ? "disconnected" : fallbackStatus,
          reason: "not_set_up",
          capabilities: null,
        };

  await prisma.user.update({
    where: { id: caller.id },
    data: {
      antigravityConnectionStatus: result.status,
      antigravityConnectedAt: result.status === "connected" ? new Date() : null,
      antigravityCapabilitiesJson: result.capabilities
        ? { promptCapabilities: { ...result.capabilities } }
        : Prisma.DbNull,
    },
  });

  // Keep the in-process capabilities cache consistent so the vision resolver
  // sees the new state immediately, without waiting for the next DB read.
  // Mirrors how startCodexSignIn/forgetCodexSignIn keep Codex's slug live.
  const capJson = result.capabilities
    ? { promptCapabilities: result.capabilities }
    : null;
  setAntigravityCapabilities(caller.id, capJson);

  return apiSuccess(result);
});
