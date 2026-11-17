/**
 * The record's cluster rule (#1368).
 *
 *   GET   /api/seizures/settings — the rule (N seizures within W hours; 2 in
 *         24 hours until one is saved) and NICE's 3-in-24-hours beside it.
 *   PATCH /api/seizures/settings — set the rule, ideally the one written in
 *         the person's emergency plan.
 *
 * Clusters are derived from the rule at read time; changing it re-derives
 * every past episode. MANAGE on a shared record; module-gated.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { requireSeizuresEnabled } from "@/lib/seizures/gate";
import {
  readClusterRule,
  seizureSettingsUpdateSchema,
  toSettingsDTO,
} from "@/lib/seizures/server";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "illness");

  const gate = await requireSeizuresEnabled(user.id);
  if (!gate.enabled) return gate.response;

  annotate({ action: { name: "seizures.settings.read" } });
  return apiSuccess(toSettingsDTO(await readClusterRule(user.id)));
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("manage", "illness");

  const gate = await requireSeizuresEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, seizureSettingsUpdateSchema, {
    maxBytes: 2 * 1024,
    errorCode: "seizures.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const { clusterCount, clusterWindowHours } = parsed.data;

  const before = await readClusterRule(user.id);
  await prisma.seizureDiarySettings.upsert({
    where: { userId: user.id },
    create: { userId: user.id, clusterCount, clusterWindowHours },
    update: { clusterCount, clusterWindowHours },
  });

  await auditLog("seizures.settings.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: overwriteDetails({
      before: {
        clusterCount: before.count,
        clusterWindowHours: before.windowHours,
      },
      after: { clusterCount, clusterWindowHours },
    }),
  });

  invalidateUserHealthContext(user.id);

  annotate({
    action: { name: "seizures.settings.update" },
    meta: { count: clusterCount, window_hours: clusterWindowHours },
  });

  return apiSuccess(
    toSettingsDTO({ count: clusterCount, windowHours: clusterWindowHours }),
  );
});
