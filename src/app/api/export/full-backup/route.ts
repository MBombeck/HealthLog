/**
 * GET /api/export/full-backup
 *
 * v1.4.16 phase B7. Single-file user-scoped JSON dump that matches the
 * canonical `backupPayloadSchema` (see `src/lib/validations/backup.ts`)
 * — same shape the pg-boss `data-backup` worker writes weekly, so a
 * user can hand this file to an admin and `POST /api/admin/backups/upload`
 * accepts it without further conversion.
 *
 * Response is `application/json` with an attachment filename ending in
 * `.json` so the browser writes a `.json` file even though the route
 * segment doesn't carry the extension.
 *
 * Backup completeness — what this file carries, and what it does not, is
 * declared in `src/lib/export/backup-plan.ts` rather than described here. A
 * sentence beside the code is how the previous version of this comment came
 * to be wrong: it said lab results, biomarkers, illness episodes, allergies,
 * family history and workouts were EXPORT-ONLY and could not be restored.
 * The restore route re-creates all of them, and since v1.33.1 nutrient day
 * totals as well.
 *
 * The gap that IS real: roughly 31 of the models the plan marks `BACKED_UP`
 * have neither a reader here nor a restore branch yet. The plan names each
 * one. Document original files and workout GPS/sample time series are never
 * included; the payload's `manifest` field discloses both, and the export UI
 * states this too.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h).
 * Audit: `user.export.full-backup` with the row counts.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import type { FullBackupCounts } from "@/lib/export/full-backup-payload";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { streamToResponseBody } from "@/lib/export/response-stream";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.full-backup" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  // Written into the response as it is produced (`streamFullBackupJson`), not
  // built and stringified first: for an account of 1.25 million measurements
  // the built payload and its JSON string did not fit a 1 GB container, and
  // the export took the whole app down (#1031). The file is byte for byte
  // what `JSON.stringify` of the payload builder's object gives; the passphrase
  // export beside this route writes the same bytes, encrypted.
  //
  // The counts are only known once the last row has gone out, so the audit
  // row is written then. A file that stops early is audited as a failure.
  const ipAddress = getClientIp(request);
  let counts: FullBackupCounts | undefined;
  const body = streamToResponseBody(
    async (write) => {
      counts = await streamFullBackupJson(prisma, user.id, write);
    },
    {
      onComplete: () =>
        auditLog("user.export.full-backup", {
          userId: user.id,
          ipAddress,
          details: { counts },
        }),
      onError: (err) =>
        auditLog("user.export.full-backup.failed", {
          userId: user.id,
          ipAddress,
          details: {
            reason: err instanceof Error ? err.message : String(err),
          },
        }),
    },
  );

  const stamp = new Date().toISOString().slice(0, 10);
  // Stream the JSON directly (NOT wrapped in the apiSuccess envelope) so
  // the file is a self-contained backup — admin upload + restore expect
  // the raw payload, not `{ data: { ... } }`.
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="healthlog-backup-${user.id}-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
