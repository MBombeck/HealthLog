/**
 * v1.18.0 — `GET` / `PATCH /api/admin/settings/module-availability` —
 * operator-side surface for the server-wide module availability matrix.
 *
 * The SECOND layer of the two-layer module model. A module the operator
 * turns off here is off for EVERY account regardless of that account's
 * personal preference — mirroring the coach master flag
 * (`assistant_coach_enabled`) sitting above the per-user
 * `User.disableCoach`. The gate (`src/lib/modules/gate.ts`) AND-s this
 * operator availability with the per-user opt-out, and `GET /api/auth/me`
 * already projects the resolved (operator AND user) map, so web + iOS need
 * no extra logic.
 *
 * Dedicated endpoint (separate from the generic `/api/admin/settings`)
 * so the admin panel can wire an optimistic matrix against a focused
 * request/response shape and the audit trail carries a single
 * `admin.settings.module-availability.update` action.
 *
 * Request shape — a partial DISABLED-allowlist patch keyed by toggleable
 * module key; every field optional; `true` ⇒ available, `false` ⇒ disabled
 * server-wide:
 *
 *   { "mood": false, "glucose": true }
 *
 * Core domains (weight, BP, pulse, medications) are NOT module keys; the
 * `.strict()` schema rejects them, so the measurement engine + meds can
 * never be disabled through this route.
 *
 * `requireAdmin()` gates the route — cookie-only by construction; a Bearer
 * token (even `["*"]` scope) cannot reach it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getAssistantFlags } from "@/lib/feature-flags";
import {
  mergeAvailabilityPatch,
  resolveOperatorAvailability,
} from "@/lib/modules/operator-availability";
import { MODULE_KEYS, SWITCH_OWNED_MODULE_KEYS } from "@/lib/modules/registry";

export const dynamic = "force-dynamic";

/**
 * Strict per-module boolean patch. Building the shape from `MODULE_KEYS`
 * keeps the schema exhaustive and rejects any non-module key (including
 * the four core domains) at the validation boundary.
 *
 * The Coach is left out and therefore refused: its operator layer is the
 * Coach switch on the assistant panel, and a second place to turn it off
 * would be a second answer to one question.
 */
const moduleAvailabilitySchema = z
  .object(
    Object.fromEntries(
      MODULE_KEYS.filter((key) => !SWITCH_OWNED_MODULE_KEYS.includes(key)).map(
        (key) => [key, z.boolean().optional()],
      ),
    ) as Record<(typeof MODULE_KEYS)[number], z.ZodOptional<z.ZodBoolean>>,
  )
  .strict();

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.settings.module-availability.get" } });

  const [settings, switches] = await Promise.all([
    prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { moduleAvailabilityJson: true },
    }),
    getAssistantFlags(),
  ]);

  return apiSuccess({
    availability: resolveOperatorAvailability(
      settings?.moduleAvailabilityJson,
      switches.coach,
    ),
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.settings.module-availability.update" } });

  const parsed = await parseJsonBody(request, moduleAvailabilitySchema, {
    maxBytes: 64 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const patch: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (typeof value === "boolean") {
      patch[key] = value;
    }
  }

  if (Object.keys(patch).length === 0) {
    return apiError("No valid fields", 422);
  }

  // Merge onto the existing blob so a partial PATCH leaves untouched keys
  // intact; the merge drops any non-module key defensively.
  const existing = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
    select: { moduleAvailabilityJson: true },
  });
  const merged = mergeAvailabilityPatch(
    existing?.moduleAvailabilityJson,
    patch,
  );

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: { moduleAvailabilityJson: merged },
    create: { id: "singleton", moduleAvailabilityJson: merged },
    select: { moduleAvailabilityJson: true },
  });

  await auditLog("admin.settings.module-availability.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: patch,
  });

  return apiSuccess({
    availability: resolveOperatorAvailability(
      settings.moduleAvailabilityJson,
      (await getAssistantFlags()).coach,
    ),
  });
});
