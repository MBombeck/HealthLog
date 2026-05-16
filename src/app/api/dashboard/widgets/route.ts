/**
 * GET / PUT / DELETE dashboard widget layout.
 *
 * GET returns the resolved effective layout (defaults merged in if the user
 * hasn't customized yet). PUT replaces the layout atomically. DELETE resets
 * to default.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma, toJson } from "@/lib/db";
import {
  resolveDashboardLayout,
  serializeDashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_WIDGET_IDS,
  COMPARISON_BASELINES,
  CHART_OVERLAY_KEYS,
  type ChartOverlayPrefsMap,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import { invalidateUserDashboardWidgets } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import type { NextRequest } from "next/server";

// Single source of truth — every widget id rendered by the Settings →
// Dashboard UI (`src/components/settings/dashboard-layout-section.tsx`
// iterates the full layout from `DEFAULT_DASHBOARD_LAYOUT`). Missing
// one here makes the PUT 422 silently — the toast surfaces "Layout
// konnte nicht gespeichert werden" — and the user's tile-toggle looks
// like it does nothing because the save round-trip never completes.
// v1.4.16 A5 root-cause: `achievements` was absent from this enum so
// every save attempted with the achievements widget present (i.e.
// every save against the default layout) was rejected. We now derive
// the enum from `DASHBOARD_WIDGET_IDS` so the two lists cannot drift.
const widgetIdEnum = z.enum(DASHBOARD_WIDGET_IDS);

const layoutSchema = z.object({
  version: z.literal(1),
  widgets: z
    .array(
      z.object({
        id: widgetIdEnum,
        visible: z.boolean(),
        // v1.4.15 Fix 5 — independent strip-tile visibility. Optional
        // for back-compat with v1.4.14 clients that haven't been
        // updated; the resolver mirrors `visible` when omitted.
        tileVisible: z.boolean().optional(),
        order: z.number().int().min(0).max(99),
      }),
    )
    .min(1)
    .max(20),
  // v1.4.16 phase B8 — comparison baseline (Vormonat / Vorjahr) rides
  // on the layout blob per research §7 Q3 (no Prisma migration). Optional
  // so v1.4.15 clients that don't know the field can still PUT.
  comparisonBaseline: z.enum(COMPARISON_BASELINES).optional(),
  // v1.4.18 — per-chart overlay prefs (3 toggles per chart card).
  // Optional so older clients that don't know the field can still PUT;
  // the resolver coerces malformed values away from the layout blob.
  //
  // v1.4.25 W6 — switched from `z.record(enum, …)` to `z.partialRecord(…)`
  // because Zod v4 changed the semantics of `z.record(enum, …)`: it now
  // requires every enum key to be present (a breaking change from
  // Zod v3 which behaved like a partial record). With the strict variant
  // any PUT that carried `chartOverlayPrefs` with fewer than ALL nine
  // chart keys (i.e. every real-world Save click once a user had touched
  // a per-chart overlay popover) 422'd with
  // `expected: object, path: ["chartOverlayPrefs", "<missing-key>"]` and
  // surfaced as the toast `Layout konnte nicht gespeichert werden`.
  // Partial-record matches the original intent — overlay prefs are
  // per-chart opt-in, the resolver fills in defaults for missing keys.
  //
  // The inner object also documents `comparisonBaseline` so the
  // per-chart `<ChartOverlayControls>` popover (which calls
  // `/api/dashboard/chart-overlay-prefs`) and a full-layout PUT from
  // Settings → Dashboard can both round-trip the field. Without it Zod
  // would silently strip the per-chart `comparisonBaseline` on every
  // Save click in Settings, wiping any per-chart toggle the user had
  // set via the chart-card popover.
  chartOverlayPrefs: z
    .partialRecord(
      z.enum(CHART_OVERLAY_KEYS),
      z.object({
        showTrendIndicator: z.boolean(),
        showTrendArrow: z.boolean(),
        showTargetRange: z.boolean(),
        comparisonBaseline: z
          .enum(["none", "lastMonth", "lastYear"])
          .optional(),
      }),
    )
    .optional(),
});

async function buildDashboardLayout(userId: string): Promise<DashboardLayout> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { dashboardWidgetsJson: true },
  });
  return resolveDashboardLayout(row?.dashboardWidgetsJson);
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // 5-minute TTL per blueprint §5; the layout changes only when the user
  // hits the Settings → Dashboard save button, which invalidates this
  // cache via `invalidateUserDashboardWidgets()`.
  const layout = await cached(
    caches.dashboardWidgets as ServerCache<DashboardLayout>,
    user.id,
    () => buildDashboardLayout(user.id),
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
    return apiError(parsed.error.issues[0].message, 422);
  }

  // v1.4.18 — preserve any per-chart overlay prefs that the client
  // didn't send. The dashboard-layout PUT typically saves widget
  // visibility / order; chart prefs are PUT through their own route
  // (`/api/dashboard/chart-overlay-prefs`) and would otherwise be
  // wiped here on a subsequent layout save.
  let mergedChartOverlayPrefs: ChartOverlayPrefsMap | undefined = parsed.data
    .chartOverlayPrefs as ChartOverlayPrefsMap | undefined;
  if (mergedChartOverlayPrefs === undefined) {
    const existing = await prisma.user.findUnique({
      where: { id: user.id },
      select: { dashboardWidgetsJson: true },
    });
    mergedChartOverlayPrefs =
      resolveDashboardLayout(existing?.dashboardWidgetsJson)
        .chartOverlayPrefs ?? {};
  }
  const normalized = serializeDashboardLayout({
    ...parsed.data,
    chartOverlayPrefs: mergedChartOverlayPrefs,
  } as DashboardLayout);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      dashboardWidgetsJson: toJson(normalized),
    },
  });

  annotate({
    action: { name: "dashboard.widgets.update" },
    meta: { visible_count: normalized.widgets.filter((w) => w.visible).length },
  });

  // v1.4.34 IW-G — bust the per-user dashboard-widgets cache so the
  // next dashboard mount paints the new layout.
  invalidateUserDashboardWidgets(user.id);

  return apiSuccess(normalized);
});

export const DELETE = apiHandler(async () => {
  const { user } = await requireAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { dashboardWidgetsJson: Prisma.JsonNull },
  });

  annotate({ action: { name: "dashboard.widgets.reset" } });

  // v1.4.34 IW-G — bust the per-user dashboard-widgets cache so the
  // next dashboard mount paints the reset (default) layout.
  invalidateUserDashboardWidgets(user.id);

  return apiSuccess(DEFAULT_DASHBOARD_LAYOUT);
});
