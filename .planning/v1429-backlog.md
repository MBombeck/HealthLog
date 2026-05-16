---
file: .planning/v1429-backlog.md
purpose: v1.4.29 backlog seeded from v1.4.28 deferrals + carry-forward items
created: 2026-05-16
---

# v1.4.29 backlog

Items deferred from the v1.4.28 round and the carry-forward set from
the v1.4.28 backlog that did not land. One-line rationale per entry.

## Direct v1.4.28 deferrals

- **SD-H1 "All time" client wire-up.** Server machinery landed at
  `8144281d` (monthly aggregation with the 24-bucket ceiling). Client
  still defaults the "All time" tab to a 365-day window with no
  `aggregate` query parameter. Flipping the client to pass
  `aggregate=monthly` plus the user's earliest measurement as `from`
  is a four-line edit; the bucketed rows carry a divergent shape from
  the raw rows so the chart adapter needs a small helper to merge the
  two inputs before Recharts reads them.

- **`v1.4.20 phase B4` and other historical version markers in code
  comments.** Roughly 10 references in code comments. Hygiene scrub —
  defer until the file is next open for a substantive change.

- **R4 dead-code orphans.** 11 candidates from `v1428-r4-dead-code.md`.
  Verify each at HEAD before dropping; `DrugLevelChart.compact` was
  addressed by the UI-H1 commit (lifted onto `<MedicationDetailSection>`
  in `e5cb74b4`) but the broader sweep stayed deferred. Cosmetic.

- **R4 simplifier Mediums + Lows.** Six items in `v1428-r4-simplifier.md`:
  - S-M1 `<MoodChartDynamic>` re-export (three call sites)
  - S-M2 inline `["analytics"]` cache key vs `queryKeys.analytics()`
  - S-M3 mother-page analytics block consumer migration
  - S-M4 `<EmptyState ctaSize="lg">` prop landed with zero consumers
  - S-M5 i18n orphan namespaces flagged by the locale-coverage probe
  - S-L1 through S-L3 (interface-only `export` keywords, in-file
    sub-component carve-outs, dead test fixtures)

- **R4 design Mediums (8 items).** From `v1428-r4-design.md`:
  - D-M1 `<TrendCard>` BD-Zielbereich padding cascade at `md+`
  - D-M2 Daily Briefing CTA empty-state variant unification
  - D-M3 Coach drawer phone branch min-height contract
  - D-M5 Mood-chart standalone consumption-path tile-card override
  - D-M6 HealthScore delta motion-reduce gate on the popover trigger
  - D-M7 InsightStatusCard skeleton row palette parity
  - D-M8 SubPageShell description prop populated on every metric page
  - D-M9 NotFound page `<Button asChild>` migration

- **R4 UI-conformity Mediums (4 items).** From `v1428-r4-ui-conformity.md`:
  - UI-M1 `<MedicationCardHeader>` standalone-mode chrome parity
  - UI-M2 Coach pill size mismatch between desktop and tablet
  - UI-M3 `<SectionCard>` primitive carve-out (21 candidate sites)
  - UI-M4 Loader spinner palette + size + motion-reduce vocabulary
    drift (18 variations)

- **R4 product-lead non-critical items.** From `v1428-r4-product-lead.md`:
  - Vendor-label exemption note formalised in `messages/_meta/forbidden-words.md`
  - Marketing landing copy parity audit (sister-repo)
  - Headline accuracy audit for the next release

- **R4 senior-dev Mediums (7 items).** From `v1428-r4-senior-dev.md`:
  - SD-M1 `<ResponsiveSheet>` footer slot rail wiring across 4
    remaining consumers (HIGH-1 from v1.4.27 backlog)
  - SD-M2 `<ResponsiveSheet>` viewport-rotation focus/scroll loss
  - SD-M3 Three remaining raw `<select>` blocks on `ai-section.tsx`
  - SD-M4 `<ResponsiveSheet>` Dialog branch `bodyClassName` divergence
  - SD-M5 react-hook-form deps hygiene
  - SD-M6 Five `<Dialog>` consumers still to migrate to
    `<ResponsiveSheet>`
  - SD-M7 Coach launch surface on the empty-state Insights sub-pages

- **R4 i18n Mediums + Lows (5 items).** From `v1428-r4-i18n.md`:
  - I-M1 `achievements.badges.*` 118 EN-leak rows
  - I-M2 `admin.section.*` 99 EN-leak rows
  - I-M3 `settings.ai.*` 65 EN-leak rows
  - I-M4 Whitespace-around-placeholder drift-guard tightening
  - I-L1 Native-pagination connector test on the `pageInfo` shape

