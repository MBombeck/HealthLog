/**
 * The paired device behind a `health-connect:write` request.
 *
 * Both routes declare the scope, and `requireAuth` admits a cookie session
 * and a wildcard token beside it. Neither is a paired phone, and the routes
 * are the phone's: a request on any other credential is refused, and the
 * device is found from the token it was paired with, never from a header.
 */
import { apiError } from "@/lib/api-response";
import { requireAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { HEALTH_CONNECT_WRITE_SCOPE } from "./scopes";
import { HC_DEVICE_PLATFORM } from "./pairing";

export type PairedDeviceAuth =
  | {
      ok: true;
      user: { id: string; timezone: string };
      tokenId: string;
      tokenExpiresAt: Date | null;
      deviceId: string;
    }
  | { ok: false; response: Response };

export async function requirePairedDevice(): Promise<PairedDeviceAuth> {
  // Metered by the routes' own buckets, as the measurement batch is.
  const auth = await requireAuth(HEALTH_CONNECT_WRITE_SCOPE, {
    writeBucket: "own",
  });
  if (
    auth.authMethod !== "bearer" ||
    auth.bearerScope !== HEALTH_CONNECT_WRITE_SCOPE
  ) {
    return {
      ok: false,
      response: apiError(
        "This route takes the token of a paired Android device",
        403,
        { errorCode: "health-connect.device_token_required" },
      ),
    };
  }
  // On the Bearer path the token's id rides `session.id`.
  const tokenId = auth.session.id;
  const device = await prisma.device.findUnique({
    where: { apiTokenId: tokenId },
    select: {
      id: true,
      userId: true,
      platform: true,
      apiToken: { select: { expiresAt: true } },
    },
  });
  if (
    !device ||
    device.userId !== auth.user.id ||
    device.platform !== HC_DEVICE_PLATFORM
  ) {
    // The device went (deleted in Settings) while the token row stayed: the
    // phone reconnects, as for a revoked token.
    return {
      ok: false,
      response: apiError("This device is no longer paired", 401, {
        errorCode: "health-connect.device_unpaired",
      }),
    };
  }
  return {
    ok: true,
    user: { id: auth.user.id, timezone: auth.user.timezone },
    tokenId,
    tokenExpiresAt: device.apiToken?.expiresAt ?? null,
    deviceId: device.id,
  };
}
