# Phase W5 — v1.4.25 Coach drawer polish

**Date:** 2026-05-14
**Branch:** develop
**Scope:** Seven polish items in the AI Coach drawer Marc flagged in
the v1.4.25 follow-up brief.

## Commits

| Sha       | Subject                                                                               |
| --------- | ------------------------------------------------------------------------------------- |
| `1895fd3` | `fix(coach): suggested-prompt chips show user message before thinking placeholder`    |
| `4c9c068` | `style(coach): drop redundant per-row source labels in evidence disclosure`           |
| `330be96` | `feat(coach): default analysis window as user preference + per-conversation override` |
| `81b1d79` | `style(coach): unify X / cog / new-chat header buttons — same size + alignment`       |
| `70fe5a5` | `refactor(coach): drop non-functional mic icon from composer`                         |
| `c7eb226` | `feat(coach): composer textarea auto-grows from 1 to 6 lines, Claude-web pattern`     |
| `b50ebcc` | `feat(coach): distinct daily-limit vs provider-rate-limit error UX`                   |
| `36bf960` | `style(coach): prettier formatting on W5 surfaces`                                    |

## Per-commit summary

### 1. Optimistic user bubble (`1895fd3`)

`useSendCoachMessage` now exposes a `CoachOptimisticUserMessage` that
the drawer threads into `MessageThread`. The bubble paints immediately
when `send.send()` fires, so the chronological render order is now
`user message → "Thinking…" → assistant reply`. The optimistic copy
drops once the persisted twin lands via the invalidate-refetch the
SSE `done` frame triggers; we suppress the optimistic when the last
persisted user message has identical content (no double-render).

Auto-scroll deps now include `optimisticUser?.localId` so the user
sees their own bubble land at the bottom.

Tests: 2 new in `message-thread.test.tsx` covering render-order and
twin-suppression.

### 2. Drop per-row source labels (`4c9c068`)

