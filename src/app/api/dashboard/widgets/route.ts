/**
 * GET / PUT / DELETE dashboard widget layout.
 *
 * GET returns the resolved effective layout (defaults merged in if the user
 * hasn't customized yet). PUT replaces the supplied layout fields atomically.
 * DELETE resets web-controlled choices and preserves the other preferences.
 */
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, safeJson, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { toJson } from "@/lib/db";
import {
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import {
  resolveDashboardLayout,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  COMPARISON_BASELINES,
  CHART_OVERLAY_KEYS,
  SCORE_RING_IDS,
  MAX_SELECTED_SCORE_RINGS,
  HERO_RING_IDS,
  MAX_HERO_RING_ORDER,
  HERO_PRIMARY_CONTENTS,
  type DashboardLayout,
  type DashboardLayoutWithToken,
} from "@/lib/dashboard-layout";
import { buildDashboardLayout } from "@/lib/dashboard/widgets/read-layout";
import { resolveUnavailableWidgetIds } from "@/lib/dashboard/widgets/unavailable-widgets";
import { dropUnknownWidgetIds } from "@/lib/dashboard/widgets/unknown-ids";
import { reportLayoutValidationFailure } from "@/lib/dashboard/widgets/validation-report";
import { layoutToStore } from "@/lib/dashboard/widgets/merge-stored";
import { resetDashboardLayout } from "@/lib/dashboard/widgets/reset-layout";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { z } from "zod/v4";
import { invalidateUserDashboardWidgets } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import type { NextRequest } from "next/server";

// Single source of truth — every widget id the layout accepts. The
// Settings → Dashboard UI iterates the full layout; missing an id here
// used to make the PUT 422 silently (the toast surfaced "Layout konnte
// nicht gespeichert werden") and the user's tile-toggle looked like it
// did nothing because the save round-trip never completed. v1.4.16 A5
// root-cause: `achievements` was absent so every save against the
// default layout was rejected.
//
// v1.7.0 — widened from the 16 web-known ids to the full 27-id
// catalogue (16 web + 11 iOS-only). The native client materialises the
// 11 HK-completeness tiles in its own default layout and PUTs the union;
// accepting + persisting all 27 lets iOS drop its local merge
// workarounds (`byMergingIosOnlyDefaults` / `byRestoringIosOnlyWidgets`).
// The web surface still renders only its 16 tiles and retains the other
// 11 untouched in the stored blob.
const widgetIdEnum = z.enum(DASHBOARD_WIDGET_CATALOGUE_IDS);

// v1.4.43 — dedup helper extracted to `src/lib/audit-dedup.ts` so both
// `/api/dashboard/widgets` and `/api/dashboard/chart-overlay-prefs` share
// the same 60 s `(userId, action)` window.
export { __resetAuditDedupMemoForTests } from "@/lib/audit-dedup";

const layoutSchema = z.object({
  version: z.literal(1),
  widgets: z
    .array(
      z.object({
        id: widgetIdEnum,
        visible: z.boolean(),
        // v1.4.15 — independent strip-tile visibility. Optional
        // for back-compat with v1.4.14 clients that haven't been
        // updated; the resolver mirrors `visible` when omitted.
        tileVisible: z.boolean().optional(),
        order: z.number().int().min(0).max(99),
      }),
    )
    .min(1)
    .max(50)
    // v1.11.2 — raised to 40 so the full catalogue PUT (24 writable +
    // 11 iOS-only = 35) fits with headroom after the v1.10 additive
    // HealthKit signals became pinnable; the enum still bounds each id to
    // one of the catalogue ids.
    //
    // Raised again to 50 when the four clinical signals joined the
    // catalogue (42 ids). The cap only has to clear the catalogue size —
    // the enum bounds each entry and the id set is closed — so it carries
    // headroom rather than tracking the count exactly.
    // Optional + preserve-when-absent. Partial clients can update one layout
    // field without resending a potentially stale widget catalogue; a normal
    // dashboard-layout Save still sends `widgets`.
    .optional(),
  // v1.4.16 — comparison baseline (Vormonat / Vorjahr) rides
  // on the layout blob per research §7 Q3 (no Prisma migration). Optional
  // so v1.4.15 clients that don't know the field can still PUT.
  comparisonBaseline: z.enum(COMPARISON_BASELINES).optional(),
  // v1.4.18 — per-chart overlay prefs (3 toggles per chart card).
  // Optional so older clients that don't know the field can still PUT;
  // the resolver coerces malformed values away from the layout blob.
  //
  // v1.4.25 — switched from `z.record(enum, …)` to `z.partialRecord(…)`
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
  // The inner object also documents `comparisonBaseline` and `rangePoints`
  // so the per-chart `<ChartOverlayControls>` popover (which calls
  // `/api/dashboard/chart-overlay-prefs`) and a full-layout PUT from
  // Settings → Dashboard can round-trip both fields. Without them Zod would
  // silently strip either per-chart choice on every Save click.
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
        rangePoints: z
          .union([z.literal(0), z.literal(7), z.literal(30), z.literal(90)])
          .optional(),
      }),
    )
    .optional(),
  // v1.27.7 — hero score rings (max 3, closed id set). Optional with the
  // same preserve-when-absent contract as `chartOverlayPrefs`; the resolver
  // dedupes on read/serialize, `.max()` bounds the wire length.
  selectedScoreRings: z
    .array(z.enum(SCORE_RING_IDS))
    .max(MAX_SELECTED_SCORE_RINGS)
    .optional(),
  // v1.27.27 — hero ring display order (health-score ring + selected score
  // rings). Optional with the same preserve-when-absent contract; the
  // resolver reconciles it against the selected set on read/serialize, so a
  // stale or over-long array is clamped rather than rejected. `.max()`
  // bounds the wire length (health-score + up to three score rings).
  heroRingOrder: z
    .array(z.enum(HERO_RING_IDS))
    .max(MAX_HERO_RING_ORDER)
    .optional(),
  // Today hero item visibility. Empty is an explicit all-off choice; omission
  // preserves the stored value for clients that predate this field.
  enabledHeroItemKinds: z
    .array(z.enum(PRIORITY_ITEM_KINDS))
    .max(PRIORITY_ITEM_KINDS.length)
    .optional(),
  // Hero primary content — what the dashboard hero card leads with:
  // "score" (default) or "reminders" (the worth-a-look rail promoted into
  // the hero slot). This widens the stored `dashboardWidgetsJson` shape
  // ADDITIVELY: the field is optional on the wire and omitted from storage
  // at the default, so the native client (which mirrors this blob) can
  // keep round-tripping layouts untouched until it learns the field.
  // Same preserve-when-absent contract as `comparisonBaseline`; the
  // resolver drops unknown stored values back to "score" on read.
  hero: z.enum(HERO_PRIMARY_CONTENTS).optional(),
  // v1.42 — whether the dashboard shows its top card. Same additive,
  // preserve-when-absent contract as `hero`; the default (shown) is omitted
  // from storage.
  todayCardVisible: z.boolean().optional(),
  // v1.32.16 (issue #581) — the optimistic-concurrency base token used to
  // live here. v1.32.21 (R5a) moved it to the shared `takeBaseToken` helper,
  // which strips it BEFORE this parse: the token is transport, not a layout
  // field, and pulling it pre-Zod keeps the domain schema pure.
});

