/**
 * Insights tile layout — persisted in `User.insightsLayoutJson`.
 *
 * Single source of truth for which insights pills show on `/insights`,
 * what order they render in, and what the default layout is for new
 * users. Null / missing column = default layout below; the GET endpoint
 * never lazy-writes a row, so the column only carries data once the
 * user has explicitly saved a layout.
 *
 * Mirrors `dashboard-layout.ts` for the dashboard widget surface — same
 * resolver / serializer semantics, same auto-merge of new tile IDs
 * introduced in later releases. Keeping the two modules structurally
 * identical means the iOS client + the Settings UI can share rendering
 * code paths against either surface.
 */

/**
 * Every insights tile the layout knows about. Each entry maps to a
 * routed sub-page under `/insights/<slug>` (the mother-page overview
 * is keyed `"overview"`). The order of entries here is irrelevant —
 * `DEFAULT_INSIGHTS_LAYOUT.tiles[].order` drives the visual order.
 * Exported so the API Zod `tileIdEnum` can be built from a single
 * source of truth.
 *
 * v1.8.0 — the canonical ids are English, matching the routed slugs
 * (`/insights/<slug>`) and the naming-convention ADR
 * (`docs/adr/0001-insights-naming-convention.md`). The ids were German
 * through v1.7.x and the iOS layout-sync contract
 * (`GET/PUT /api/insights/layout`) speaks them, so the layout endpoint
 * keeps ACCEPTING the legacy German ids and NORMALISES them to the
 * canonical English ones on both read and write — see
 * `LEGACY_INSIGHTS_TILE_ID_ALIASES` + `normalizeInsightsTileId` below.
 * No client breaks; iOS migrates to the English ids at its own pace.
 */
export const INSIGHTS_TILE_IDS = [
  "overview",
  // ── vitals ──
  "blood-pressure",
  "pulse",
  "oxygen",
  "body-temperature",
  // ── body composition ──
  "weight",
  "bmi",
  // ── activity ──
  "active-energy",
  "workouts",
  // ── sleep ──
  "sleep",
  // ── cardiovascular ──
  "resting-pulse",
  "hrv",
  // ── mood ──
  "mood",
  // ── events ──
  "medications",
] as const;

export type InsightsTileId = (typeof INSIGHTS_TILE_IDS)[number];

/**
 * Legacy (≤ v1.7.x) German tile ids mapped to their canonical English
 * replacement. The layout endpoint accepts these as input so the iOS
 * client's stored layouts keep round-tripping after the v1.8.0 rename;
 * every write path normalises them away before persisting (see
 * `normalizeInsightsTileId`). `bmi`, `hrv`, `workouts`, and `overview`
 * were already language-neutral and need no alias.
 */
export const LEGACY_INSIGHTS_TILE_ID_ALIASES: Record<string, InsightsTileId> = {
  blutdruck: "blood-pressure",
  puls: "pulse",
  sauerstoff: "oxygen",
  koerpertemperatur: "body-temperature",
  gewicht: "weight",
  "aktive-energie": "active-energy",
  schlaf: "sleep",
  ruhepuls: "resting-pulse",
  stimmung: "mood",
  medikamente: "medications",
};

/**
 * Every id the layout endpoint accepts on input — canonical English
 * plus the legacy German aliases. The Zod `tileIdEnum` is built from
 * this union so a PUT carrying old ids passes validation rather than
 * tripping a 422; `normalizeInsightsTileId` collapses the union back to
 * the canonical id before anything persists.
 */
export const ACCEPTED_INSIGHTS_TILE_IDS = [
  ...INSIGHTS_TILE_IDS,
  ...Object.keys(LEGACY_INSIGHTS_TILE_ID_ALIASES),
] as const;

/**
 * Collapse a legacy German tile id onto its canonical English id.
 * Canonical ids (and unknown ids) pass through unchanged — the
 * resolver's known-id filter drops anything truly unrecognised.
 */
export function normalizeInsightsTileId(id: string): string {
  return LEGACY_INSIGHTS_TILE_ID_ALIASES[id] ?? id;
}

export interface InsightsTileConfig {
  id: InsightsTileId;
  visible: boolean;
  order: number;
}

export interface InsightsLayout {
  version: number;
  tiles: InsightsTileConfig[];
}

const INSIGHTS_LAYOUT_VERSION = 1;

