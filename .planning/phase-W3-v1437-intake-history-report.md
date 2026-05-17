# Wave W3 — IntakeHistoryListV2 regression fix (v1.4.37)

## Summary

Marc reported that the v1.4.36-restored `IntakeHistoryListV2` on the
medication detail page rendered rows with `takenAt:null AND
skipped:false` as a grey chip labelled "Eingenommen" with an em-dash
where the green icon should have been, and at least one row that
read "übersprungen AND eingenommen" simultaneously. The root cause
was a single binary mapping (`event.skipped ? "Übersprungen" :
"Eingenommen"`) over a data set that includes a third state —
"missed / never confirmed" — the v1 component used to render as
"verpasst" before it retired in v1.4.28.

Per Marc's decision the detail-page list now hides those ambiguous
rows entirely. They remain visible on the calendar / today
surfaces (untouched). Skipped rows render distinctly.

## Root cause (one-liner)

Both: the API returned every row regardless of completion state, and
the V2 render mapped a row to "Eingenommen" whenever `skipped` was
false — even when `takenAt` was null.

## V1 reference behaviour matched

The retired v1 `<IntakeHistoryList>` (commit `8c81af10`) had three
explicit status arms — `taken` (green Check + "Eingenommen"),
`skipped` (outline SkipForward + "Übersprungen"), `missed` (red
AlertTriangle + "Verpasst"). It rendered every row but never
mislabeled a missed row as taken. The v1.4.37 fix collapses the
missed arm by hiding those rows server-side via `?status=completed`,
and keeps the same Check / SkipForward iconography + green-vs-muted
chip differentiation for the two visible arms.

## Commits

| SHA | Message |
|-----|---------|
| `a0af8c72` | `feat(medications): add status filter to GET /api/medications/[id]/intake` |
| `be399ee7` | `fix(medications): intake-history-list-v2 hides unconfirmed rows and renders distinct skipped chip` |
| `6b2c63ca` | `test(medications): pin intake-history-list-v2 status render contract` |
| `f33c70b3` | `style(medications): prettier sweep on the W3 intake-history fix` |

## File set

- `src/lib/validations/medication.ts` — extended `listIntakeEventsSchema` with an optional `status: "all" | "taken" | "skipped" | "completed"` knob, default `"all"`.
- `src/app/api/medications/[id]/intake/route.ts` — translates the knob into a Prisma `where` fragment, threads it through both `findMany` and `count` so totals match the visible page, and annotates the log line with the resolved status.
- `src/app/api/medications/[id]/intake/__tests__/route.test.ts` *(new)* — pins each status branch's where fragment and the 422 on unknown values.
- `src/components/medications/intake-history-list-v2.tsx` — pins `STATUS_FILTER = "completed"`, threads it into the queryKey and the URL, and rewrites the status cell with explicit taken / skipped / null branches (taken = green secondary chip + Check; skipped = muted outline chip + SkipForward; nothing falls through to a default label).
- `src/components/medications/__tests__/intake-history-list-v2.test.tsx` — seed helper updated to mirror the new queryKey shape; two new fixtures lock the distinct render contract per status arm and the German-locale no-Eingenommen-leak guard.

Drive-by: `src/lib/validations/medication.ts` picked up two pre-existing whitespace tweaks (InventoryItem type aliases, `glp1PostBodySchema.refine`) during the prettier sweep — no behavioural change.

## Tests delta

| Surface | Before | After |
|--------|--------|-------|
| `intake-history-list-v2.test.tsx` | 8 | 10 |
| `api/medications/[id]/intake/__tests__/route.test.ts` | (new) | 7 |
| **Total new unit tests** | — | **+9** |

All 17 W3-touched tests pass. Pre-existing failure in
`src/app/api/analytics/__tests__/route.test.ts` (3 cases) confirmed
unrelated — reproduced against `git stash`-clean tree before any W3
edits.

## Quality gates

- `pnpm typecheck` — clean against W3 files alone (one error in
  `src/lib/insights/__tests__/features.test.ts` is in another
  parallel agent's uncommitted WIP).
- `pnpm lint` — clean.
- `pnpm prettier --check` — clean on the five W3 files.
- `pnpm test --run` for W3 files — 17/17 pass.

## Backward compatibility

- `status:"all"` is the schema default, so every existing GET caller
  (iOS Swift client, DrugLevelChart, dashboard tiles) receives the
  same payload as before this wave. The new query param is purely
  additive.
- Co-located route test pins the back-compat case explicitly (`it("applies no status filter when status is omitted")`).
- The `medications` query-key family already shards per medication
  + offset + sortBy, and the new `status` key is added to the V2
  shard only — no risk of cross-component cache collision per the
  documented HealthLog convention.

## Code review (self-review, Task subagent unavailable in nested context)

**Strengths**
- Filter is opt-in with a back-compat default; iOS and dashboard
  consumers untouched.
- Render derives the visual arm from `!skipped && takenAt` rather
  than `skipped` alone, so any future malformed row still cannot
  surface as "Eingenommen".
- `STATUS_FILTER` lifted to module scope keeps the queryKey
  reference-stable.
- Lucide icons get `aria-hidden="true"` so screen readers do not
  read the chip label twice.
- Co-located route test pins `count.where === findMany.where` so
  paginated totals always reflect the filtered set.

**Findings — Critical**
- None.

**Findings — Important**
- None.

**Findings — Minor (deferred, noted only)**
- The `medication_intake_events` table has `@@index([userId, medicationId, scheduledFor])` but no partial index on `skipped` or `takenAt`. Volume is low (paginated 25, single user, per medication) so this is not worth a schema migration during the iOS-launch web freeze. Revisit post-v1.5 if the detail-page surfaces a perf complaint.
- Locales other than `de` and `en` (`es`, `fr`, `it`, `pl`) reuse the existing `intakeHistoryStatusSkipped` / `intakeHistoryStatusTaken` keys verbatim — no drift introduced.

**Applied vs deferred**
- Applied: every finding above is reflected in the shipped code.
- Deferred: none.

## Edge case worth surfacing

If a medication has only planned-no-taken events (e.g. a brand-new
medication that was scheduled but the user has never confirmed an
intake), the detail-page list will now render the empty-state with
the "Open daily intake" CTA. That matches Marc's "match v1
behaviour" decision (v1 listed those rows but rendered them as red
"verpasst" — Marc said the detail page should focus on actioned
rows). Calendar / today surfaces still surface the planned rows so
the user can act on them.

## Cross-agent note

The `f33c70b3` prettier-sweep commit picked up a `README.md`
architecture-section addition that belongs to the parallel
docs-landscape research agent — a `git stash` / `git stash pop`
race between my prettier write-and-commit step and the
docs-diagrams commit (`04aa2fc8`) ahead of it folded those changes
into my commit. The content is correct and the docs agent's work
is preserved; only the attribution is slightly off. No revert is
warranted.