export const GET = apiHandler(async () => {
  // Read: the RECORD's layout. Write: refused — see the PUT and DELETE below.
  //
  // The split is the whole decision, and the read half is settled by a fact
  // rather than by taste: the dashboard SNAPSHOT already carries this layout
  // in its `layout` field, the client seeds `queryKeys.dashboardWidgets()`
  // from it, and the snapshot is a record read. Two writers, one cache cell.
  // If this route answered with the caller's own layout, that cell would hold
  // the owner's arrangement one moment and the delegate's the next, which is
  // the same-key-different-content poisoning the query-key factory exists to
  // prevent — and it would decide which of the owner's tiles get rendered.
  //
  // The layout is also a statement about the record and not only about a
  // person: which of THIS record's signals are worth a tile, which hero items
  // matter, which comparison baseline reads correctly for it. A delegate
  // opening somebody's dashboard should see it arranged the way its owner
  // arranged it.
  const { user } = await requireRecordAuth("read", "record");

  // 5-minute TTL per blueprint §5; the layout changes only when the user
  // hits the Settings → Dashboard save button, which invalidates this
  // cache via `invalidateUserDashboardWidgets()`. Keyed on the resolved id, so
  // a delegated read fills the owner's cell and never their own.
  const layout = await cached(
    caches.dashboardWidgets as ServerCache<DashboardLayoutWithToken>,
    user.id,
    () => buildDashboardLayout(user.id),
    annotate,
  );

  // Outside the cached layout on purpose; see `resolveUnavailableWidgetIds`.
  const unavailable = await resolveUnavailableWidgetIds(user.id);
  return apiSuccess(
    unavailable.length > 0
      ? { ...layout, unavailableWidgetIds: unavailable }
      : layout,
  );
});