## Carry-forward from v1.4.28 backlog

- **BK-CF-77 — Six admin tables miss the card-list fallback.** Severity
  High · MA6-F2 · effort L. Per-table contributor load; mechanical
  pattern but ~6 tables × non-trivial card design.

- **BK-UI-Admin — Admin section chrome divergence (11 surfaces).**
  Eleven admin section cards render `<div className="text-lg
  font-semibold">` for the card title (not a heading element). Six
  others use `<h2 className="text-lg font-semibold">` for the same
  role. Decision call: pull the dual-pattern surfaces into a shared
  `<SectionCard>` primitive.

- **BK-UI-SectionCard — 21 candidate sites for the carve-out.** The
  `<div className="bg-card border-border rounded-xl border p-6">`
  card pattern appears 21 times across admin + settings.

- **BK-UI-Loader — Loader spinner vocabulary drift (18 variations).**
  Pick one canonical vocabulary (the most common is
  `text-primary h-6 w-6 animate-spin motion-reduce:animate-none`) and
  sweep.

- **BK-HIGH-1 — `<ResponsiveSheet>` footer slot rail wiring.** The
  footer slot is dead code on every consumer except
  `export-section`. Move inline form footers to
  `<ResponsiveSheet footer={…}>` across all five primary form call
  sites. ~80 LOC.

- **BK-HIGH-2 — `<ResponsiveSheet>` viewport-rotation focus/scroll
  loss.** The Sheet/Dialog mount swap at the breakpoint boundary
  drops focus + scroll position on viewport rotation. Pick a rotation
  strategy: lock-at-mount vs unified Dialog/Sheet root.

- **BK-Drift Dialog migration — 5 remaining `<Dialog>` consumers.**
  `phase-config-dialog`, `ResearchModeAcknowledgmentDialog`,
  `mood-list` row-edit, `measurement-list` row-edit,
  `target-edit-sheet` should migrate to `<ResponsiveSheet>` for
  parity with the v1.4.27 primary form flows.

- **BK-CF-78 — `<DateTimeInput>` rewrite (shadcn DatePicker +
  TimePicker).** Severity Medium · MA4-F7 · effort L. Introduces a
  new dependency or component family; out of scope for a polish
  round.

- **BK-CF-79 — RHF + Zod migration for `measurement-form` +
  measurement-list edit.** Severity Medium · MA4-F10 · effort
  M-bordering-L. Broad scope; touches the API integration shape and
  therefore the iOS-side native API contract. Document the call
  before starting the migration so the iOS client can mirror the
  schema.

- **BK-CF-80 — Bottom-sheet primitive across all medication
  entry-points.** Severity Medium · MA5-F13 · effort L.

- **BK-admin-endpoints — Five orphan endpoints flagged for
  wire-or-remove.** `/api/admin/ai-settings`,
  `/api/admin/backup/test`, `/api/admin/status-overview`,
  `/api/monitoring/glitchtip/test`, `/api/monitoring/umami/test`. Per
  endpoint: wire to a real consumer or drop both the route and the
  README mention in the same commit.

- **BK-i18n-FR/ES/IT/PL drift — 1 664 keys flagged.** The
  locale-coverage probe surfaced 1 664 keys where at least one of
  FR/ES/IT/PL still equals the EN value. v1.4.29 chooses between
  drift-guard tightening or targeted per-namespace sweeps.

- **BK product-lead vendor-label exemptions.** Carry the
  `messages/_meta/forbidden-words.md` exemption note formalisation
  forward.

## Historical / metadata notes

- **Two mislabelled commits.** `235e52cb` (subject
  `refactor(charts): single HealthChartDynamic re-export`) actually
  carries the `<MobileRailTray>` carve-out; `0e7c97c5` (subject
  `fix(insights): align briefing empty-state CTA variant`) actually
  carries the trends-row equal-height contract plus the briefing
  variant flip. The functional changes shipped — the subject lines
  are wrong on develop. Both ride into main under the v1.4.28
  squash commit which carries the canonical CHANGELOG headline and
  body, so the squash scrubs the misnomer from main's history. Log
  entry for the v1.4.28 closure record.

- **Two commit-body residues on develop.** `9a020f21` (commit body
  contained the maintainer's first name) and `f0e3e055` (commit body
  contained one instance of forbidden vocabulary while documenting
  the scrub itself). Both were authored before the round closure
  cleared on the commit-message linter; both ride into main under
  the v1.4.28 squash which uses the clean release headline + body.
  Develop's individual-commit history retains the strings; main
  does not. Log entry for the v1.4.28 closure record.
