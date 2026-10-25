/**
 * `POST /api/dawarich/disconnect` — forget the connection; with
 * `deleteData: true` the stored days go too. Answers
 * `{ disconnected: true, deletedDays }`. Part of the `environment` module;
 * own account only. Disconnecting twice is harmless.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  returnAllZodIssues,
  safeJson,
  isJsonContentType,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { markDisconnected } from "@/lib/integrations/status";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { dawarichDisconnectSchema } from "@/lib/validations/dawarich";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "dawarich.disconnect" } });
  const gate = await requireModuleEnabled(user.id, "environment");
  if (!gate.enabled) return gate.response;

  // The body is optional: no body is `{ deleteData: false }`.
  let body: unknown = {};
  if (isJsonContentType(request.headers.get("content-type"))) {
    const read = await safeJson(request, { maxBytes: 1024 });
    if (read.error) return read.error;
    body = read.data;
  }
  const parsed = dawarichDisconnectSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "dawarich.invalid",
    });
  }

  const deletedDays = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        dawarichUrlEncrypted: null,
        dawarichApiKeyEncrypted: null,
        dawarichPrefsEncrypted: null,
        dawarichAllowPrivateHost: false,
      },
    });
    if (!parsed.data.deleteData) return 0;
    const { count } = await tx.dawarichDay.deleteMany({
      where: { userId: user.id },
    });
    return count;
  });
  await markDisconnected(user.id, "dawarich");
  await auditLog("dawarich.disconnect", {
    userId: user.id,
    details: { deletedDays },
  });
  annotate({ meta: { deleted_days: deletedDays } });

  return apiSuccess({ disconnected: true as const, deletedDays });
});
