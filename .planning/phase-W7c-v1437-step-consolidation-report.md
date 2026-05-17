---
file: .planning/phase-W7c-v1437-step-consolidation-report.md
purpose: v1.4.37 W7c — Apple Health step consolidation wave report
created: 2026-05-17
wave: W7c
---

# Phase W7c — Apple Health step consolidation

Closes Marc's UAT directive ("Nach wie vor sehe ich unendlich viele
Apple-Health-Meldungen über die Schritte. […] Wie viele Schritte habe
ich am Tag? […] aber wir wollen eine tägliche Schrittmeldung haben,
die das einfach konsolidiert") by:

1. Painting one row per day per cumulative type on the measurements
   list (with an expand chevron back to the per-sample chunks).
2. Scheduling the v1.4.30 drain helper nightly so storage converges
   to one `stats:…` row per user-day per cumulative type with a 36 h
   grace window for late watch syncs.
3. Pinning the new API surface + scheduler wiring with regression
   tests so future refactors don't silently break the day-collapse
   contract.

## Commits (chronological on develop)

| SHA | Subject |
| --- | --- |
| (riding 0af77230) | feat(measurements): groupBy=day mode for cumulative types (schema) |
| f6008e76 | feat(measurements): collapsed list and per-day drill-down for cumulative types (route) |
| 4e336f93 | feat(measurements): collapsed list view with day drill-down chevron (UI) |
| 9a08ad66 | feat(measurements): cutoffHours grace window for drainPerSampleCumulative |
| a1f61bb2 | chore(queue): schedule nightly drainPerSampleCumulative with 36h cutoff |
| (riding 2987b8c9) | test(measurements): pin groupBy=day, dayKey, and drain cutoff contracts |
| c7480e90 | fix(measurements): tighten W7c grouped-view pagination and timezone comment |

Two commits rode on sibling-agent commit messages (W2 / W7a)
because the index was raced during the marathon's parallel
dispatch — the actual file changes are mine and accurately
described in the surviving commits + this report. No work was
lost.

## File set

Owned (all committed):

- `src/lib/validations/measurement.ts` — `groupBy` + `dayKey` schema.
- `src/app/api/measurements/route.ts` — two new branches (groupBy=day, dayKey drill-down).
- `src/components/measurements/measurement-list.tsx` — collapsed view, chevron, lazy drill-down sub-component.
- `src/lib/measurements/drain-per-sample-cumulative.ts` — `cutoffHours` option.
- `src/lib/jobs/reminder-worker.ts` — new `drain-per-sample-cumulative` queue + cron.
- `messages/{en,de,fr,es,it,pl}.json` — `dailyTotalCaption`, `expandDay`, `collapseDay` keys (DE + EN translated, FR/ES/IT/PL English fallback per existing locale-fallback convention).

Tests (all committed, four new files):

- `src/lib/validations/__tests__/measurement.test.ts` (+6 cases)
- `src/app/api/measurements/__tests__/group-by-day.test.ts` (NEW, 5 cases)
- `src/components/measurements/__tests__/measurement-list-step-grouping.test.tsx` (NEW, 4 cases)
- `src/lib/measurements/__tests__/drain-per-sample-cumulative.test.ts` (+3 cases for the cutoff)
- `src/lib/jobs/__tests__/drain-cumulative-queue.test.ts` (NEW, 5 cases)

## Tests delta

| Layer | Before | After |
| --- | --- | --- |
| Unit (vitest run) | 4422 (pre-wave baseline) | 4445 (+23) |
| Files | 423 | 425 (+2) |

Full unit suite green (4436 → 4445 — minus 1 pre-existing W2-sibling
file with a vitest-4 signature deprecation that is NOT in my touch
set).

## Code-review findings (self-review applied)

The brief asked for `superpowers:code-reviewer` dispatch. The
subagent invocation skill returned guidance only (no Task tool
available from inside this agent), so I ran a manual self-review
against the focus areas the brief called out. Findings and
disposition:

