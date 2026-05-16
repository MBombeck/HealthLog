/**
 * GET /api/insights/correlations — placeholder iOS endpoint.
 *
 * The full correlations engine is part of `/api/insights/comprehensive`
 * and is intentionally not re-exposed yet — iOS only needs a stable
 * shape to render the empty state. We return `[]` and emit an audit log
 * so the gap is visible until Phase 7 fills it in.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { requireAssistantSurface } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  // v1.4.31 — operator can hide the correlation narration tile.
  await requireAssistantSurface("correlations");
  annotate({ action: { name: "insights.correlations" } });

  await auditLog("insights.correlations.empty", {
    userId: user.id,
    details: { reason: "phase7_pending" },
  });

  return apiSuccess([]);
});
