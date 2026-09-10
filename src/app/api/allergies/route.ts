/**
 * `GET  /api/allergies` — newest-first list of the account's allergies.
 * `POST /api/allergies` — create one allergy/intolerance record.
 *
 * A structured AllergyIntolerance-style RECORD, patient-reported — never a
 * clinical diagnosis the app asserts. `userId` is narrowed from auth and fed
 * to the Prisma `where`; it is never a body field. The `data` object is built
 * field-by-field (no mass assignment); the free-text `reaction` + `note` are
 * encrypted at rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import { withIdempotency } from "@/lib/idempotency";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  allergyCreateSchema,
  allergyListQuerySchema,
} from "@/lib/validations/allergy";
import { toAllergyDTO } from "@/lib/records/dto";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = allergyListQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
    includeInactive: params.get("includeInactive") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "allergy.invalid",
    });
  }

  const limit = parsed.data.limit ?? 100;
  const rows = await prisma.allergy.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      ...(parsed.data.includeInactive === "false" ? { status: "ACTIVE" } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  annotate({
    action: { name: "allergy.list", entity_type: "allergy" },
    meta: { count: rows.length },
  });

  return apiSuccess(rows.map(toAllergyDTO));
});

// `withIdempotency` lets an iOS retry / double-tap re-send the same
// `Idempotency-Key` without minting a duplicate record (the labs /
// illness create precedent).
export const POST = apiHandler(withIdempotency<[NextRequest]>(postAllergy));

async function postAllergy(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE, and reachable.
  //
  // Recording an allergy for somebody whose record you manage is the case the
  // level exists for; on a managed profile it is the guardian's ordinary act.
  // Additive, audited, and the row belongs to the record owner.
  //
  // The surface is Settings → Anamnese inside the record
  // (`src/components/settings/record-anamnesis-section.tsx`, reached through
  // `record-settings-section-gate.tsx` for any destination classified
  // `manage-writable`). This arm carried a long paragraph through v1.36.x
  // arguing that the write was deliberately unreachable and waiting for that
  // surface; the surface exists now, so the paragraph is gone rather than left
  // to send the next reader back to close what it opens.
  //
  // A READ or WRITE delegate reaches neither: the destination is not on their
  // Settings list, and this line refuses them with `sharing.access.denied`
  // regardless.
  const { user, actor } = await requireRecordAuth("manage", "profile");

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = allergyCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "allergy.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "allergy.invalid",
    });
  }

  const entry = parsed.data;

  // Field-by-field — never spread the parsed object whole.
  const created = await prisma.allergy.create({
    data: {
      userId: user.id,
      substance: entry.substance,
      category: entry.category,
      type: entry.type,
      severity: entry.severity ?? null,
      status: entry.status,
      onsetAt: entry.onsetAt ? new Date(entry.onsetAt) : null,
      reactionEncrypted: entry.reaction ? encryptToBytes(entry.reaction) : null,
      notesEncrypted: entry.note ? encryptToBytes(entry.note) : null,
    },
  });

  await auditLog("allergy.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { allergyId: created.id, category: created.category },
  });

  annotate({
    action: {
      name: "allergy.create",
      entity_type: "allergy",
      entity_id: created.id,
    },
    meta: { category: created.category, type: created.type },
  });

  return apiSuccess(toAllergyDTO(created), 201);
}
