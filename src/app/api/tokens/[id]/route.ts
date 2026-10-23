import { prisma } from "@/lib/db";
import { apiHandler, requireAuth, requireCookieAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { parseJsonBody } from "@/lib/api/body";
import { checkRateLimit } from "@/lib/rate-limit";
import { updateMeasurementTokenSchema } from "@/lib/validations/tokens";
import { setMeasurementTokenMirror } from "@/lib/measurements/token-mirror";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Revoke an API token.
 *
 * Still gated on the instance-wide API switch, where the sibling LIST is not.
 * The reasoning for the split lives in `../route.ts`: the list answers which
 * credentials exist on the caller's own account and is never the unsafe half,
 * while this one mutates the token surface the operator has switched off.
 */
export const DELETE = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();
    annotate({ action: { name: "tokens.revoke" } });

    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403);
    }

    const { id } = await params;
    const token = await prisma.apiToken.findUnique({ where: { id } });

    if (!token || token.userId !== user.id) {
      return apiError("Token not found", 404);
    }

    await prisma.apiToken.update({
      where: { id },
      data: { revoked: true },
    });

    return apiSuccess({ revoked: true });
  },
);

/**
 * Change a measurement token's one setting: whether the HealthLog app writes
 * its readings into Apple Health (#1272).
 *
 * - Cookie only. A Bearer, the token's own included, cannot change what its
 *   readings are allowed to become; the person decides, from the browser
 *   they are sitting at.
 * - The caller's own tokens only: another account's answers 404.
 * - Measurement tokens only. A wildcard, an MCP or any other narrow token has
 *   no such setting and is refused with 422 `tokens.mirror.not_measurement_token`.
 * - A revoked token is accepted: its readings stay in the record.
 *
 * Not gated on the instance-wide API switch: no credential is created or
 * extended, and the readings already in the record are what it governs.
 */
export const PATCH = apiHandler(
  async (request: Request, { params }: RouteParams) => {
    const { user } = await requireCookieAuth();
    annotate({ action: { name: "tokens.measurements.mirror.update" } });

    const rl = await checkRateLimit(
      `tokens:mirror:${user.id}`,
      MIRROR_RATE_LIMIT_MAX,
      MIRROR_RATE_LIMIT_WINDOW_MS,
    );
    if (!rl.allowed) {
      return apiError("Too many changes, try again later", 429);
    }

    const parsed = await parseJsonBody(request, updateMeasurementTokenSchema, {
      maxBytes: 4 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const { id } = await params;
    const outcome = await setMeasurementTokenMirror({
      userId: user.id,
      tokenId: id,
      mirrorToAppleHealth: parsed.data.mirrorToAppleHealth,
      ipAddress: getClientIp(request),
    });
    if (outcome.kind === "not_found") {
      return apiError("Token not found", 404);
    }
    if (outcome.kind === "not_measurement_token") {
      return apiError("Only a measurement token has this setting", 422, {
        errorCode: "tokens.mirror.not_measurement_token",
      });
    }
    return apiSuccess({ id, mirrorToAppleHealth: outcome.mirrorToAppleHealth });
  },
);

/** Changes per account per window: a settings switch, not an API. */
const MIRROR_RATE_LIMIT_MAX = 30;
const MIRROR_RATE_LIMIT_WINDOW_MS = 60 * 1000;
