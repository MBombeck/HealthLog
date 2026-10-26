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
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import {
  aliasNamesByMarker,
  findAliasConflict,
  replaceAliases,
} from "@/lib/labs/biomarker-aliases";
import { serialiseBiomarker } from "@/lib/labs/biomarker-dto";
import { mergedInto } from "@/lib/labs/biomarker-merge";
import { encryptContextToBytes } from "@/lib/labs/biomarker-store";
import { matchAnalyteKey } from "@/lib/labs/analyte-match";
import { annotate } from "@/lib/logging/context";
import { computeLabTrend } from "@/lib/labs/lab-trend";

/** Upper bound on readings the trend line reads. */
const LAB_TREND_READ_CAP = 2000;
import { updateBiomarkerSchema } from "@/lib/validations/biomarkers";
import { effectiveBound, isInvertedRange } from "@/lib/validations/labs";

/**
 * v1.18.1 — single Biomarker resource (`/api/biomarkers/{id}`).
 *
 * PUT applies a partial edit (`data` built field-by-field; an explicit `null`
 * clears `context` / `panel` / a bound, an omitted key leaves it untouched).
 * DELETE hard-deletes the catalog definition together with every reading it
 * owns, in one userId-narrowed transaction — removing a biomarker is a
 * deliberate "drop this and its values" action. Cross-user rows surface as
 * 404 (existence sealed).
 */

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "labs");
    const { id } = await params;

    const row = await prisma.biomarker.findFirst({ where: { id } });
    if (!row || row.userId !== user.id) {
      // v1.43 — a marker merged into another names where it went, so a
      // client holding the old id (a cached screen, a bookmark) can follow.
      const into = await mergedInto(user.id, id);
      return apiError("Biomarker not found", 404, {
        errorCode: "labs.biomarker.notFound",
        ...(into ? { mergedInto: into } : {}),
      });
    }

    const [aliases, readings] = await Promise.all([
      aliasNamesByMarker(prisma, user.id, [row]),
      // v1.44 — the marker's numeric readings for the trend line. Every
      // reading is stored in the marker's unit, so the series needs no
      // conversion; the cap is far above any real panel history.
      prisma.labResult.findMany({
        where: {
          userId: user.id,
          biomarkerId: id,
          deletedAt: null,
          value: { not: null },
        },
        // Newest first, so a capped read keeps the recent end of the series
        // (the staleness check reads the newest reading); the fit sorts.
        orderBy: { takenAt: "desc" },
        take: LAB_TREND_READ_CAP,
        select: { takenAt: true, value: true },
      }),
    ]);
    const trend = computeLabTrend(
      readings.flatMap((r) =>
        r.value === null ? [] : [{ takenAt: r.takenAt, value: r.value }],
      ),
      { low: row.lowerBound, high: row.upperBound },
      new Date(),
    );

    annotate({
      action: { name: "labs.biomarker.get" },
      meta: {
        biomarkerId: id,
        trend: trend.status,
        ...(trend.status === "ok" ? { projection: trend.projection } : {}),
      },
    });

    return apiSuccess({
      ...serialiseBiomarker(row, aliases.get(row.id) ?? []),
      trend,
    });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE, and the closest call in this domain: a reference range
    // recolours every reading under it, so this is the one admitted edit whose
    // error is silent rather than visible. C4 on the audit row is what puts it
    // in the owner's feed. The DELETE below resolves through the same labs
    // authority; it takes the readings with it and files the id.
    const { user } = await requireRecordAuth("manage", "labs");
    const { id } = await params;

    const existing = await prisma.biomarker.findFirst({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Biomarker not found", 404, {
        errorCode: "labs.biomarker.notFound",
      });
    }

    const parsed = await parseJsonBody(request, updateBiomarkerSchema, {
      maxBytes: 16 * 1024,
      action: "labs.biomarker.update.validation-failed",
      countIssues: true,
      meta: { biomarkerId: id },
      errorCode: "labs.biomarker.update.invalid",
      onInvalid: (error) => {
        const auditIssues = sanitiseZodIssues(error.issues, {
          stripValuesFromMessage: true,
        });
        // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
        // .create`, because that helper is the only writer that stamps
        // `actorUserId`. Filed under the resolved record either way; without
        // the stamp a manager's malformed payload would read as the owner's own.
        void auditLog("labs.biomarker.update.validation-failed", {
          userId: user.id,
          details: { issues: auditIssues, biomarkerId: id },
        }).catch(() => {
          /* swallow — the 422 response is the contract */
        });
      },
    });
    if (!parsed.ok) return parsed.error;

    const d = parsed.data;

    // A rename must not collide with another of the caller's markers.
    if (d.name !== undefined && d.name !== existing.name) {
      const clash = await prisma.biomarker.findFirst({
        where: { userId: user.id, name: d.name },
        select: { id: true },
      });
      if (clash) {
        return apiError("A biomarker with this name already exists", 409, {
          errorCode: "labs.biomarker.duplicate",
        });
      }
    }

    // A marker's unit labels every reading linked to it: readers resolve the
    // unit from the marker, and the stored numbers are in the old unit. A
    // change while readings exist would relabel history without converting a
    // single value, so it is refused. Tombstoned readings count too, since an
    // undo brings them back under the new label.
    if (d.unit !== undefined && d.unit !== existing.unit) {
      const readingCount = await prisma.labResult.count({
        where: { userId: user.id, biomarkerId: id },
      });
      if (readingCount > 0) {
        annotate({
          action: { name: "labs.biomarker.update.unit-locked" },
          meta: { biomarkerId: id, readingCount },
        });
        return apiError(
          "The unit of a biomarker with readings cannot be changed",
          422,
          { errorCode: "biomarkers.unit.locked", readingCount },
        );
      }
    }

    // v1.43 — the aliases, when sent, become the marker's whole set. A
    // spelling another marker already answers to (its name or one of its
    // aliases) is refused rather than silently moved.
    if (d.aliases !== undefined) {
      const conflict = await findAliasConflict(prisma, user.id, id, d.aliases);
      if (conflict) {
        return apiError("Another biomarker already answers to this name", 409, {
          errorCode: "labs.biomarker.alias.taken",
          alias: conflict.alias,
          biomarkerId: conflict.biomarkerId,
        });
      }
    }

    // Build `data` field-by-field. `undefined` → leave the column untouched;
    // an explicit `null` on `context` / `panel` / a bound clears it.
    const data: Record<string, unknown> = {};
    if (d.name !== undefined) data.name = d.name;
    if (d.unit !== undefined) data.unit = d.unit;
    if (d.lowerBound !== undefined) data.lowerBound = d.lowerBound;
    if (d.upperBound !== undefined) data.upperBound = d.upperBound;
    if (d.panel !== undefined) data.panel = d.panel;
    if (d.hidden !== undefined) data.hidden = d.hidden;
    // The analyte a marker is follows from its name and unit, the same match
    // the creation paths use. A rename must move it, or a marker renamed from
    // "Glucose" to "Cholesterol" would keep converting readings with the
    // glucose factor; a name that now matches nothing clears it.
    if (d.name !== undefined || d.unit !== undefined) {
      data.analyteKey = matchAnalyteKey({
        name: d.name ?? existing.name,
        unit: d.unit ?? existing.unit,
      });
    }

    // Inverted-range guard for a PARTIAL bound update. The schema refine only
    // fires when both bounds arrive together; moving a single bound past the
    // row's existing other bound would otherwise persist an inverted window.
    // Merge effective bounds (parsed when present, else stored) and 422 when
    // both resolve to concrete numbers with low > high.
    if (
      isInvertedRange(
        effectiveBound(d.lowerBound, existing.lowerBound),
        effectiveBound(d.upperBound, existing.upperBound),
      )
    ) {
      return apiError("lowerBound must not exceed upperBound", 422, {
        errorCode: "labs.biomarker.update.referenceRangeInvalid",
      });
    }
    if (d.context !== undefined) {
      data.contextEncrypted = d.context
        ? encryptContextToBytes(d.context)
        : null;
    }

    const aliasesBefore =
      (await aliasNamesByMarker(prisma, user.id, [existing])).get(id) ?? [];
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.biomarker.update({ where: { id }, data });
      if (d.aliases !== undefined) {
        await replaceAliases(tx, user.id, row, d.aliases);
      }
      return row;
    });
    const aliasesAfter =
      (await aliasNamesByMarker(prisma, user.id, [updated])).get(id) ?? [];
    invalidateUserHealthScore(user.id);

    await auditLog("biomarker.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4, and this is the edit that needs it most: a reference range
      // recolours every reading under it, so the error is silent. The feed has
      // to show the range that was there before. The context note is named and
      // never quoted; it is encrypted on the row.
      details: {
        biomarkerId: id,
        ...overwriteDetails({
          before: {
            name: existing.name,
            unit: existing.unit,
            lowerBound: existing.lowerBound,
            upperBound: existing.upperBound,
            panel: existing.panel,
            hidden: existing.hidden,
          },
          after: {
            name: updated.name,
            unit: updated.unit,
            lowerBound: updated.lowerBound,
            upperBound: updated.upperBound,
            panel: updated.panel,
            hidden: updated.hidden,
          },
          redacted: [
            ...(d.context !== undefined ? ["context"] : []),
            // Named, not quoted: the spellings are the person's own text.
            ...(aliasesBefore.join("\n") !== aliasesAfter.join("\n")
              ? ["aliases"]
              : []),
          ],
        }),
      },
    });

    annotate({
      action: { name: "labs.biomarker.update" },
      meta: { biomarkerId: id },
    });

    return apiSuccess(serialiseBiomarker(updated, aliasesAfter));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // The same record-scoped labs authority as the PUT above. A bare
    // `requireAuth()` here held the one destructive biomarker write to a
    // weaker gate than the edit beside it: no labs domain, no grant level.
    const { user } = await requireRecordAuth("manage", "labs");
    const { id } = await params;

    const existing = await prisma.biomarker.findFirst({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Biomarker not found", 404);
    }

    // Hard delete the marker AND its readings in one transaction. Deleting a
    // biomarker is a deliberate "remove this and its history" action, so the
    // readings go with it rather than lingering as orphaned, unlinked rows.
    // Both legs are userId-narrowed so a cross-user id can never reach another
    // account's data.
    const [removedReadings] = await prisma.$transaction([
      prisma.labResult.deleteMany({
        where: { userId: user.id, biomarkerId: id },
      }),
      prisma.biomarker.delete({ where: { id } }),
    ]);
    invalidateUserHealthScore(user.id);

    await auditLog("biomarker.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C3: a hard delete files what it destroyed — the marker's name, unit,
      // and how many readings went with it — so the owner's feed can say what
      // a manager removed, not just an id that now points at nothing.
      details: {
        biomarkerId: id,
        ...destroyedDetails({
          model: "Biomarker",
          id,
          label: existing.name,
          effectiveAt: existing.createdAt,
          extra: {
            unit: existing.unit,
            readingCount: removedReadings?.count ?? 0,
          },
        }),
      },
    });

    annotate({
      action: { name: "labs.biomarker.delete" },
      meta: { biomarkerId: id },
    });

    return apiSuccess({ deleted: true });
  },
);
