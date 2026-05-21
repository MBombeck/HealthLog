/**
 * PUT /api/dashboard/chart-overlay-prefs — v1.4.18
 *
 * Persist a single chart's overlay-prefs (3 toggles) onto the existing
 * `User.dashboardWidgetsJson` blob. the maintainer rejected v1.4.16's always-on
 * chart overlays (gradient fill, personal-baseline reference line,
 * target-zone shading); the new pattern is per-chart switches that the
 * user opts into independently and that persist per user.
 *
 * Why a partial-update route instead of round-tripping the full layout:
 * the client only knows which chart it's flipping; making it re-send the
 * entire widget array would force every chart wrapper to read+write the
 * full layout state, which is wasteful and racy when multiple charts
 * are mutated simultaneously. The handler reads the current layout, merges
 * the new prefs for the supplied `chartKey`, and writes it back inside the
 * same request.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { shouldEmitAuditRow } from "@/lib/audit-dedup";
import { annotate } from "@/lib/logging/context";
import { prisma, toJson } from "@/lib/db";
import {
  CHART_OVERLAY_KEYS,
  resolveDashboardLayout,
  serializeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { invalidateUserDashboardWidgets } from "@/lib/cache/invalidate";
import { z } from "zod/v4";
import type { NextRequest } from "next/server";

const prefsSchema = z.object({
  chartKey: z.enum(CHART_OVERLAY_KEYS),
  prefs: z.object({
    showTrendIndicator: z.boolean(),
    showTrendArrow: z.boolean(),
    showTargetRange: z.boolean(),
    comparisonBaseline: z
      .enum(["none", "lastMonth", "lastYear"])
      .default("none"),
  }),
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = prefsSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — sibling of `/api/dashboard/widgets`; the per-chart
    // overlay popover hits this on every toggle so the multi-issue
    // envelope matches widgets exactly. Audit breadcrumb keyed
    // `dashboard.chart-overlay.validation-failed`, deduped via the
    // shared `shouldEmitAuditRow` 60 s `(userId, action)` window so a
    // misbehaving iOS client looping the popover cannot flood the
    // audit ledger.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "dashboard.chart-overlay.validation-failed" },
      meta: { issue_count: issues.length },
    });
    if (
      shouldEmitAuditRow(user.id, "dashboard.chart-overlay.validation-failed")
    ) {
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "dashboard.chart-overlay.validation-failed",
            details: JSON.stringify({ issues }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
    }
    return returnAllZodIssues(parsed.error, 422);
  }

  // Read-modify-write inside a Serializable transaction so two
  // concurrent toggles (e.g. user opens two tabs and flips overlays
  // on different charts) can't drop one another's update by reading
  // the same layout snapshot and clobbering each other on write.
  // Resolver normalises legacy / missing fields, so layouts saved
  // before v1.4.18 pick up the new field with default-empty prefs
  // without a one-off migration.
  await prisma.$transaction(
    async (tx) => {
      const row = await tx.user.findUnique({
        where: { id: user.id },
        select: { dashboardWidgetsJson: true },
      });

      const current = resolveDashboardLayout(row?.dashboardWidgetsJson);
      const next: DashboardLayout = {
        ...current,
        chartOverlayPrefs: {
          ...(current.chartOverlayPrefs ?? {}),
          [parsed.data.chartKey]: parsed.data.prefs,
        },
      };
      const normalized = serializeDashboardLayout(next);

      await tx.user.update({
        where: { id: user.id },
        data: {
          dashboardWidgetsJson: toJson(normalized),
        },
      });
    },
    { isolationLevel: "Serializable" },
  );

  // The partial-update path mutates the same `User.dashboardWidgetsJson`
  // blob the `/api/dashboard/widgets` GET reads from. Bust the cache so
  // the next dashboard mount surfaces the new chartOverlayPrefs slot.
  invalidateUserDashboardWidgets(user.id);

  annotate({
    action: { name: "dashboard.chartOverlayPrefs.update" },
    meta: {
      chart_key: parsed.data.chartKey,
      // Track which toggles ended up on so we can audit drift later.
      flags_on: Object.entries(parsed.data.prefs)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(","),
    },
  });

  return apiSuccess({ saved: true });
});
