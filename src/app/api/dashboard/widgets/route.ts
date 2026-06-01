/**
 * GET / PUT / DELETE dashboard widget layout.
 *
 * GET returns the resolved effective layout (defaults merged in if the user
 * hasn't customized yet). PUT replaces the layout atomically. DELETE resets
 * to default.
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
  resolveDashboardLayout,
  serializeDashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  COMPARISON_BASELINES,
  CHART_OVERLAY_KEYS,
  type ChartOverlayPrefsMap,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import { Prisma } from "@/generated/prisma/client";
import { z } from "zod/v4";
import { invalidateUserDashboardWidgets } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { redactSensitiveFields } from "@/lib/observability/redact-payload";
import type { NextRequest } from "next/server";

// Single source of truth — every widget id the layout accepts. The
// Settings → Dashboard UI iterates the full layout; missing an id here
// used to make the PUT 422 silently (the toast surfaced "Layout konnte
// nicht gespeichert werden") and the user's tile-toggle looked like it
// did nothing because the save round-trip never completed. v1.4.16 A5
// root-cause: `achievements` was absent so every save against the
// default layout was rejected.
//
// v1.7.0 W1 — widened from the 16 web-known ids to the full 27-id
// catalogue (16 web + 11 iOS-only). The native client materialises the
// 11 HK-completeness tiles in its own default layout and PUTs the union;
// accepting + persisting all 27 lets iOS drop its local merge
// workarounds (`byMergingIosOnlyDefaults` / `byRestoringIosOnlyWidgets`).
// The web surface still renders only its 16 tiles and retains the other
// 11 untouched in the stored blob.
const widgetIdEnum = z.enum(DASHBOARD_WIDGET_CATALOGUE_IDS);

// v1.4.43 B2 — dedup helper extracted to `src/lib/audit-dedup.ts` so both
// `/api/dashboard/widgets` and `/api/dashboard/chart-overlay-prefs` share
// the same 60 s `(userId, action)` window.
export { __resetAuditDedupMemoForTests } from "@/lib/audit-dedup";
import { shouldEmitAuditRow } from "@/lib/audit-dedup";

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
    // v1.7.0 W1 — raised from 20 to 30 so the full 27-id catalogue PUT
    // (web 16 + iOS-only 11) fits with headroom; the enum still bounds
    // each id to one of the 27.
    .max(30),
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

  // v1.7.0 W1 — accept-and-ignore widget ids OUTSIDE the 27-id catalogue
  // on write. The 27 ids (16 web + 11 iOS-only) all validate + persist;
  // only a genuinely-unknown id (a retired tile, or a typo) is filtered
  // out here BEFORE Zod so it can't 422 the whole blob. The strict enum
  // still validates the surviving ids, so a malformed entry (non-string
  // id, missing `order`) still 422s. An id outside the catalogue
  // silently vanishes — acceptable, and greppable via the annotation.
  const knownWidgetIds = new Set<string>(DASHBOARD_WIDGET_CATALOGUE_IDS);
  if (
    body &&
    typeof body === "object" &&
    Array.isArray((body as { widgets?: unknown }).widgets)
  ) {
    const widgetsBody = body as {
      widgets: Array<{ id?: unknown }>;
    };
    const droppedIds = widgetsBody.widgets
      .map((w) => w?.id)
      .filter(
        (id): id is string =>
          typeof id === "string" && !knownWidgetIds.has(id),
      );
    if (droppedIds.length > 0) {
      widgetsBody.widgets = widgetsBody.widgets.filter(
        (w) => !(typeof w?.id === "string" && !knownWidgetIds.has(w.id)),
      );
      // v1.7.0 — the unknown-id filter runs over the FULL incoming
      // `widgets` array BEFORE Zod's `.max(20)` applies, so `droppedIds`
      // is bounded only by the request body limit. Cap the logged array
      // (keep the full `dropped_count`) so a single large request can't
      // push thousands of strings into one wide-event line.
      annotate({
        action: { name: "dashboard.widgets.unknown-id-dropped" },
        meta: {
          dropped_ids: droppedIds.slice(0, 20),
          dropped_count: droppedIds.length,
        },
      });
    }
  }

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.42 W2 — the legacy `issues[0].message` envelope dropped
    // every issue past the first. iOS contract debugging hit one
    // round-trip per wrong field; the new helper surfaces every
    // issue under `details.issues`. We additionally emit an
    // append-only audit-ledger row so the operator can grep
    // `/api/admin/audit` for these without combing the iOS dev
    // console.
    const issues = sanitiseZodIssues(parsed.error.issues);
    // v1.4.48 H-iOS-1 — surface the iOS-sent payload shape alongside
    // the Zod rejection so a single wide-event line carries enough
    // detail to diagnose serialiser drift in `HealthLog-iOS`. We log
    // ONLY the top-level keys plus a hard 256-char JSON excerpt — never
    // the full body — so PII / token-like fields cannot leak. The
    // diagnostic shape is built by the shared `buildPayloadDiagnostic`
    // helper (v1.4.49) so the widget + series routes can't drift; the
    // body is routed through `redactSensitiveFields` first so any
    // future field matching the denylist (password / token / secret /
    // apiKey / authorization / csrfState / nonce) lands as the literal
    // `"[redacted]"` instead of its raw value.
    const payloadDiagnostic = buildPayloadDiagnostic(redactSensitiveFields(body));
    annotate({
      action: { name: "dashboard.widgets.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...payloadDiagnostic,
        zod_issues: issues,
      },
    });
    // v1.4.43 B2 — gate the breadcrumb behind a 60 s (userId, action) dedup
    // so a misbehaving iOS client retrying every second cannot pump
    // thousands of identical rows into the audit ledger.
    if (
      shouldEmitAuditRow(
        user.id,
        "dashboard.widgets.validation-failed",
        Date.now(),
      )
    ) {
      // Best-effort breadcrumb — never block the 422 on a write miss.
      // v1.4.49 — strip `message` from the audit-ledger row so Zod
      // codes that embed the offending value in their default message
      // (`invalid_enum_value` and similar) cannot leak user content
      // through the audit surface. The wide-event excerpt above
      // already carries the shape signal for operator debugging.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "dashboard.widgets.validation-failed",
            details: JSON.stringify({ issues: auditIssues }),
          },
        })
        .catch(() => {
          /* swallow — validation response is the contract, audit row is best-effort */
        });
    }
    return returnAllZodIssues(parsed.error, 422);
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
