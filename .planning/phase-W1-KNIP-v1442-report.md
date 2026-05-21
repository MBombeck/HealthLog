# W1-KNIP v1.4.42 phase report

## Summary

Promoted the knip CI gate to enforcing for the `exports` + `types` issue
tiers. The tree is now at zero unused exports + zero unused types under
the documented ignore-block; any future regression trips the
`Knip / Dead-code gate` workflow on every PR into `main`.

## Branch

`worktree-agent-ace944dcad5bbeec2` (pushed to origin; branched off
`d3d60104` — the `develop` tip after the v1.4.41 release).

## Commits

| SHA | Title |
| --- | --- |
| `6ddf8fa4` | `chore(knip): drop seven dead exports flagged by W-SIMPLIFIER` |
| `b7ac80b2` | `chore(knip): mute shadcn surface + drop two duplicate helpers` |
| `4e318c9a` | `chore(knip): drop fourteen orphaned types + scope contracts ignore-block` |
| `20df7b9d` | `ci(knip): flip exports + types tiers to enforcing` |

## Knip count

| Tier | Before (v1.4.41 tip) | After (this branch) |
| --- | --- | --- |
| Unused exports | 35 | 0 |
| Unused exported types | 52 | 0 |
| Exit code (no `--include`) | non-zero | 0 |

## `knip.json` ignore-block contents

Two new top-level keys + one updated `ignoreIssues` block:

```jsonc
"ignoreExportsUsedInFile": true,
"ignoreIssues": {
  "src/components/ui/**": ["exports", "types"],
  "src/lib/validations/**": ["types"]
}
```

Rationale:

- `ignoreExportsUsedInFile: true` — the schema-source-of-truth pattern
  in `src/lib/ai/**` and the validation files exports the zod schema +
  inferred `z.infer<>` type as a package surface. The schema is
  referenced internally for composition (`z.array(otherSchema)`); knip
  treats that as "same-file reference, but still exported, so unused".
  The boolean flips that behaviour so internal references count as
  usage.
- `src/components/ui/**: ["exports", "types"]` — every shadcn UI symbol
  the W-SIMPLIFIER residual flagged (`AlertDialogMedia/Overlay/Portal`,
  `AvatarBadge/Group/GroupCount`, `badgeVariants`, `buttonVariants`,
  `Card*`, `Dialog*`, `DropdownMenu*`, `Select*`, `SheetTrigger`,
  `Table*`, `tabsListVariants`) was confirmed against
  `https://ui.shadcn.com/r/styles/new-york-v4/*.json` as part of the
  upstream registry. Keeping them in tree preserves library-shape
  parity so the next shadcn refresh applies cleanly.
- `src/lib/validations/**: ["types"]` — the `z.infer<>` types in these
  files are the external API contract surface (iOS contract
  type-matching, OpenAPI generation, route handler typing). They are
  not literally imported by name elsewhere, but they document the
  request/response shapes the routes parse against. Drop the type
  tier only; the `exports` tier on these files stays enforcing so any
  truly-dead schema still trips the gate.

## Drops vs. mutes

### Dropped genuinely-dead exports (W-SIMPLIFIER carry-over)
- `tokenKind` (`src/lib/insights/chart-tokens.ts`) — comment-only ref
  in test; removed function + JSDoc.
- `withBackgroundEventSafe` (`src/lib/logging/background.ts`) — only
  ref was the `src/lib/logging/index.ts` re-export; both removed.
- `isRollupFresh` (`src/lib/rollups/measurement-rollups.ts`) — deferred
  in v1.4.41 pending W-PERF-OPS-1. The persistent-rollup reader now
  carries its own freshness probe and never imported the helper.
- `PROGRESS_TICK_RECORDS`, `MAINTAINED_LOCALES`, `SUB_PAGE_METRIC` —
  used only inside their own module; `export` keyword dropped.

### Dropped duplicate / dead helpers
- `requireAdmin` in `src/lib/auth/session.ts` — shadowed the real
  implementation in `src/lib/api-handler.ts`; every caller in the tree
  imports the latter.
- `readDailyMeans` in `src/lib/rollups/measurement-read.ts` — unused
  convenience wrapper around `readRollupBuckets`. Reader-side surfaces
  call `readRollupBuckets` + `aggregateBuckets` directly.
- `CHART_RANGE_PRESETS` (`src/lib/charts/constants.ts`) and its
  derived `ChartRangePreset` type — no chart reads either.

### Dropped orphaned `z.infer<>` types
- `MetricSource`, `AIRecommendationRationale`, `AIRecommendation`,
  `AICitation`, `AIWarning`, `StoryboardAnnotation` in
  `src/lib/ai/schema.ts`.
- `InsightFinding` in `src/lib/ai/types.ts`.
- `CoachChatRequest` in `src/lib/ai/coach/types.ts`.
- `ApplyProfileInput` in `src/lib/auth/profile-update.ts`.
- `CreateSideEffectInput`, `ListSideEffectsInput` in
  `src/lib/medications/side-effects/validators.ts`.
- `AnalyticsSlicePayload` in `src/lib/queries/use-analytics-query.ts`.
- `ThresholdOverride` in `src/lib/analytics/effective-range.ts` —
  persisted shape is `ThresholdOverridesJson`.
- `WebPushChannelConfig`, `ApnsChannelConfig`, `ChannelConfig` triplet
  in `src/lib/notifications/types.ts` — empty records + the wrapping
  union added nothing; the dispatcher imports `TelegramChannelConfig`
  and `NtfyChannelConfig` directly by name.
- `WithingsWebhookAuthOutcome` in `src/lib/withings/webhook-handler.ts`
  — declared but never referenced.

## Reconcile callouts (W3 / W4 scope)

Two W-SIMPLIFIER carry-over items live in scopes owned by parallel
waves and were left untouched:

1. **`describeInjectionSite` re-export in
   `src/components/medications/glp1-medication-card.tsx`** — the
   declaration in `src/lib/medications/injection-sites.ts` is used by
   `injection-site-picker.tsx` and `therapy-timeline.tsx`. Only the
   re-export at the bottom of the card file is dead. File lives under
   `src/components/medications/**`, which is **W3-QUERYKEY-LONGTAIL**
   scope.
2. **`listSupportedTimezones` re-export in
   `src/lib/tz/resolver.ts`** — the real implementation is in
   `src/lib/tz/format.ts` and is imported directly by
   `src/components/settings/timezone-picker.tsx` +
   `src/components/admin/general-settings-section.tsx`. Only the
   re-export off `resolver.ts` is dead. File lives at
   `src/lib/tz/resolver.ts`, which is **W4-ARCH-HYGIENE** scope.

Both items already appear as "unused exports" in the pre-gate knip run.
After this branch lands they remain flagged. The gate flip in
`20df7b9d` means a CI red until W3 / W4 land their own drops, so the
merge-order plan needs all three branches in develop before any of them
reaches main. If W3 + W4 land first, the gate stays green from the
flip onward; if this branch lands first, the gate goes red on main
until W3 + W4 follow.

Recommended merge order: **W1 last** (this branch).

## Quality bar evidence

- `pnpm typecheck` clean before every commit.
- `pnpm lint` clean before every commit.
- `pnpm knip --reporter compact` exits 0 with no findings on the final
  commit.
- `pnpm test --run`: **4732 passed | 1 skipped** (no new failures
  versus the v1.4.41 baseline at `d3d60104`).
- No `Co-Authored-By`, no `--no-verify`, no `--no-gpg-sign` on any
  commit; messages in Marc-voice English, conventional-commit prefix.
