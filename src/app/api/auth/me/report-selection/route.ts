/**
 * The owner's saved report selection.
 *
 *  GET  /api/auth/me/report-selection — the saved profile, or `null` when the
 *                                       account has never saved one.
 *  PUT  /api/auth/me/report-selection — replace it.
 *
 * Replace, not merge. A selection is a list of what was chosen, so merging a
 * partial over a stored one would re-introduce exactly the failure this shape
 * removes: a leaf staying in because the caller did not mention it. The body
 * states the whole scope or it is not a scope.
 *
 * Unknown leaf ids are refused with a 422 that names them. A client sending an
 * id this build does not know is a contract mismatch the client has to see.
 *
 * Replaces `GET`/`PUT /api/auth/me/doctor-report-prefs`, whose column nothing
 * outside that route ever read.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  apiValidationError,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma, toJson } from "@/lib/db";
import { savedReportProfileSchema } from "@/lib/report-selection/profile-shape";
import { selectionFromRequest } from "@/lib/report-selection/selection";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "auth.me.report-selection.get" } });

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { reportSelectionJson: true },
  });
  const parsed = savedReportProfileSchema.safeParse(row?.reportSelectionJson);
  // A drifted or absent blob answers `null`, not a default profile: the panel
  // then applies the named template and shows it, which is a visible act
  // rather than a silent server choice.
  return apiSuccess({ profile: parsed.success ? parsed.data : null });
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400, {
      errorCode: "report-selection.body.invalid_json",
    });
  }

  const parsed = savedReportProfileSchema.safeParse(body ?? {});
  if (!parsed.success) {
    annotate({
      action: { name: "auth.me.report-selection.put.invalid" },
      meta: { issues: parsed.error.issues.length },
    });
    // The dotted token keeps its place in `error`: this refusal keeps its 422,
    // so moving the string would be a wire change with nothing forcing it —
    // the `invalid_json` siblings moved only because their status moved to 400
    // anyway. `meta.errorCode` publishes the same token in the field a machine
    // code belongs in, and `details.issues` names the fields that were refused.
    return apiValidationError(
      "report-selection.body.invalid_shape",
      sanitiseZodIssues(parsed.error.issues),
      422,
      { errorCode: "report-selection.body.invalid_shape" },
    );
  }

  const minted = selectionFromRequest(parsed.data);
  if (!minted.ok) {
    annotate({
      action: { name: "auth.me.report-selection.put.invalid" },
      meta: { unknownLeaves: minted.error.unknownLeaves },
    });
    // Not a Zod refusal, so there is no issue list to carry — but the same
    // rule applies: a sentence in `error`, the machine token in
    // `meta.errorCode`, and the leaves that were refused named beside it.
    return apiError(
      "Report selection names leaves this build does not know",
      422,
      {
        errorCode: "report-selection.leaves.unknown",
        unknownLeaves: minted.error.unknownLeaves,
      },
    );
  }

  // Persist the canonical ordering rather than the caller's, so two clients
  // that chose the same scope store the same bytes.
  const profile = {
    v: parsed.data.v,
    leaves: [...minted.selection.leaves],
    format: parsed.data.format,
    rangeDays: parsed.data.rangeDays,
    includeCharts: parsed.data.includeCharts,
  };

  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { reportSelectionJson: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { reportSelectionJson: toJson(profile) },
  });

  // The saved selection is what the FHIR REST face and the MCP doctor-visit
  // surfaces replay for a caller that cannot ask a human, so widening it
  // widens those too. That belongs in the audit trail.
  await auditLog("user.report-selection.update", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: {
      previous: current?.reportSelectionJson ?? null,
      next: profile,
    },
  });

  annotate({
    action: { name: "auth.me.report-selection.put" },
    meta: { leafCount: profile.leaves.length, format: profile.format },
  });
  return apiSuccess({ profile });
});
