/**
 * GET / PUT / DELETE insights tile layout.
 *
 * GET returns the resolved effective layout (defaults merged in if the
 * user hasn't customised yet). PUT replaces the layout atomically.
 * DELETE resets to default.
 *
 * Mirrors the shape and semantics of `/api/dashboard/widgets` so the
 * iOS client + the Settings UI can persist insights tile order +
 * visibility through the same contract. The two surfaces stay separate
 * columns on `User` (`dashboard_widgets_json` / `insights_layout_json`)
 * to keep each resolver's known-id set authoritative — overloading a
 * single blob with a `surface` discriminator would force every read to
 * demux first.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  buildPayloadDiagnostic,
  safeJson,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma, toJson } from "@/lib/db";
import {
  resolveInsightsLayout,
  serializeInsightsLayout,
  DEFAULT_INSIGHTS_LAYOUT,
  ACCEPTED_INSIGHTS_TILE_IDS,
  type InsightsLayout,
} from "@/lib/insights-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import { invalidateUserInsightsLayout } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { redactSensitiveFields } from "@/lib/observability/redact-payload";
import { shouldEmitAuditRow } from "@/lib/audit-dedup";
import type { NextRequest } from "next/server";

// Derive the enum from `ACCEPTED_INSIGHTS_TILE_IDS` so the schema + the
// default layout cannot drift — the same root-cause class that produced
// the v1.4.16 A5 silent-422 on dashboard widgets when `achievements`
// was added to the layout but not to the validation enum.
//
// v1.8.0 — the accepted set is canonical English ids PLUS the legacy
// German aliases, so an iOS client still PUTting `blutdruck` / `puls` /
// … passes validation rather than tripping a 422 on the rename.
// `serializeInsightsLayout` normalises any legacy id onto its canonical
// English replacement before the row persists, so the stored blob is
// always canonical regardless of which id the client sent.
const tileIdEnum = z.enum(ACCEPTED_INSIGHTS_TILE_IDS);

const layoutSchema = z.object({
  version: z.literal(1),
  tiles: z
    .array(
      z.object({
        id: tileIdEnum,
        visible: z.boolean(),
        order: z.number().int().min(0).max(99),
      }),
    )
    .min(1)
    .max(50),
});

async function buildInsightsLayout(userId: string): Promise<InsightsLayout> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { insightsLayoutJson: true },
  });
  return resolveInsightsLayout(row?.insightsLayoutJson);
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // 5-minute TTL matches the dashboard-widgets cache; the layout
  // changes only when the user hits the Settings save button, which
  // invalidates this cache via `invalidateUserInsightsLayout()`.
  const layout = await cached(
    caches.insightsLayout as ServerCache<InsightsLayout>,
    user.id,
    () => buildInsightsLayout(user.id),
    annotate,
  );
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    // Multi-issue 422 envelope matches the dashboard-widgets route so
    // iOS contract debugging surfaces every wrong field in one
    // round-trip; the wide-event line carries the redacted payload
    // shape for operator debugging without leaking the raw body.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const payloadDiagnostic = buildPayloadDiagnostic(redactSensitiveFields(body));
    annotate({
      action: { name: "insights.layout.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...payloadDiagnostic,
        zod_issues: issues,
      },
    });
    if (
      shouldEmitAuditRow(
        user.id,
        "insights.layout.validation-failed",
        Date.now(),
      )
    ) {
      // Best-effort breadcrumb — never block the 422 on a write miss.
      // `message` strips from the audit row so a future Zod code that
      // embeds the offending value cannot leak through the audit
      // surface (the wide-event excerpt above already carries the
      // shape signal for debugging).
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "insights.layout.validation-failed",
            details: JSON.stringify({ issues: auditIssues }),
          },
        })
        .catch(() => {
          /* swallow — validation response is the contract, audit row is best-effort */
        });
    }
    return returnAllZodIssues(parsed.error, 422);
  }

  const normalized = serializeInsightsLayout(parsed.data);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      insightsLayoutJson: toJson(normalized),
    },
  });

  annotate({
    action: { name: "insights.layout.update" },
    meta: { visible_count: normalized.tiles.filter((t) => t.visible).length },
  });

  invalidateUserInsightsLayout(user.id);

  return apiSuccess(normalized);
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { insightsLayoutJson: Prisma.JsonNull },
  });

  annotate({ action: { name: "insights.layout.reset" } });

  invalidateUserInsightsLayout(user.id);

  return apiSuccess(DEFAULT_INSIGHTS_LAYOUT);
});
