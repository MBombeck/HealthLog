/**
 * GET / PUT / DELETE dashboard widget layout.
 *
 * GET returns the resolved effective layout (defaults merged in if the user
 * hasn't customized yet). PUT replaces the supplied layout fields atomically.
 * DELETE resets web-controlled choices and preserves the other preferences.
 */
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  buildPayloadDiagnostic,
  safeJson,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { unavailableWidgetIds } from "@/lib/dashboard/widget-modules";
import { prisma, toJson } from "@/lib/db";
import {
  takeBaseToken,
  guardedUserUpdate,
  invalidBaseTokenError,
} from "@/lib/optimistic-lock";
import {
  resolveDashboardLayout,
  serializeDashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  COMPARISON_BASELINES,
  CHART_OVERLAY_KEYS,
  SCORE_RING_IDS,
  MAX_SELECTED_SCORE_RINGS,
  HERO_RING_IDS,
  MAX_HERO_RING_ORDER,
  HERO_PRIMARY_CONTENTS,
  layoutNeedsPreserveRead,
  mergePreservedLayoutFields,
  type DashboardLayout,
  type DashboardLayoutWithToken,
} from "@/lib/dashboard-layout";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";
import { z } from "zod/v4";
import { invalidateUserDashboardWidgets } from "@/lib/cache/invalidate";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { redactForExcerpt } from "@/lib/observability/redact-payload";
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
    .max(50)
    // v1.11.2 B5 — raised to 40 so the full catalogue PUT (24 writable +
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