export const PUT = apiHandler(async (request: NextRequest) => {
  // Bare on purpose: this refuses while a switch is on, and the GET above does
  // not. `requireRecordAuth` escalates every non-safe method to `"write"`, so
  // declaring the module once would have handed any WRITE-capable grant the
  // power to rearrange the owner's dashboard — and a delegate's job is to add
  // to a record, never to redecorate somebody else's app. Nothing a caregiver
  // needs to do requires moving another person's tiles.
  //
  // The visible cost is the comparison-baseline toggle on the dashboard hero,
  // which persists through here and therefore 403s under a switch. That is the
  // right refusal: the baseline is stored on the owner's row and a delegate
  // flipping it would change what the owner sees on their own next visit.
  const { user } = await requireAuth();

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 256 * 1024,
  });
  if (jsonError) return jsonError;

  // v1.32.21 — pull the optimistic-concurrency base token off the body
  // BEFORE anything else touches it (issue #581). A malformed token 422s
  // without a write; an absent token takes the unconditional backward-compat
  // arm inside `guardedUserUpdate` below.
  const taken = takeBaseToken(rawBody);
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;
  const body = taken.rest;

  // Ids outside the catalogue are dropped before Zod (a retired tile must
  // not 422 the whole blob).
  dropUnknownWidgetIds(body);

  const parsed = layoutSchema.safeParse(body);
  if (!parsed.success) {
    reportLayoutValidationFailure(body, parsed.error);
    // No audit row: this write resolves the caller (`requireAuth`), so the
    // refusal can only ever be the caller's own, which is telemetry and
    // lives on the wide event above. Only a delegate's refused attempt is
    // filed (see `isRejectedAttemptAction` in `src/lib/auth/audit.ts`).
    return returnAllZodIssues(parsed.error, 422);
  }

  // Omitted fields are carried forward from the stored layout. The Zod shape
  // leaves per-chart `comparisonBaseline` optional while `ChartOverlayPrefs`
  // requires it; `coerceChartOverlayPrefsMap` inside the serializer fills
  // that gap, so the assertion is safe. The concurrency token was split off
  // pre-Zod, so `parsed.data` can never leak it into the stored blob.
  const normalized = await layoutToStore(
    user.id,
    parsed.data as Partial<DashboardLayout>,
  );

  // Optimistic concurrency through the shared `guardedUserUpdate` helper.
  // When a client sends the `baseUpdatedAt` token it read with the layout, the
  // write succeeds only while the stored row still carries that token. A stale
  // base returns 409 without writing. Clients that omit the token keep the
  // legacy unconditional write.
  const guarded = await guardedUserUpdate({
    userId: user.id,
    base,
    data: { dashboardWidgetsJson: toJson(normalized) },
    conflict: {
      action: "dashboard.widgets.conflict",
      errorCode: "dashboard_layout_conflict",
      message: "Dashboard layout changed since it was loaded",
    },
  });
  if ("conflict" in guarded) return guarded.conflict;
  const freshUpdatedAt = guarded.updatedAt;

  annotate({
    action: { name: "dashboard.widgets.update" },
    meta: { visible_count: normalized.widgets.filter((w) => w.visible).length },
  });

  // v1.4.34 — bust the per-user dashboard-widgets cache so the
  // next dashboard mount paints the new layout.
  invalidateUserDashboardWidgets(user.id);

  // Echo the advanced token so the client can base its next write on it.
  return apiSuccess({
    ...normalized,
    updatedAt: freshUpdatedAt,
  } satisfies DashboardLayoutWithToken);
});

export const DELETE = apiHandler(async () => {
  // Bare, for the reason spelled out on the PUT: resetting somebody else's
  // dashboard to defaults is the loudest possible version of redecorating it.
  const { user } = await requireAuth();

  const { normalized, updatedAt } = await resetDashboardLayout(user.id);

  annotate({ action: { name: "dashboard.widgets.reset" } });

  // v1.4.34 — bust the per-user dashboard-widgets cache so the
  // next dashboard mount paints the reset (default) layout.
  invalidateUserDashboardWidgets(user.id);

  return apiSuccess({
    ...resolveDashboardLayout(normalized),
    updatedAt,
  } satisfies DashboardLayoutWithToken);
});