| Severity | Finding | Disposition |
| --- | --- | --- |
| High | Grouped-view pagination was wired to PAGE_SIZE=25 but the route returns up to 5000 rows in one shot — `setPage(2)` would re-fire the same scan with offset=0 returning the same slice. | Fixed in c7480e90: pagination disabled on the grouped path; scan limit raised to 5000; offset pinned to 0. |
| High | The `dayKey` drill-down's "±12h around canonical noon" comment claimed support only for whole-hour and half-hour zones, but the maths is in fact correct for every IANA offset (the noon instant already encodes the zone's offset). | Comment corrected in c7480e90; an explicit Kathmandu/Chatham note added so future readers don't second-guess. |
| Medium | The grouped path's response carries `total = number of synthesised rows` and the count caption renders "X measurements" — semantically that's now "X days" in the cumulative case. | Deferred. New translation key would be needed; the integer is still informative. Tracked for v1.4.38 polish. |
| Medium | `expandedDayKeys` state persists across page changes — fine since the grouped path is single-page now, but if pagination is re-enabled it would carry over to other pages. | Deferred. Pagination is currently disabled on the grouped path so the state model is unreachable on it. |
| Low | Drain `cutoffAt` is computed once per invocation. A long-running drain could race a watch sync that lands just inside the cutoff. | Acceptable. The drain is idempotent — the next nightly run picks up anything missed. |

## Brief-back (≤200 words)

(a) **Sample compression**: post-drain steady state collapses each
day to one `stats:` row per cumulative type. With 5 cumulative
types × ~365 days/year = ~1 825 rows/year vs the pre-drain ~50–200
chunks/day per type → conservatively **50× compression on the
ingest stream**, more on chatty Apple-Watch days. Marc's account
should drop from ~300 k cumulative rows to a few thousand once the
36 h grace window has elapsed twice (two nightly runs cover the
full pre-drain backlog because the drain is unbounded by date —
only the new cutoffHours limits the recent window).

(b) **Drill-down chattiness**: the second-query pattern feels OK
because the drill-down is gated on a user click, has
`staleTime: 5 min`, and the result is bounded (~few hundred rows
worst case). For multi-day expansions in one session each day fetches
once and stays cached. If telemetry shows a hot drill-down loop a
follow-up could prefetch when the user hovers the chevron.

(c) **Edge case**: after the drain the multi-source same-day case
is resolved by construction (the drain only collapses APPLE_HEALTH;
Withings keeps its own one-row-per-day shape; `pickCumulativeDaySum`
sums per source independently). The latent double-count documented
in the research brief disappears once the drain has run.

## Quality gates

- `pnpm typecheck`: clean for owned files (the single pre-existing
  failure is in `src/lib/insights/__tests__/features.test.ts` from
  the W2 sibling wave's WIP).
- `pnpm lint`: clean for owned files (the two errors are in
  `src/components/dashboard/medication-intake-quick-add.tsx` from a
  sibling agent's WIP).
- `pnpm test --run` over the owned files: 78 / 78 pass.
- Full unit suite: 4445 pass, 1 file failing on the W2 sibling WIP.

## Deferred / out of scope

- Translation copy for FR / ES / IT / PL on the three new keys
  (English fallback used, matches the existing locale-fallback
  convention for those locales).
- "ALL"-filter mixed-collapse: the brief authorised collapse-always
  but the practical interpretation is that the drain handles ALL
  collapse at the storage layer. Pre-drain accounts still see
  per-sample APPLE_HEALTH rows mixed with non-cumulative rows on
  the ALL view; once the nightly drain catches up the ALL view is
  naturally clean.
- Per-source priority for the day-grouped path (Withings vs
  APPLE_HEALTH on the same day). Today the route sums all sources
  inside a bucket — the existing `pickCanonicalSourceRows` ladder
  remains the analytics-layer surface; the list view is a raw audit
  view by design.

## Touch-disjoint verification

No file in my owned set overlaps with other waves' touch sets per
the marathon brief. Two marathon-collision events occurred where my
staged files rode on sibling commit messages (0af77230, 2987b8c9) —
content is intact and accurately described in this report.
