import { NextRequest } from "next/server";
import { fireAndForget } from "@/lib/logging/fire-and-forget";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { withIdempotency } from "@/lib/idempotency";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { resolveOrMintBiomarker } from "@/lib/labs/biomarker-store";
import {
  type ResolvedBiomarker,
  serialiseLabResult,
} from "@/lib/labs/serialise";
import { linkTargets } from "@/lib/links";
import { encryptNoteToBytes } from "@/lib/labs/store";
import { annotate } from "@/lib/logging/context";
import {
  createLabResultSchema,
  listLabResultsSchema,
} from "@/lib/validations/labs";

/**
 * v1.17.1 — structured lab-result store (`/api/labs`).
 *
 * Module gate: unlike `/api/illness/*` (gated, every route 403s when the
 * module is off), Labs is intentionally NOT server-gated. The Labs module
 * toggle is a UX-only nav/visibility preference — the data is always
 * owner-scoped and safe to read/write, and the Vorsorge lab-panel reminder
 * + doctor-report PDF read these rows regardless of the nav toggle. Gating
 * here would 403 those legitimate cross-feature reads. Deliberate opt-out.
 *
 * GET lists the caller's live results with optional biomarker / analyte /
 * panel / date filters. POST records a single reading. `userId` is always
 * narrowed from the session — never a body field — and the write `data`
 * object is built field-by-field (no mass assignment). The free-text note,
 * when present, is AES-256-GCM encrypted into the `noteEncrypted` Bytes
 * column before write.
 *
 * v1.18.1 — structured entry: when the body carries a `biomarkerId`, the row
 * links the user-scoped catalog marker and the response resolves its unit +
 * reference range FROM the biomarker (server-authoritative). A free-text body
 * (no `biomarkerId`) resolves-or-mints a catalog marker by
 * `(userId, lower(analyte))`, so NO row ever persists unlinked — every reading
 * is editable + detail-navigable, and the boot-time backfill becomes a pure
 * pre-upgrade migration. The web + iOS clients render the resolved DTO and
 * never recompute.
 */

