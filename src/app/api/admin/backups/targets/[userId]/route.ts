/**
 * GET /api/admin/backups/targets/{userId} — whether the copy of an erased
 * account may be restored into this account.
 *
 * The backups console asks before it sends a file a second time with that
 * account as its target, so a refusal costs no upload. The upload decides
 * again on its own (`checkRestoreTarget` in `restore-target.ts`); this answer
 * is advice, not a reservation. It says no for a managed profile, an account
 * pending deletion, and an account that already holds records, naming the
 * models that hold them. Counts and record content are not read.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { checkRestoreTarget } from "@/lib/export/restore-target";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ userId: z.string().min(1).max(64) });

export const GET = apiHandler(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ userId: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    annotate({ action: { name: "admin.backups.target.check" } });

    const rl = await checkRateLimit(
      `admin-backups-target:${admin.id}`,
      30,
      60 * 1000,
    );
    if (!rl.allowed) {
      throw new HttpError(429, "Too many account checks");
    }

    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) return returnAllZodIssues(parsed.error);

    const verdict = await checkRestoreTarget(prisma, parsed.data.userId);
    if (!verdict.ok && verdict.reason === "not_found") {
      throw new HttpError(404, "User not found");
    }
    const target = verdict.target!;
    return apiSuccess({
      id: target.id,
      username: target.username,
      eligible: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      models: verdict.ok ? [] : verdict.models,
    });
  },
);
