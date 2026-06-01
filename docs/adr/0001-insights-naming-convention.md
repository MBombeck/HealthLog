# 0001 — Insights naming convention: localised UI, English identifiers

- Status: accepted
- Date: 2026-05-31

## Context

The Insights surface grew bilingually. The mother page (`/insights`) and its
routed metric sub-pages were keyed by German slugs (`/insights/blutdruck`,
`/insights/gewicht`, …) because German was the primary author voice when the
routed strip first shipped. Over time the surface accumulated a mix: route
folders, the tile-layout enum, and several internal maps were German, while
later additions (`hrv`, `oxygenSaturation`, `restingHr`, `activeEnergy`,
`workouts`) landed in English. The result was an inconsistent identifier space
where a contributor could not predict whether a given key was German or English.

Identifiers leak. A German route slug shows up in URLs, in browser history, in
the OpenAPI contract the iOS client reads, and in every internal map that pivots
on the slug. Mixed-language identifiers make the codebase harder to navigate and
make the public API contract read inconsistently.

Two surfaces also speak these identifiers across a boundary we do not control:

1. **URLs** — bookmarked and cached by the PWA.
2. **The tile-layout contract** — `GET/PUT /api/insights/layout`, which the
   native iOS client persists against. The tile ids in that payload are a
   client-visible contract.

## Decision

Separate the two naming axes cleanly:

- **UI copy is always localised.** Every visible string resolves through an
  i18n `t()` key and is translated across all six locales (`de / en / es / fr /
  it / pl`). The user never sees a raw identifier.
- **Internal identifiers are English.** Route slugs (`/insights/<slug>`), the
  tile-layout enum (`INSIGHTS_TILE_IDS`), query keys, and the internal
  slug→metric / slug→target maps all use established English terms. English is
  the lingua franca of the codebase and of the public API contract.

Concretely, v1.8.0 migrates the routed Insights slugs and the tile-layout enum
from German to English (e.g. `blutdruck` → `blood-pressure`, `gewicht` →
`weight`, `medikamente` → `medications`). The full rename table lives in
`src/lib/insights/sub-page-metric.ts` (slugs) and `src/lib/insights-layout.ts`
(tile ids).

## Non-breaking strategy

The migration must not break either client-visible boundary:

- **URLs.** `next.config.ts` `redirects()` emits a `permanent: true` (301)
  redirect from every legacy German slug to its English target, including a
  `:path*` variant so any nested route survives. Bookmarks and cached PWA
  navigation keep resolving.
- **Tile-layout contract.** The layout endpoint keeps **accepting** the legacy
  German tile ids on input. The Zod enum is built from
  `ACCEPTED_INSIGHTS_TILE_IDS` (canonical English ids *plus* the legacy German
  aliases), so a `PUT` carrying old ids validates rather than tripping a 422.
  `normalizeInsightsTileId` collapses each legacy id onto its canonical English
  replacement; this normalisation runs on **both** the read path
  (`resolveInsightsLayout`) and the write path (`serializeInsightsLayout`), so:
  - a layout persisted by a `≤ v1.7.x` client surfaces canonical English ids on
    `GET` without forcing a re-`PUT`;
  - a `PUT` sending legacy ids persists canonical English ids;
  - a layout that carries both a legacy and a canonical id for one tile dedupes
    to a single canonical entry.

  The legacy ids are accepted-but-deprecated. They will be removed from the
  accepted set in a future major version once telemetry shows clients have
  migrated. The OpenAPI `InsightsLayoutBody` schema documents the canonical ids,
  the accepted legacy ids, and the deprecation.

## Consequences

- The Insights identifier space is uniformly English and predictable.
- No client breaks on upgrade: old URLs redirect, old tile ids normalise.
- The legacy-alias map and the redirect table are deliberate, finite debt to be
  retired in a future major. Until then they are covered by tests
  (`src/app/api/insights/layout/__tests__/route.test.ts`) that assert the
  non-breaking round-trip.
- New Insights surfaces follow the convention from the start: English slug,
  English tile id, localised `t()` copy.