/** Map the joined biomarker (or null) into the resolver's shape. */
function toResolved(
  bm: {
    id: string;
    name: string;
    unit: string;
    lowerBound: number | null;
    upperBound: number | null;
    panel: string | null;
  } | null,
): ResolvedBiomarker | null {
  return bm ?? null;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "labs");

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listLabResultsSchema.safeParse(params);
  if (!parsed.success) {
    annotate({
      action: { name: "labs.list.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { biomarkerId, analyte, panel, from, to, limit, offset, sortDir } =
    parsed.data;

  const where = {
    userId: user.id,
    deletedAt: null,
    ...(biomarkerId && { biomarkerId }),
    ...(analyte && { analyte }),
    ...(panel && { panel }),
    ...(from || to
      ? {
          takenAt: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.labResult.findMany({
      where,
      // Unique tiebreaker: `takenAt` is a day-resolution timestamp, so a
      // panel drawn in one sitting ties across every analyte in it. Offset
      // paging over a non-unique sort key can repeat a row on one page and
      // drop another, invisibly to both sides.
      orderBy: [{ takenAt: sortDir }, { id: sortDir }],
      take: limit,
      skip: offset,
      include: {
        biomarker: {
          select: {
            id: true,
            name: true,
            unit: true,
            lowerBound: true,
            upperBound: true,
            panel: true,
          },
        },
      },
    }),
    prisma.labResult.count({ where }),
  ]);

  annotate({
    action: { name: "labs.list" },
    meta: { total, limit, offset },
  });

  return apiSuccess({
    results: rows.map((row) =>
      serialiseLabResult(row, toResolved(row.biomarker)),
    ),
    meta: { total, limit, offset },
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postLabResult));

async function postLabResult(request: NextRequest) {
  // v1.36.x — a delegated write. The free-text path may MINT a biomarker, and
  // it mints it under `user.id`: the marker joins the record's catalogue, not
  // the caller's, which is the only reading of "add a result to your record"
  // that leaves the owner with a usable catalogue afterwards.
  const { user, actor } = await requireRecordAuth("write", "labs");

  // Shared per-account write ceiling — see `checkRecordWriteRateLimit`. The
  // batch siblings have always been capped; the per-record creates a looping
  // client hits were not.
  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429, {
      errorCode: "record_write.rate_limited",
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = createLabResultSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "labs.create.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    // Free-text `analyte` / `unit` / `note` could land verbatim in a Zod
    // issue message — strip values from the audit-ledger breadcrumb.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.x — through `auditLog()`, the only writer that stamps
    // `actorUserId`. A bare `prisma.auditLog.create` files a delegate's
    // malformed payload as if the owner had typed it.
    void auditLog("labs.create.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — the 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "labs.create.invalid",
    });
  }

  const {
    biomarkerId,
    panel,
    analyte,
    value,
    valueText,
    unit,
    referenceLow,
    referenceHigh,
    sourceReferenceLow,
    sourceReferenceHigh,
    sourceReferenceText,
    takenAt,
    note,
    source,
    encounterId,
  } = parsed.data;

  // v1.18.9 — a qualitative reading carries `valueText` ("negativ" / …) instead
  // of a number. The Zod refine guarantees exactly one of the two is present.
  const isQualitative = valueText !== undefined;

  // Every row links a catalog marker — no `LabResult` ever persists unlinked
  // (v1.18.1 High). Two paths converge on a `biomarker`:
  //  - Structured: a `biomarkerId` is supplied; resolve + verify ownership
  //    (a forged / foreign id is a 404).
  //  - Free-text: no `biomarkerId`; resolve-or-mint the marker by
  //    `(userId, lower(analyte))` so the legacy quick-capture path still
  //    yields a linked, editable, detail-navigable reading.
  let biomarker: ResolvedBiomarker | null = null;
  if (biomarkerId) {
    const found = await prisma.biomarker.findFirst({
      where: { id: biomarkerId, userId: user.id },
      select: {
        id: true,
        name: true,
        unit: true,
        lowerBound: true,
        upperBound: true,
        panel: true,
      },
    });
    if (!found) {
      return apiError("Biomarker not found", 404, {
        errorCode: "labs.biomarker.notFound",
      });
    }
    biomarker = found;
  } else {
    biomarker = await resolveOrMintBiomarker(user.id, {
      analyte: analyte as string,
      // A qualitative reading has no numeric unit / range — mint the catalog
      // marker with an empty unit label and no bounds. A numeric reading
      // supplies its unit (Zod requires it on the free-text numeric path).
      unit: isQualitative ? (unit ?? "") : (unit as string),
      referenceLow: isQualitative ? null : (referenceLow ?? null),
      referenceHigh: isQualitative ? null : (referenceHigh ?? null),
      panel: panel ?? null,
    });
  }

  // Field-by-field assignment — never spread `parsed.data`. The row stamps the
  // resolved name/unit/range as historical truth (so a later catalog edit does
  // not silently rewrite a past reading) AND keeps the FK; reads resolve the
  // CURRENT catalog values via `serialise`.
  const created = await prisma.labResult.create({
    data: {
      userId: user.id,
      biomarkerId: biomarker.id,
      panel: biomarker.panel,
      analyte: biomarker.name,
      // Exactly one of value / valueText is set (the Zod XOR refine).
      value: value ?? null,
      valueText: valueText ?? null,
      unit: biomarker.unit,
      referenceLow: biomarker.lowerBound,
      referenceHigh: biomarker.upperBound,
      // The window this reading's own report printed, kept beside the catalog
      // stamp rather than folded into it: it governs THIS reading's verdict,
      // and the catalog band stays the net for every reading without one. A
      // qualitative reading has no window to record.
      sourceReferenceLow: isQualitative ? null : (sourceReferenceLow ?? null),
      sourceReferenceHigh: isQualitative ? null : (sourceReferenceHigh ?? null),
      sourceReferenceText: isQualitative ? null : (sourceReferenceText ?? null),
      takenAt,
      // v1.25 (iOS #36) — provenance: the on-device-OCR path posts
      // `source: "OCR"`; an omitted field stays "MANUAL" so the legacy
      // hand-entry contract is unchanged. Narrowed to the closed enum by Zod,
      // never spread from the body.
      source: source ?? "MANUAL",
      noteEncrypted: note ? encryptNoteToBytes(note) : null,
    },
  });
  // The by-the-way half: file the reading against the visit the form offered,
  // if it offered one. Best-effort by design — the reading is the write that
  // matters, and a link that could not be made (a visit deleted between the
  // suggestion and the save) must not lose it. The link service narrows both
  // ends to this record, so an id naming nothing simply writes nothing.
  if (encounterId) {
    await linkTargets(prisma, {
      userId: user.id,
      sourceKind: "encounter",
      sourceId: encounterId,
      targetKind: "labResult",
      targetIds: [created.id],
    }).catch(() => {});
  }

  invalidateUserHealthScore(user.id);
  const dto = serialiseLabResult(created, biomarker);

  await auditLog("labResult.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { labResultId: created.id },
  });

  annotate({
    action: { name: "labs.create" },
    meta: {
      labResultId: created.id,
      biomarkerId: biomarker.id,
      // Whether the client picked a catalog marker (structured) vs the
      // free-text path that resolved-or-minted one server-side.
      structured: biomarkerId !== undefined,
      // v1.25 (iOS #36) — provenance of the reading ("MANUAL" | "OCR").
      source: source ?? "MANUAL",
      // Which window governs this reading's verdict, so a dashboard can see
      // how often a report's own range displaces the catalog band.
      referenceOrigin: dto.referenceOrigin,
    },
  });

  // v1.18.1 (D2) — eventful Lab↔Vorsorge satisfaction. A lab panel just
  // landed; resolve the user's free-text "annual blood panel" reminders
  // now rather than waiting on the 15-min cron. Fire-and-forget.
  fireAndForget(enqueueReminderSatisfy(user.id), {
    action: "reminder.satisfy.enqueue",
  });

  // v1.31.0 — the labs arm of the data-arrival spine. A "panel" has no
  // first-class entity in the schema (it is a nullable label plus a `takenAt`),
  // so the day-scoped singleton key IS the panel grouping: pasting twelve
  // markers from one draw fires twelve emits that collapse into one arrival.
  void emitDataArrival({
    userId: user.id,
    kind: "labs_panel",
    newestSampleAt: created.takenAt,
    insertedCount: 1,
    refId: created.panel ?? undefined,
    source: "manual",
  }).catch(() => {});

  return apiSuccess(dto, 201);
}
