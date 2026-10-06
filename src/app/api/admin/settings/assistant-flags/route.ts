/**
 * `PUT /api/admin/settings/assistant-flags` — operator-side flip
 * surface for the five assistant switches: the master, the Coach, the
 * daily briefing, status notes, and reading documents.
 *
 * A switch that is off stops the AI work it covers and hides the text a
 * model wrote for it; data, scores and statistics keep loading. The Coach
 * switch is the operator's only Coach switch (the Coach row in module
 * availability is read-only and follows it).
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
 * v1.41 — the same route carries the operator's two reasoning controls:
 * `aiReasoningEnabled` (off wins over every person's Coach setting and every
 * background job) and `aiReasoningMaxEffort` (`low` | `medium` | `high`, the
 * highest level any call may take). Echoed as `reasoning: { enabled,
 * maxEffort }`. They sit beside the assistant switches rather than in them:
 * switching reasoning off stops no AI capability, it only stops the model
 * thinking longer before it answers.
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
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { resolveAssistantFlags } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";
import { REASONING_MAX_EFFORTS } from "@/lib/ai/reasoning/levels";
import { parseReasoningMaxEffort } from "@/lib/ai/reasoning/resolve";

const assistantFlagsSchema = z
  .object({
    assistantEnabled: z.boolean().optional(),
    assistantCoachEnabled: z.boolean().optional(),
    assistantBriefingEnabled: z.boolean().optional(),
    assistantInsightStatusEnabled: z.boolean().optional(),
    assistantDocumentAiEnabled: z.boolean().optional(),
    aiReasoningEnabled: z.boolean().optional(),
    aiReasoningMaxEffort: z.enum(REASONING_MAX_EFFORTS).optional(),
  })
  .strict();

type AssistantFlagsRow = {
  assistantEnabled: boolean;
  assistantCoachEnabled: boolean;
  assistantBriefingEnabled: boolean;
  assistantInsightStatusEnabled: boolean;
  assistantDocumentAiEnabled: boolean;
  aiReasoningEnabled: boolean;
  aiReasoningMaxEffort: string;
};

const ROW_SELECT = {
  assistantEnabled: true,
  assistantCoachEnabled: true,
  assistantBriefingEnabled: true,
  assistantInsightStatusEnabled: true,
  assistantDocumentAiEnabled: true,
  aiReasoningEnabled: true,
  aiReasoningMaxEffort: true,
} as const;

function buildResponseShape(row: AssistantFlagsRow) {
  const resolved = resolveAssistantFlags({
    enabled: row.assistantEnabled,
    coach: row.assistantCoachEnabled,
    briefing: row.assistantBriefingEnabled,
    insightStatus: row.assistantInsightStatusEnabled,
    documentAi: row.assistantDocumentAiEnabled,
  });
  return {
    raw: {
      assistantEnabled: row.assistantEnabled,
      assistantCoachEnabled: row.assistantCoachEnabled,
      assistantBriefingEnabled: row.assistantBriefingEnabled,
      assistantInsightStatusEnabled: row.assistantInsightStatusEnabled,
      assistantDocumentAiEnabled: row.assistantDocumentAiEnabled,
    },
    resolved,
    reasoning: {
      enabled: row.aiReasoningEnabled,
      maxEffort: parseReasoningMaxEffort(row.aiReasoningMaxEffort),
    },
  };
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.settings.assistant-flags.get" } });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: ROW_SELECT,
  });

  const row: AssistantFlagsRow = {
    assistantEnabled: settings?.assistantEnabled ?? true,
    assistantCoachEnabled: settings?.assistantCoachEnabled ?? true,
    assistantBriefingEnabled: settings?.assistantBriefingEnabled ?? true,
    assistantInsightStatusEnabled:
      settings?.assistantInsightStatusEnabled ?? true,
    assistantDocumentAiEnabled: settings?.assistantDocumentAiEnabled ?? true,
    aiReasoningEnabled: settings?.aiReasoningEnabled ?? true,
    aiReasoningMaxEffort: settings?.aiReasoningMaxEffort ?? "high",
  };

  return apiSuccess(buildResponseShape(row));
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.settings.assistant-flags.update" } });

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = assistantFlagsSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  // Field by field from the parsed body; the schema is strict, so every key
  // here is one the route owns.
  const updates: Partial<AssistantFlagsRow> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      (updates as Record<string, boolean | string>)[key] = value;
    }
  }
  const auditDetails: Record<string, unknown> = { ...updates };

  if (Object.keys(updates).length === 0) {
    return apiError("No valid fields", 422);
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: updates,
    create: { id: "singleton", ...updates },
    select: ROW_SELECT,
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
    assistantDocumentAiEnabled: settings.assistantDocumentAiEnabled,
    aiReasoningEnabled: settings.aiReasoningEnabled,
    aiReasoningMaxEffort: settings.aiReasoningMaxEffort,
  };

  return apiSuccess(buildResponseShape(row));
});
