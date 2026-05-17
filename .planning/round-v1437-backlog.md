# v1.4.37 backlog

Seeded 2026-05-17 right after v1.4.36 went live. Marc-directives
captured verbatim where they're load-bearing.

## P1 — perf carry-over from v1.4.36

### Full `/api/analytics` route on the rollup-coverage probe

`comprehensive-aggregator` + `summaries-slice` already skip the
heavy live-SQL aggregate on the rollup-fresh + fully-covered path
(v1.4.36 wave). The **FULL** `/api/analytics` (default slice — no
`?slice=summaries`) still runs the correlations + healthScore +
`bp_in_target` branches against live `measurements`, and they
fired three concurrent queries on a cold-pool DB right after the
v1.4.36 deploy → first cold hit was **111,092 ms**. It
stabilised to 756 ms warm DB and 11–28 ms cached, but the cold
worst-case is unacceptable.

**Plan:**

- Lift the three branches (`correlations`, `healthScore`,
  `bp_in_target`) onto the `probeRollupCoverage` /
  `isFullyCovered` helpers added in v1.4.36.
- Where a branch can compose linearly from DAY buckets
  (counts, sums, simple deltas), read from `measurement_rollups`.
  Where it cannot (correlations need raw point pairs across two
  types), tighten the window first: drop scan to ≤ 28 days for
  the cold critical-path and degrade gracefully past that.
- Add the same `path:"rollup"` / `path:"live"` annotate to each
  branch so we can prove which path fired in production.
- Test: pin "cold pool + Marc-sized rollup table" against a < 2 s
  ceiling.

Reference: `.planning/round-v1436-perf-verify.md` (TL;DR table +
"Open issues" section).

## P1 — Insights overview Health-Score card height parity

Marc verbatim: *"in den Insights, wenn ich die Übersicht habe, die
Hero-Card da auf der rechten Seite ist meine Gesundheits-Score-Karte.
Ich möchte gerne, dass die Gesundheits-Score-Karte genau so lang ist
wie die Hero-Card. Im Moment habe ich ja eine freundliche
Trennlinie, die freundliche 'Frag mich vor' beginnt, und ich möchte
aber, dass das Element der Gesundheits-Score-Karte durchaus bis ganz
unten geht und nicht bei der Trennlinie aufhört."*

**Plan:**

- Inspect the Insights overview hero row (Daily Briefing / "Frag
  mich" left + HealthScoreCard right).
- Make the right-side HealthScoreCard stretch to match the
  left-side hero card's full height — currently it ends at the
  divider that introduces the next section.
- Likely fix is `items-stretch` on the grid + `h-full` on the
  HealthScoreCard wrapper.

**Open question for Marc:** when stretched, should the extra
vertical space be (a) padding around the score, (b) extended
breakdown rows (more metric chips visible), or (c) a
visualization extension (mini-spark of the 7-day trend)? The
default if no preference: just stretch the existing card layout
with extra padding so the visual aligns.

## P1 — TopBar 3-dot overflow menu must stay single-line

Marc verbatim: *"Ich möchte, dass, wenn ich auf die drei vertikalen
Punkte drücke, das einzeilig bleibt. Im Moment gibt es einen
Umbruch bei Benachrichtigungscenter. Ich möchte, dass das nicht
zweireihig wird, sondern dass es in einer Reihe bleibt."*

**Plan:**

- Find the overflow menu component (probably
  `src/components/layout/top-bar.tsx` or a dropdown menu).
- The "Benachrichtigungscenter" item wraps to two lines because
  the menu width is set too narrow OR `whitespace-nowrap` is
  missing on the menu item label.
- Add `whitespace-nowrap` to menu items + widen the menu to
  accommodate the longest German label (Benachrichtigungscenter =
  21 chars; menu probably needs `min-w-[14rem]` or so).

## P0 — IntakeHistoryListV2 RamiPril regression

Marc verbatim: *"irgendwas ist auch nach wie vor mit der
Einnahmeverlauf, zum Beispiel bei mir mit Ramipril, anders als das
vorher war. Da habe ich jetzt irgendwie auch alte Daten noch drin,
die ich eigentlich anscheinend nur für eine geplante Sache habe.
Da steht da Status: eingenommen, aber es gibt gar keinen Punkt, wo
ich das eingenommen habe. Das sah früher definitiv anders aus.
Kannst du das wieder so machen wie das früher aussah?"*

**Symptom:** the v1.4.36 IntakeHistoryListV2 (restored on the
medication detail page) is showing rows with **Status: eingenommen**
for entries Marc never marked taken. These appear to be planned
schedule entries that the V2 component is misrendering as actual
intakes.

**Investigation needed before plan:**

- Compare the V2 component's data source against the
  pre-retirement V1 source. V2 likely reads from a query that
  unions planned-schedule rows with actual-intake rows but
  doesn't filter the planned ones out.
- Or V2 renders `status: "scheduled"` rows with the same German
  label "eingenommen" that should only apply to `status: "taken"`.

**Likely fix:** either filter the query to actual-intake rows
only (matching V1 behaviour Marc remembers), OR add a status
column with distinct labels (`Geplant` vs `Eingenommen`) so the
data is at least disambiguated.

**Severity:** if this is misleading Marc about his RamiPril
adherence, it's a P0 — file as hotfix v1.4.36.1 candidate, NOT
v1.4.37 material. Decision pending Marc's call (see "Open
questions" below).

## Open questions for the next session

1. **Hotfix vs feature release**: should the RamiPril regression go
   out as v1.4.36.1 hotfix (before any other v1.4.37 work) or
   bundle into v1.4.37? Default recommendation: **hotfix v1.4.36.1**
   because it's a data-integrity perception bug (adherence display
   is wrong).
2. **HealthScore stretch fill**: padding only, or stretched
   breakdown rows / mini-spark? See P1 above.
3. **Other Insights-overview height mismatches**: only the
   HealthScoreCard mentioned, or are there other right-column
   cards (Coach FAB, Daily Briefing) with the same parity issue?

## Already-known deferred items (carried from v1.4.36 handover)

- `applyInsightsExcludeFilter` shallow `next.context` mutation
  needs a contract test pin.
- `/settings/about` legacy permalink decision (redirect vs 404 vs
  documented permalink).
- `/api/measurements?source=rollup` response omits `id`/`unit`/`source`;
  need a dedicated `MeasurementBucketResource` schema or echo
  `unit` + sentinel `id`.
- `BUCKETED_TYPES` in `features.ts` duplicates the rollup-populator
  enum (drift risk).
- COUNT-probe call sites in `summaries-slice.ts` and
  `comprehensive-aggregator.ts` could collapse into one helper —
  partially done in v1.4.36, verify and remove residual duplication.
- Cumulative SUM `mean × count` over-counts on multi-source
  same-day (Apple Health + Withings both posting steps the same
  day) — pre-existing chart behaviour.
- IntakeHistoryListV2: motion-reduce cascade, sticky first column
  on narrow viewports.
