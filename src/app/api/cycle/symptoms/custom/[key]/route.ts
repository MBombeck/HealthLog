/**
 * v1.15.1 — update / delete a per-user custom cycle-symptom.
 *
 * Both handlers resolve the `custom:`-prefixed key against the CALLER's own
 * rows only — another user's key (or a catalogue key) is a 404, so a symptom
 * can never be edited or removed across the ownership boundary. Gated
 * (`cycle.disabled` 403). The decrypted label is NEVER logged.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireCycleEnabled } from "@/lib/cycle/gate";
import {
  updateCustomSymptomSchema,
  decryptCustomLabel,
  encryptCustomLabel,
  isCustomSymptomKey,
  MAX_CUSTOM_SYMPTOMS_PER_USER,
} from "@/lib/cycle/custom-symptoms";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ key: string }> };

/** `PATCH /api/cycle/symptoms/custom/:key` — rename / recolour / (de)activate. */
export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireCycleEnabled(user.id, user.gender);
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `cycle:symptom:custom:${user.id}`,
      30,
      60_000,
    );
    if (!rl.allowed) {
      return apiError("Too many requests, try again later", 429);
    }

    const { key } = await params;
    if (!isCustomSymptomKey(key)) return apiError("Not a custom symptom", 404);

    const parsed = await parseJsonBody(request, updateCustomSymptomSchema, {
      maxBytes: 64 * 1024,
      errorCode: "cycle.symptom.custom.invalid",
    });
    if (!parsed.ok) return parsed.error;

    const owned = await prisma.cycleSymptom.findFirst({
      where: { key, userId: user.id },
      select: { id: true, isActive: true },
    });
    if (!owned) return apiError("Custom symptom not found", 404);

    // Reactivation (soft-hidden → active) re-enters the active set, so it must
    // re-clear the per-user cap — a hidden row doesn't count toward it, and
    // skipping the recheck here would let a user exceed the limit by hiding
    // then re-enabling rows.
    if (parsed.data.isActive === true && !owned.isActive) {
      const activeCount = await prisma.cycleSymptom.count({
        where: { userId: user.id, isActive: true },
      });
      if (activeCount >= MAX_CUSTOM_SYMPTOMS_PER_USER) {
        return apiError(
          `Custom symptom limit reached (${MAX_CUSTOM_SYMPTOMS_PER_USER})`,
          422,
          { errorCode: "cycle.symptom.custom.limit" },
        );
      }
    }

    const updated = await prisma.cycleSymptom.update({
      where: { id: owned.id },
      data: {
        ...(parsed.data.label !== undefined
          ? { labelEncrypted: encryptCustomLabel(parsed.data.label) }
          : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      },
      select: { key: true, icon: true, isActive: true, labelEncrypted: true },
    });

    // Symmetry with the DELETE sibling: an edit to a custom symptom leaves a
    // ledger row too. The decrypted label is never logged (see the docstring);
    // we record only which fields the write touched and the resulting active
    // state, so the trace stays free of reproductive free text.
    await auditLog("cycle.symptom.custom.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        fields: Object.keys(parsed.data),
        isActive: updated.isActive,
      },
    });

    annotate({ action: { name: "cycle.symptom.custom.update" } });

    return apiSuccess({
      key: updated.key,
      label: decryptCustomLabel(updated.labelEncrypted),
      icon: updated.icon,
      isActive: updated.isActive,
      custom: true,
    });
  },
);

/**
 * `DELETE /api/cycle/symptoms/custom/:key` — soft-deactivate by default
 * (history intact); `?purge=true` hard-deletes the row and cascades its links.
 */
export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const gate = await requireCycleEnabled(user.id, user.gender);
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `cycle:symptom:custom:${user.id}`,
      30,
      60_000,
    );
    if (!rl.allowed) {
      return apiError("Too many requests, try again later", 429);
    }

    const { key } = await params;
    if (!isCustomSymptomKey(key)) return apiError("Not a custom symptom", 404);

    const owned = await prisma.cycleSymptom.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Custom symptom not found", 404);

    const purge = request.nextUrl.searchParams.get("purge") === "true";
    if (purge) {
      // FK cascade removes the `cycle_symptom_links` rows too.
      await prisma.cycleSymptom.delete({ where: { id: owned.id } });
    } else {
      await prisma.cycleSymptom.update({
        where: { id: owned.id },
        data: { isActive: false },
      });
    }

    await auditLog("cycle.symptom.custom.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { purge },
    });

    annotate({
      action: { name: "cycle.symptom.custom.delete" },
      meta: { purge },
    });

    return apiSuccess({ key, purged: purge });
  },
);