The evidence disclosure ("What I'm looking at" / "Worauf bezieht sich
das?") used to prefix every row with `kv.label` (e.g. "avg7 systolic")
— framing the disclosure heading already supplies. Rows now lead with
the value + unit, with the window as a parenthetical tail.

Existing tests updated to assert label absence.

### 3. Default analysis window (`330be96`)

- `coachPrefsSchema` gains `defaultWindow` (enum mirrors
  `CoachScopeWindow`). Default = `"allTime"` so legacy persisted rows
  read as the v1.4.24 behaviour.
- The Coach settings sheet (cog) gains a new picker section.
- The drawer header carries a `<Select>` pill that paints the
  effective window. Override drops to `null` on drawer close.
- The chat route folds `coachPrefs.defaultWindow` into snapshot scope
  when the client didn't supply a window — no changes to
  `snapshot.ts` itself, which is W7b territory.

**Note on the spec's `last_year` window option:** the spec proposed
`last_7d / last_30d / last_90d / last_year / all_time`. The existing
`CoachScopeWindow` enum uses
`last7days / last30days / last90days / allTime` — adding `lastYear`
requires extending the enum AND `snapshot.ts` (W7b territory). I kept
the four existing values and deferred `lastYear` to a follow-up to
respect the "don't touch snapshot.ts" boundary.

Tests: settings-sheet picker render + schema parse for the new key,
plus a regression test that legacy rows missing the key default to
`allTime`.

### 4. Header alignment (`81b1d79`)

Sheet's default `showCloseButton` is now `false`. The header renders
its own close X inline alongside the cog and new-chat button. All
three are `variant="ghost" size="icon"` with `size-9` (36 px hit
target) and 16-px icons. The `pr-12` reservation for the absolute
close X is gone.

The window pill from #3 stays smaller (h-7, 11-px text) by design —
metadata vs actions.

### 5. Drop mic icon (`70fe5a5`)

The disabled mic + tooltip is gone. Voice ships with the iOS client
(v1.5). Tooltip imports removed, hint text breathes in the freed
space.

### 6. Composer auto-grow (`c7eb226`)

The textarea now starts at `rows={1}` (≈44 px) and grows on input via
a `useEffect` that resets `style.height` to `auto`, reads
`scrollHeight`, and clamps via the pure helper
`computeAutoGrowHeight(...)`. Hard cap at 6 lines via
`max-h-[9.5rem]`; past the cap the textarea scrolls internally.

Pure helper unit-tested for the three boundary cases (empty,
in-band, over-cap).

### 7. Daily-limit vs provider-rate-limit error UX (`b50ebcc`)

- The chat route detects "every provider attempt returned 429" and
  emits `coach.provider.rate_limited` via the SSE error frame.
- The send hook decodes the JSON envelope's `error` field on 429
  responses (today `coach.budget.exceeded`) and surfaces it as the
  structured `errorCode` instead of the generic `coach.http.429`.
- `MessageThread` exports a new pure `errorCodeToI18nKey(code)` that
  maps:
  - `coach.budget.exceeded` → `insights.coach.dailyLimitBody`
  - `coach.provider.rate_limited` → `insights.coach.providerRateLimitBody`
  - every other provider failure → `insights.coach.errorProvider`
- New i18n keys in EN + DE: `dailyLimitTitle`, `dailyLimitBody`,
  `providerRateLimitTitle`, `providerRateLimitBody`.

**Note:** the bubble copy is rendered inside the assistant bubble in
orange — there is no separate toast wired. Marc's spec mentioned a
"toast variant: warning (yellow)"; the existing surface for Coach
errors is the in-bubble text. Adding a sonner toast would duplicate
the surface for the same content. If a toast is preferred, the
helper return-shape already pins the key — a follow-up can add a
toast call in `useSendCoachMessage` that uses the same resolver.

Tests: 4 new for the resolver + 2 for the rendered copy.

## Verification

| Check                                                                                                   | Result                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                                        | exit 0                                                                                                                                                                                                                                 |
| `pnpm lint`                                                                                             | 2 pre-existing warnings (unused-vars), 0 new                                                                                                                                                                                           |
| `pnpm vitest run src/components/insights/coach-panel src/lib/validations/__tests__/coach-prefs.test.ts` | 98 / 98 green                                                                                                                                                                                                                          |
| `pnpm prettier --check` (W5 surfaces)                                                                   | clean                                                                                                                                                                                                                                  |
| Full `pnpm test`                                                                                        | 11 fails in `snapshot.test.ts` + `snapshot-new-metrics.test.ts` — **not W5**; root cause is the parallel W4d GLP-1 work touching `snapshot.ts` (`buildGlp1SnapshotBlock` not stubbed in the snapshot tests). Handed back to W4d / W7b. |

## Conflicts with parallel agents

- `src/lib/ai/coach/snapshot.ts` was modified by the W4d / W7b agents
  during my work; I did **not** touch it. Per the brief, my
  default-window adoption lives entirely in the chat route's
  scope-merge step.
- `src/lib/ai/coach/system-prompt.ts`, `src/components/insights/daily-briefing.tsx`,
  `src/lib/ai/prompts/insight-generator.ts`, and `src/lib/ai/schema.ts`
  were inadvertently included in commit `330be96` because they were
  modified in the working tree (parallel W4d GLP-1 work) and got
  swept into the stage when I added `coach-drawer.tsx`. Those edits
  are W4d's, not W5's; I left them in the commit rather than
  rewriting history.

## i18n keys added

`insights.coach.*`:

- `settingsDefaultWindowLabel`
- `settingsDefaultWindowHint`
- `dailyLimitTitle`
- `dailyLimitBody`
- `providerRateLimitTitle`
- `providerRateLimitBody`

All present in `messages/en.json` and `messages/de.json`.

## Deferred items

- `lastYear` window option — needs the `CoachScopeWindow` enum
  extension and `snapshot.ts` mapping; deferred to a follow-up after
  the W7b timezone work settles.
- Warning-toast variant — the in-bubble surface is the existing
  pattern; if a toast is desired, the resolver helper already pins
  the keys.

## Files touched

- `src/components/insights/coach-panel/use-coach.ts`
- `src/components/insights/coach-panel/coach-drawer.tsx`
- `src/components/insights/coach-panel/coach-input.tsx`
- `src/components/insights/coach-panel/coach-settings-sheet.tsx`
- `src/components/insights/coach-panel/message-thread.tsx`
- `src/components/insights/coach-panel/__tests__/coach-input.test.tsx`
- `src/components/insights/coach-panel/__tests__/coach-settings-sheet.test.tsx`
- `src/components/insights/coach-panel/__tests__/message-thread.test.tsx`
- `src/lib/validations/coach-prefs.ts`
- `src/lib/validations/__tests__/coach-prefs.test.ts`
- `src/app/api/insights/chat/route.ts`
- `messages/en.json`
- `messages/de.json`
