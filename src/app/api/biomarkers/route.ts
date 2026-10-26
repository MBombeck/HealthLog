import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import { aliasNamesByMarker } from "@/lib/labs/biomarker-aliases";
import { serialiseBiomarker } from "@/lib/labs/biomarker-dto";
import { encryptContextToBytes } from "@/lib/labs/biomarker-store";
import { matchAnalyteKey } from "@/lib/labs/analyte-match";
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
export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "labs");

  // Visible markers first, then hidden — the manager renders them in two
  // sections and the lab-entry pickers drop the hidden tail client-side.
  const rows = await prisma.biomarker.findMany({
    where: { userId: user.id },
    orderBy: [{ hidden: "asc" }, { name: "asc" }],
  });

  // v1.43 — every marker's other spellings, one read for the whole list.
  const aliases = await aliasNamesByMarker(prisma, user.id, rows);

  annotate({
    action: { name: "labs.biomarker.list" },
    meta: { total: rows.length },
  });

  return apiSuccess({
    biomarkers: rows.map((row) =>
      serialiseBiomarker(row, aliases.get(row.id) ?? [], { soft: true }),
    ),
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBiomarker));

async function postBiomarker(request: NextRequest) {
  // v1.36.x — a delegated write: the marker joins the record's catalogue. The
  // duplicate pre-check and the `@@unique([userId, name])` backstop both scope
  // to the same resolved id, so a delegate adding a marker the owner already
  // tracks gets the ordinary 409 rather than a second copy.
  const { user } = await requireRecordAuth("write", "labs");

  const parsed = await parseJsonBody(request, createBiomarkerSchema, {
    maxBytes: 16 * 1024,
    action: "labs.biomarker.create.validation-failed",
    countIssues: true,
    errorCode: "labs.biomarker.create.invalid",
    onInvalid: (error) => {
      const auditIssues = sanitiseZodIssues(error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.36.x — through `auditLog()`, the only writer that stamps the actor.
      void auditLog("labs.biomarker.create.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — the 422 response is the contract */
      });
    },
  });
  if (!parsed.ok) return parsed.error;

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
      // Which analyte it is, for the unit conversion; null when the name is no
      // analyte the registry knows.
      analyteKey: matchAnalyteKey({ name, unit }),
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

  return apiSuccess(serialiseBiomarker(created, [], { soft: true }), 201);
}
