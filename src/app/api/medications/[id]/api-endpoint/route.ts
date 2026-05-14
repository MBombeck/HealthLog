import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

function medicationScope(medicationId: string): string {
  return `medication:${medicationId}:ingest`;
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403);
    }

    const { id } = await params;
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const scope = medicationScope(id);
    const now = new Date();

    const activeTokenCount = await prisma.apiToken.count({
      where: {
        userId: user.id,
        revoked: false,
        permissions: { has: scope },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });

    annotate({
      action: {
        name: "medication.api_endpoint.get",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { active_token_count: activeTokenCount },
    });

    return apiSuccess({
      enabled: activeTokenCount > 0,
      activeTokenCount,
    });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403);
    }

    const { id } = await params;
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const medication = await prisma.medication.findUnique({ where: { id } });
    if (!medication) {
      return apiError("Medication not found", 404);
    }

    let enabled = false;
    try {
      const body = await request.json();
      enabled = body?.enabled === true;
    } catch {
      return apiError("Invalid request", 422);
    }

    const scope = medicationScope(id);

    if (enabled) {
      const existing = await prisma.apiToken.count({
        where: {
          userId: user.id,
          revoked: false,
          permissions: { has: scope },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });

      if (existing > 0) {
        annotate({
          action: {
            name: "medication.api_endpoint.enable",
            entity_type: "medication",
            entity_id: id,
          },
          meta: { already_enabled: true, active_token_count: existing },
        });

        return apiSuccess({
          enabled: true,
          activeTokenCount: existing,
          token: null,
          created: false,
        });
      }

      const rawToken = `hlk_${randomBytes(32).toString("hex")}`;
      const tokenHashValue = hashToken(rawToken);

      await prisma.apiToken.create({
        data: {
          userId: user.id,
          name: `API Endpoint: ${medication.name}`,
          tokenHash: tokenHashValue,
          permissions: ["medication:ingest", scope],
          expiresAt: null,
        },
      });

      await auditLog("medication.api_endpoint.enable", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: { medicationId: id, medicationName: medication.name },
      });

      annotate({
        action: {
          name: "medication.api_endpoint.enable",
          entity_type: "medication",
          entity_id: id,
        },
        meta: { created: true },
      });

      return apiSuccess(
        {
          enabled: true,
          activeTokenCount: 1,
          token: rawToken,
          created: true,
        },
        201,
      );
    }

    const revoked = await prisma.apiToken.updateMany({
      where: {
        userId: user.id,
        revoked: false,
        permissions: { has: scope },
      },
      data: { revoked: true },
    });

    await auditLog("medication.api_endpoint.disable", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        medicationName: medication.name,
        revokedTokens: revoked.count,
      },
    });

    annotate({
      action: {
        name: "medication.api_endpoint.disable",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { revoked_token_count: revoked.count },
    });

    return apiSuccess({
      enabled: false,
      revokedTokenCount: revoked.count,
    });
  },
);