async function buildDashboardLayout(
  userId: string,
): Promise<DashboardLayoutWithToken> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    // v1.32.16 (issue #581) — `updatedAt` rides the cached layout so GET
    // hands the client the optimistic-concurrency token alongside the
    // layout it applies to. Cached together (and busted on every write)
    // so the (layout, token) pair a client reads is always consistent.
    select: { dashboardWidgetsJson: true, updatedAt: true },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  return { ...layout, updatedAt: row?.updatedAt?.toISOString() };
}

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

  // Which toggles cannot do anything for this account. Resolved here, on
  // the server, so the Settings screen never has to fetch dashboard data
  // to find out whether a switch it is about to draw is dead.
  //
  // Deliberately OUTSIDE the cached layout above: the layout cell is keyed
  // on the user and holds their arrangement, which does not change when a
  // module is toggled. Folding a module-dependent answer into it would
  // serve a stale one for the rest of the 5-minute TTL — the switch would
  // linger for minutes after Recovery went off, which is the confusion this
  // is removing.
  //
  // The SDNN probe is an index-only existence check
  // (`@@index([userId, type, measuredAt])`), not a summaries read; it runs
  // only when Recovery is off, so the common account pays nothing.
  // One flag, read the way this codebase reads one flag — not the whole
  // module map. `hrv` is the only conditionally-dead widget and `recovery`
  // is the only module that decides it.
  const recoveryEnabled = await isModuleEnabled(user.id, "recovery");
  let hasSdnn = true;
  if (!recoveryEnabled) {
    const sdnnRow = await prisma.measurement.findFirst({
      where: { userId: user.id, type: "HEART_RATE_VARIABILITY" },
      select: { id: true },
    });
    hasSdnn = sdnnRow !== null;
  }
  const unavailable = unavailableWidgetIds(
    { recovery: recoveryEnabled },
    { hasSdnn },
  );
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

  // v1.32.21 (R5a) — pull the optimistic-concurrency base token off the body
  // BEFORE anything else touches it (issue #581). A malformed token 422s
  // without a write; an absent token takes the unconditional backward-compat
  // arm inside `guardedUserUpdate` below.
  const taken = takeBaseToken(rawBody);
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;
  const body = taken.rest;

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
        (id): id is string => typeof id === "string" && !knownWidgetIds.has(id),
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
    // body is routed through `redactForExcerpt` first so any
    // future field matching the denylist (password / token / secret /
    // apiKey / authorization / csrfState / nonce) lands as the literal
    // `"[redacted]"` instead of its raw value.
    const payloadDiagnostic = buildPayloadDiagnostic(redactForExcerpt(body));
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

  // Preserve every omitted client-owned field from the stored layout instead
  // of clamping it to a default. The disposition map is exhaustive over
  // `DashboardLayout`, so adding a field requires an explicit merge decision.
  // One stored-layout read covers every fallback. The read is skipped only
  // when the client supplied every preserved field and every supplied chart
  // preference has rangePoints.
  //
  // The Zod shape leaves per-chart `comparisonBaseline` optional while
  // `ChartOverlayPrefs` requires it. `coerceChartOverlayPrefsMap` inside the
  // serializer fills that gap, so the assertion below is safe.
  // v1.32.16 (issue #581) — the concurrency token was already split off the
  // body pre-Zod (`takeBaseToken`), so `parsed.data` is pure layout and can
  // never leak the token into the stored blob.
  let toSerialize = parsed.data as Partial<DashboardLayout>;
  const incomingChartOverlayPrefs = toSerialize.chartOverlayPrefs;
  const needsRangePointsPreserve =
    incomingChartOverlayPrefs !== undefined &&
    CHART_OVERLAY_KEYS.some((chartKey) => {
      const prefs = incomingChartOverlayPrefs[chartKey];
      return prefs !== undefined && prefs.rangePoints === undefined;
    });
  const needsPreserveRead =
    layoutNeedsPreserveRead(toSerialize) || needsRangePointsPreserve;
  if (needsPreserveRead) {
    const existing = await prisma.user.findUnique({
      where: { id: user.id },
      select: { dashboardWidgetsJson: true },
    });
    const existingLayout = resolveDashboardLayout(
      existing?.dashboardWidgetsJson,
    );
    toSerialize = mergePreservedLayoutFields(toSerialize, existingLayout);

    if (needsRangePointsPreserve && toSerialize.chartOverlayPrefs) {
      let mergedChartOverlayPrefs = toSerialize.chartOverlayPrefs;
      for (const chartKey of CHART_OVERLAY_KEYS) {
        const incomingPrefs = toSerialize.chartOverlayPrefs[chartKey];
        const storedRangePoints =
          existingLayout.chartOverlayPrefs?.[chartKey]?.rangePoints;
        if (
          incomingPrefs !== undefined &&
          incomingPrefs.rangePoints === undefined &&
          storedRangePoints !== undefined
        ) {
          if (mergedChartOverlayPrefs === toSerialize.chartOverlayPrefs) {
            mergedChartOverlayPrefs = { ...toSerialize.chartOverlayPrefs };
          }
          mergedChartOverlayPrefs[chartKey] = {
            ...incomingPrefs,
            rangePoints: storedRangePoints,
          };
        }
      }
      toSerialize = {
        ...toSerialize,
        chartOverlayPrefs: mergedChartOverlayPrefs,
      };
    }
  }
  const normalized = serializeDashboardLayout(toSerialize as DashboardLayout);

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

  // v1.4.34 IW-G — bust the per-user dashboard-widgets cache so the
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

  // Under a row lock rather than Serializable isolation: a reset racing a
  // chart-overlay toggle on the same account waits for it instead of
  // failing with a serialization error (a 500).
  const { normalized, updatedAt } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
    const existing = await tx.user.findUnique({
      where: { id: user.id },
      select: { dashboardWidgetsJson: true },
    });
    const existingLayout = resolveDashboardLayout(
      existing?.dashboardWidgetsJson,
    );
    const normalized = serializeDashboardLayout({
      ...existingLayout,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
      enabledHeroItemKinds: DEFAULT_DASHBOARD_LAYOUT.enabledHeroItemKinds,
      // A reset brings a hidden top card back.
      todayCardVisible: DEFAULT_DASHBOARD_LAYOUT.todayCardVisible,
    });

    const updated = await tx.user.update({
      where: { id: user.id },
      data: { dashboardWidgetsJson: toJson(normalized) },
      select: { updatedAt: true },
    });
    return { normalized, updatedAt: updated.updatedAt.toISOString() };
  });

  annotate({ action: { name: "dashboard.widgets.reset" } });

  // v1.4.34 IW-G — bust the per-user dashboard-widgets cache so the
  // next dashboard mount paints the reset (default) layout.
  invalidateUserDashboardWidgets(user.id);

  return apiSuccess({
    ...resolveDashboardLayout(normalized),
    updatedAt,
  } satisfies DashboardLayoutWithToken);
});