/**
 * Default layout mirrors the routed tab-strip order — vitals first,
 * then body composition, activity, sleep, cardiovascular, mood, then
 * events. Core surfaces are default-visible; the long-tail HealthKit
 * pills (oxygen saturation, body temperature, active energy, sleep,
 * resting HR, HRV) stay default-invisible and the user opts in once
 * the matching data starts to flow. Adding a new tile lands as an
 * additional `{ id, visible: false, order: N }` row here and the
 * resolver auto-merges it onto existing users' saved layouts.
 */
export const DEFAULT_INSIGHTS_LAYOUT: InsightsLayout = {
  version: INSIGHTS_LAYOUT_VERSION,
  tiles: [
    { id: "overview", visible: true, order: 0 },
    { id: "blood-pressure", visible: true, order: 1 },
    { id: "pulse", visible: true, order: 2 },
    { id: "oxygen", visible: false, order: 3 },
    { id: "body-temperature", visible: false, order: 4 },
    { id: "weight", visible: true, order: 5 },
    { id: "bmi", visible: true, order: 6 },
    { id: "active-energy", visible: false, order: 7 },
    { id: "workouts", visible: true, order: 8 },
    { id: "sleep", visible: false, order: 9 },
    { id: "resting-pulse", visible: false, order: 10 },
    { id: "hrv", visible: false, order: 11 },
    { id: "mood", visible: true, order: 12 },
    { id: "medications", visible: true, order: 13 },
  ],
};

export function resolveInsightsLayout(raw: unknown): InsightsLayout {
  if (!raw || typeof raw !== "object") return DEFAULT_INSIGHTS_LAYOUT;
  const candidate = raw as Partial<InsightsLayout>;
  if (
    typeof candidate.version !== "number" ||
    !Array.isArray(candidate.tiles)
  ) {
    return DEFAULT_INSIGHTS_LAYOUT;
  }

  // v1.8.0 — normalise legacy German tile ids onto their canonical
  // English replacement BEFORE the known-id filter so a layout persisted
  // by a ≤ v1.7.x client (or the iOS app still speaking the old ids)
  // survives the read instead of being silently dropped as "unknown".
  // Dedupe afterwards: a layout carrying both the legacy and the
  // canonical id (e.g. a partial migration) keeps the first occurrence
  // so the round-trip stays idempotent.
  const knownIds = new Set<string>(INSIGHTS_TILE_IDS);
  const seen = new Set<string>();
  const filtered: InsightsTileConfig[] = candidate.tiles
    .map((t) => ({ ...t, id: normalizeInsightsTileId(t.id) }))
    .filter((t): t is InsightsTileConfig => {
      if (!knownIds.has(t.id) || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

  // Merge with defaults so new tiles introduced in later versions show
  // up automatically (invisible by default, the user opts in).
  const savedIds = new Set(filtered.map((t) => t.id));
  const missing = DEFAULT_INSIGHTS_LAYOUT.tiles.filter(
    (t) => !savedIds.has(t.id),
  );
  const maxOrder = Math.max(0, ...filtered.map((t) => t.order));
  const appended = missing.map((t, i) => ({
    ...t,
    visible: false, // default-invisible on auto-upgrade
    order: maxOrder + 1 + i,
  }));

  return {
    version: INSIGHTS_LAYOUT_VERSION,
    tiles: [...filtered, ...appended].sort((a, b) => a.order - b.order),
  };
}

/**
 * Input shape for {@link serializeInsightsLayout}. Looser than
 * {@link InsightsLayout}: the tile `id` is a bare `string` so the PUT
 * handler can hand a Zod-parsed body that still carries legacy German
 * aliases — `serializeInsightsLayout` normalises them onto canonical
 * {@link InsightsTileId} values on the way through.
 */
export interface InsightsLayoutInput {
  version: number;
  tiles: Array<{ id: string; visible: boolean; order: number }>;
}

export function serializeInsightsLayout(
  layout: InsightsLayoutInput,
): InsightsLayout {
  // v1.8.0 — normalise legacy German tile ids onto canonical English
  // before persisting so the stored blob is always canonical even when
  // the PUT body carried the old ids (the Zod enum accepts both via
  // `ACCEPTED_INSIGHTS_TILE_IDS`). Dedupe so a body sending both the
  // legacy and canonical id for one tile collapses to a single entry,
  // keeping the dense 0-based order contiguous.
  const seen = new Set<string>();
  return {
    version: INSIGHTS_LAYOUT_VERSION,
    tiles: layout.tiles
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((t) => ({ ...t, id: normalizeInsightsTileId(t.id) }))
      .filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      })
      .map((t, i) => ({
        id: t.id as InsightsTileId,
        visible: t.visible,
        order: i, // normalize to 0-based dense order
      })),
  };
}
