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
import { auditLog } from "@/lib/auth/audit";
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
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import {
  resolveInsightsLayout,
  serializeInsightsLayout,
  DEFAULT_INSIGHTS_LAYOUT,
  ACCEPTED_INSIGHTS_TILE_IDS,
  INSIGHTS_SECTION_IDS,
  type InsightsLayoutWithToken,
} from "@/lib/insights-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import { invalidateUserInsightsLayout } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { redactForExcerpt } from "@/lib/observability/redact-payload";
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

// v1.15.11 — section ids are new in layout v2, English from birth, so the
// enum is the canonical id universe with no legacy-alias widening.
const sectionIdEnum = z.enum(INSIGHTS_SECTION_IDS);

const layoutSchema = z.object({
  // v1.15.11 — accept BOTH version 1 and 2 on input. The live iOS
  // client still PUTs `version: 1`; `serializeInsightsLayout` hardcodes the
  // stored version to the canonical `INSIGHTS_LAYOUT_VERSION` (2) regardless,
  // so accepting a v1 body writes a canonical v2 blob with zero downside.
  version: z.union([z.literal(1), z.literal(2)]),
  // Additive + optional so a current iOS client PUTting only `tiles`
  // (no `sections` key) still validates; `serializeInsightsLayout` fills
  // the section defaults when the field is absent.
  sections: z
    .array(
      z.object({
        id: sectionIdEnum,
        visible: z.boolean(),
        order: z.number().int().min(0).max(99),
      }),
    )
    .max(50)
    .optional(),
  // Optional too — a section-only PUT (no `tiles` key) is valid; the
  // serializer fills the canonical default tile set. When present it must
  // still carry at least one tile so an empty `[]` is a clear client bug.
  tiles: z
    .array(
      z.object({
        id: tileIdEnum,
        visible: z.boolean(),
        order: z.number().int().min(0).max(99),
      }),
    )
    .min(1)
    // Cap at the accepted-id universe (canonical slugs + legacy aliases) so a
    // single PUT can cover every tile the layout knows about — the cap grows
    // automatically as new sub-page slugs land, rather than tripping a 422
    // once the slug count crosses a hard-coded ceiling.
    .max(ACCEPTED_INSIGHTS_TILE_IDS.length)
    .optional(),
});

async function buildInsightsLayout(
  userId: string,
): Promise<InsightsLayoutWithToken> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    // v1.32.21 — `updatedAt` rides the cached layout so GET hands the
    // client the optimistic-concurrency token alongside the layout it applies
    // to. Cached together (and busted on every write) so the (layout, token)
    // pair a client reads is always consistent — the widgets precedent.
    select: { insightsLayoutJson: true, updatedAt: true },
  });
  return {
    ...resolveInsightsLayout(row?.insightsLayoutJson),
    updatedAt: row?.updatedAt?.toISOString(),
  };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // 5-minute TTL matches the dashboard-widgets cache; the layout
  // changes only when the user hits the Settings save button, which
  // invalidates this cache via `invalidateUserInsightsLayout()`.
  const layout = await cached(
    caches.insightsLayout as ServerCache<InsightsLayoutWithToken>,
    user.id,
    () => buildInsightsLayout(user.id),
    annotate,
  );
  return apiSuccess(layout);
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 256 * 1024,
  });
  if (jsonError) return jsonError;

  // v1.32.21 — pull the optimistic-concurrency base token off the body
  // BEFORE the Zod parse so the domain schema stays pure (issue #581 family).
  const taken = takeBaseToken(rawBody);
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;
  const body = taken.rest;

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    // Multi-issue 422 envelope matches the dashboard-widgets route so
    // iOS contract debugging surfaces every wrong field in one
    // round-trip; the wide-event line carries the redacted payload
    // shape for operator debugging without leaking the raw body.
    const issues = sanitiseZodIssues(parsed.error.issues);
    const payloadDiagnostic = buildPayloadDiagnostic(redactForExcerpt(body));
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
      auditLog("insights.layout.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — validation response is the contract, audit row is best-effort */
      });
    }
    return returnAllZodIssues(parsed.error, 422);
  }

  // v1.16.13 — load the user's stored layout so a PUT that omits a
  // dimension (iOS reorders tiles with a tiles-only body, no `sections`
  // key) preserves the other dimension's customization instead of
  // resetting it to defaults.
  const previous = await buildInsightsLayout(user.id);
  const normalized = serializeInsightsLayout(parsed.data, previous);

  // v1.32.21 — guard the write on the client's base token. A stale base
  // 409s and writes NOTHING (so an interleaved edit-mode Save can't be
  // reverted by a Settings pill-order Save that started from an older read,
  // and vice versa); a tokenless request keeps the prior unconditional write.
  const guarded = await guardedUserUpdate({
    userId: user.id,
    base,
    data: { insightsLayoutJson: toJson(normalized) },
    conflict: {
      action: "insights.layout.conflict",
      errorCode: "insights_layout_conflict",
      message: "Insights layout changed since it was loaded",
    },
  });
  if ("conflict" in guarded) return guarded.conflict;

  annotate({
    action: { name: "insights.layout.update" },
    meta: { visible_count: normalized.tiles.filter((t) => t.visible).length },
  });

  invalidateUserInsightsLayout(user.id);

  return apiSuccess({
    ...normalized,
    updatedAt: guarded.updatedAt,
  } satisfies InsightsLayoutWithToken);
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
