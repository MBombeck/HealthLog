import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import {
  decryptContextSoft,
  encryptContextToBytes,
} from "@/lib/labs/biomarker-store";
import { annotate } from "@/lib/logging/context";
import { createBiomarkerSchema } from "@/lib/validations/biomarkers";

/**
 * v1.18.1 — user-scoped Biomarker catalog (`/api/biomarkers`).
 *
 * Module gate: like `/api/labs/*`, this is intentionally NOT server-gated.
 * The Labs module toggle is a UX-only nav preference; the data is owner-scoped
 * and read by cross-feature surfaces (Vorsorge reminder resolution, the
 * doctor-report PDF) regardless of the toggle. Deliberate opt-out, in contrast
 * to the gated `/api/illness/*` routes.
 *
 * The catalog is the Labs feature's primary object: a marker is defined ONCE
 * (name, unit, reference bounds, optional context) and every later reading
 * just picks it. GET lists the caller's markers; POST defines a new one.
 * `userId` is always narrowed from the session — never a body field — and the
 * write `data` object is built field-by-field (no mass assignment). The
 * optional context note is AES-256-GCM encrypted into the `contextEncrypted`
 * Bytes column before write. The `@@unique([userId, name])` index means there
 * is never a second "LDL" definition for one user.
 */

// The encrypted context bytes are never echoed back; `hasContext` flags
// presence. The list path decrypts FAIL-SOFT (`decryptContextSoft` → null on
// a bad-key / malformed row) so one un-decryptable row never 500s the whole
// catalog — the single-resource GET is the authoritative read for the
// plaintext context. This bounds the fail-closed blast radius to one marker.
function serialiseBiomarker(row: {
  id: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  hidden: boolean;
  contextEncrypted: Uint8Array | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    lowerBound: row.lowerBound,
    upperBound: row.upperBound,
    panel: row.panel,
    hasContext: row.contextEncrypted !== null,
    context: decryptContextSoft(row.contextEncrypted),
    hidden: row.hidden,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // Visible markers first, then hidden — the manager renders them in two
  // sections and the lab-entry pickers drop the hidden tail client-side.
  const rows = await prisma.biomarker.findMany({
    where: { userId: user.id },
    orderBy: [{ hidden: "asc" }, { name: "asc" }],
  });

  annotate({
    action: { name: "labs.biomarker.list" },
    meta: { total: rows.length },
  });

  return apiSuccess({ biomarkers: rows.map(serialiseBiomarker) });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBiomarker));

async function postBiomarker(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createBiomarkerSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "labs.biomarker.create.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "labs.biomarker.create.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — the 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "labs.biomarker.create.invalid",
    });
  }

  const { name, unit, lowerBound, upperBound, context, panel } = parsed.data;

  // Reject a duplicate name up front so the client sees a clean 409 rather
  // than a Prisma unique-constraint 500. The `@@unique([userId, name])` index
  // is the structural backstop.
  const existing = await prisma.biomarker.findFirst({
    where: { userId: user.id, name },
    select: { id: true },
  });
  if (existing) {
    return apiError("A biomarker with this name already exists", 409, {
      errorCode: "labs.biomarker.duplicate",
    });
  }

  // Field-by-field assignment — never spread `parsed.data`.
  const created = await prisma.biomarker.create({
    data: {
      userId: user.id,
      name,
      unit,
      lowerBound: lowerBound ?? null,
      upperBound: upperBound ?? null,
      panel: panel ?? null,
      contextEncrypted: context ? encryptContextToBytes(context) : null,
    },
  });

  await auditLog("biomarker.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { biomarkerId: created.id },
  });

  annotate({
    action: { name: "labs.biomarker.create" },
    meta: { biomarkerId: created.id },
  });

  return apiSuccess(serialiseBiomarker(created), 201);
}
