/**
 * `PUT /api/admin/settings/assistant-flags` — operator-side flip
 * surface for the six assistant feature flags.
 *
 * Dedicated endpoint (separate from the generic
 * `/api/admin/settings` PUT) so the admin panel can wire its
 * optimistic UI against a focused request/response shape and the
 * audit trail carries `admin.settings.assistant-flags.update` as a
 * single action rather than a noisy diff of the omnibus settings
 * row.
 *
 * Request shape (every field optional — partial flips are allowed):
 *
 *   {
 *     "assistantEnabled": true,
 *     "assistantCoachEnabled": false,
 *     ...
 *   }
 *
 * Response: the resolved flag matrix (master kills every sub-flag
 * before the shape leaves the handler) plus the raw column values
 * so the admin UI can render the master vs sub-flag distinction
 * visually.
 *
 * `requireAdmin()` gates the route — non-admins get 403.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { resolveAssistantFlags } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";

const assistantFlagsSchema = z
  .object({
    assistantEnabled: z.boolean().optional(),
    assistantCoachEnabled: z.boolean().optional(),
    assistantBriefingEnabled: z.boolean().optional(),
    assistantInsightStatusEnabled: z.boolean().optional(),
    assistantCorrelationsEnabled: z.boolean().optional(),
    assistantHealthScoreExplainerEnabled: z.boolean().optional(),
  })
  .strict();

type AssistantFlagsRow = {
  assistantEnabled: boolean;
  assistantCoachEnabled: boolean;
  assistantBriefingEnabled: boolean;
  assistantInsightStatusEnabled: boolean;
  assistantCorrelationsEnabled: boolean;
  assistantHealthScoreExplainerEnabled: boolean;
};

function buildResponseShape(row: AssistantFlagsRow) {
  const resolved = resolveAssistantFlags({
    enabled: row.assistantEnabled,
    coach: row.assistantCoachEnabled,
    briefing: row.assistantBriefingEnabled,
    insightStatus: row.assistantInsightStatusEnabled,
    correlations: row.assistantCorrelationsEnabled,
    healthScoreExplainer: row.assistantHealthScoreExplainerEnabled,
  });
  return {
    raw: {
      assistantEnabled: row.assistantEnabled,
      assistantCoachEnabled: row.assistantCoachEnabled,
      assistantBriefingEnabled: row.assistantBriefingEnabled,
      assistantInsightStatusEnabled: row.assistantInsightStatusEnabled,
      assistantCorrelationsEnabled: row.assistantCorrelationsEnabled,
      assistantHealthScoreExplainerEnabled:
        row.assistantHealthScoreExplainerEnabled,
    },
    resolved,
  };
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.settings.assistant-flags.get" } });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: {
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    },
  });

  const row: AssistantFlagsRow = {
    assistantEnabled: settings?.assistantEnabled ?? true,
    assistantCoachEnabled: settings?.assistantCoachEnabled ?? true,
    assistantBriefingEnabled: settings?.assistantBriefingEnabled ?? true,
    assistantInsightStatusEnabled:
      settings?.assistantInsightStatusEnabled ?? true,
    assistantCorrelationsEnabled:
      settings?.assistantCorrelationsEnabled ?? true,
    assistantHealthScoreExplainerEnabled:
      settings?.assistantHealthScoreExplainerEnabled ?? true,
  };

  return apiSuccess(buildResponseShape(row));
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.settings.assistant-flags.update" } });

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = assistantFlagsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const updates: Partial<AssistantFlagsRow> = {};
  const auditDetails: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (typeof value === "boolean") {
      (updates as Record<string, boolean>)[key] = value;
      auditDetails[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return apiError("No valid fields", 422);
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: updates,
    create: { id: "singleton", ...updates },
  });

  await auditLog("admin.settings.assistant-flags.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: auditDetails,
  });

  const row: AssistantFlagsRow = {
    assistantEnabled: settings.assistantEnabled,
    assistantCoachEnabled: settings.assistantCoachEnabled,
    assistantBriefingEnabled: settings.assistantBriefingEnabled,
    assistantInsightStatusEnabled: settings.assistantInsightStatusEnabled,
    assistantCorrelationsEnabled: settings.assistantCorrelationsEnabled,
    assistantHealthScoreExplainerEnabled:
      settings.assistantHealthScoreExplainerEnabled,
  };

  return apiSuccess(buildResponseShape(row));
});
