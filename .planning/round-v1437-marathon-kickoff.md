# v1.4.37 — Final Web Release Marathon

**Started:** 2026-05-17 (immediately after v1.4.36 live verify)
**Goal:** close the web punch-list cleanly so iOS can be the sole focus afterwards.
**Versioning:** **v1.4.37** (patch — additive features, no breaking change, follows the conservative-semver pattern).

## Marc-directive verbatim

*"Ich möchte jetzt ganz gerne fertig werden mit dieser Sache, sodass
ich wirklich jetzt die nur noch auf fixes einspiele, falls
irgendetwas ist. Sonst möchte ich mich jetzt vollumfänglich auf die
iOS App konzentrieren."*

This is the LAST big web release. After this, only emergency
hotfixes; everything else flows into v1.5 iOS.

## Default picks (Marc can redirect any of these mid-flight)

1. **Apple Health step consolidation**: replace the high-frequency
   per-sample entries on the measurements list with **one
   aggregated daily row per day** (sum + sample count). Detail
   samples remain accessible via an expand-on-click drilldown so
   the "wann wieviele gemeldet" Kreativitäts-Auswertung is not
   lost.
2. **Hinzufügen-Overlay extension** on the dashboard: same Sheet
   pattern as the existing quick-add overlays. New action
   "Medikamenteneinnahme erfassen" opens a bottom sheet with the
   user's medication list → dose/time. Same Sheet primitives, same
   styling.
3. **Arztbericht hero card** under Settings → Export: a top hero
   card with the export CTA and a one-line value statement,
   matching the visual weight of the Insights hero on the main
   page. Existing export options stay below.
4. **Coach disable cascade**: when the global Coach toggle is OFF,
   hide all Coach affordances — the FAB, the snapshot button,
   Coach-derived Insights cards, the personal-dropdown entry,
   nav strip Coach tab — completely, not greyed-out.

If any of these isn't what you want, send a single line to redirect
and the affected agent picks up the change.

## Waves

### W1 — Discovery research (3 agents parallel, dispatch FIRST)

| Wave | Topic | Output |
|---|---|---|
| W1a | Documentation landscape — current state of README, `docs/`, landing page (`healthlog.dev`?), doc site (`docs.healthlog.dev`?). Where are they? What sister repos? Benchmark against Linear / Plausible / Excalidraw / Cal.com / Supabase / Posthog README + docs structure. | `.planning/research/v1437-docs-landscape.md` |
| W1b | Apple Health step aggregation — how do Apple Health iOS, Garmin Connect, Oura, Withings, Fitbit handle high-frequency step samples vs daily summary? Per-sample list vs daily roll-up vs expand-on-day? Recommendation for HealthLog: replace + expand-on-detail (default pick above). | `.planning/research/v1437-step-aggregation.md` |
| W1c | Insights / Settings / Dashboard UX audit at 320 / 393 / 768 / 1280 viewports — pinpoint the wasted-space items: Insights hero-row height mismatch, Trends-card sizes that don't fit, Targets-page header gap, dropdown-arrow margin vs date-picker icon, Dashboard Hinzufügen button placement, mobile coverage on all of the above. | `.planning/research/v1437-ux-audit.md` |

### W2 — Perf carry-over from v1.4.36

`/api/analytics` full slice (correlations + healthScore +
bp_in_target) currently runs three concurrent live-SQL queries on
a cold pool — first-cold-hit was 111 s recorded. Lift them onto
the `probeRollupCoverage` / `isFullyCovered` helpers from v1.4.36
or, where the branch needs raw point-pairs (correlations across
two types), tighten the window to ≤ 28 days for the cold critical
path with graceful degrade past that. Same `path:"rollup"` /
`path:"live"` annotate so it's provable in prod logs.

### W3 — IntakeHistoryListV2 regression (Ramipril)

Marc UAT report:
- Grey rows (not green), no icon — just a long em-dash
- 29.04.2026 07:00 row says "eingenommen / Telegram-Erinnerung"
  but no source value in the leading column
- 22:43 row says "übersprungen aber eingenommen" simultaneously
- 16.05.2026 15:46 row renders correctly (green + source)

The V2 component is misrendering planned-schedule rows (and rows
where `status` is `skipped`) using the same "eingenommen" label as
true `taken` rows. Fix the query / render mapping so:
- `taken` → green check + Quelle
- `skipped` → grey, "übersprungen" label, no Quelle conflict
- `scheduled / planned` → either hide entirely (V1 behaviour
  Marc remembers) OR show as "Geplant" with clear distinct chip

Decision: **hide planned rows on the detail page intake history**
(matches V1). Planned/scheduled stays visible elsewhere (calendar
view, today list).

### W4 — UI symmetry punch list

#### W4a — Layout polish (single agent)

- **HealthScoreCard full-height parity** on Insights overview hero
  row. `items-stretch` on the grid + `h-full` on the card. Extra
  vertical space taken up by padding only (per Marc).
- **TopBar 3-dot overflow menu single-line** — `whitespace-nowrap`
  + `min-w-[14rem]` so "Benachrichtigungscenter" never wraps.
- **Targets page** ("Zielbereichsseite") header gap — large empty
  space between the metric label / setting and the value/chart.
  Audit per-row spacing, kill the gaps.
- **Dropdown arrow right-margin parity** — match the date-picker
  icon's right margin so the arrow doesn't feel crammed.
- **Insights Trends-card sizes** — finish the v1.4.36 chart-slot
  pin work, audit all three trend cards for byte-aligned width AND
  height, kill any remaining Recharts width/height warnings.
- **Dashboard "Hinzufügen" button** — placement audit at mobile +
  desktop viewports, fix spacing / hit-target.

#### W4b — Medication cards symmetry (single agent)

Marc UAT: the Ramipril vs Mounjaro detail cards look similar but
feel different — different colors, different functionality. He
wants Mounjaro to match Ramipril 1:1 (same components, same
features, same color treatment). Audit + reconcile.

### W5 — Coach disable cascade (single agent)

When the global Coach feature flag is OFF, every Coach-derived
surface disappears:
- Coach FAB hidden
- Coach Sheet not mountable
- Coach snapshot button hidden across surfaces
- Coach-tab in the Insights nav strip hidden
- Coach-derived Insights cards (correlations / daily briefing
  copy?) hidden or replaced with a non-AI version
- Personal-dropdown "Coach Einstellungen" entry hidden

Investigate every surface; reconcile feature-flag gating in one
helper.

### W6 — Settings & misc fixes (single agent)

- **Berlin/Browser timezone "Backen"** — remove the override
  toggle entirely; trust browser timezone always. Drop the
  related i18n keys.
- **IP-whois resolution** under Admin → Sign-in overview — "nach
  wie vor funktioniert die Auflösung von IP zu Standort gar nicht.
  Da wird nichts angezeigt, nur ein großer Gedankenstrich."
  Investigate the call path (it's the same ipwho.is fallback v1.4.36
  improved). Either the fallback isn't firing or the data isn't
  reaching the UI.
- **Insights BMI status stuck on "laden"** — the BMI status card
  never resolves. Find the query and fix the resolution.

### W7 — New features

#### W7a — Arztbericht hero card (Settings → Export)

A top hero card on `/settings/export` (or wherever the report
lives) with prominent CTA, value statement, and the same visual
treatment as the Insights hero. Existing export controls live
below.

#### W7b — Dashboard Hinzufügen — Medikamenteneinnahme overlay

Extend the dashboard "Hinzufügen" Sheet menu with a new action
"Medikamenteneinnahme erfassen". Opens the same Sheet pattern with
medication picker → dose → time → save. Match the styling of the
existing quick-add overlays.

#### W7c — Apple Health step consolidation (per W1b research)

Replace per-sample step rows on the measurements list with one
aggregated daily row (sum + sample count). Expand-on-click reveals
the detail samples for the "wann wieviele gemeldet" use case.
Server-side aggregation: the rollup table already has DAY buckets
for steps; expose them as the default list view.

### W8 — Documentation refresh

Driven by the W1a research output.

| Wave | Topic | Owner |
|---|---|---|
| W8a | README rewrite — comparable to Linear / Plausible / Posthog / Supabase in depth, structure, badges, screenshots, How-it-works walkthrough. Apple Health import + AI Coach get the front-page real-estate. | single agent |
| W8b | Landing page update — same value-statement upgrade. If sister-repo (`healthlog.dev`?) confirmed by W1a, dispatch in that repo. | single agent |
| W8c | Doc site refresh — depth on every feature page. Excalidraw diagrams for: data flow (Withings/Apple Health → rollups → Insights), Coach prompt pipeline, security model (encryption + sessions). Use the Excalidraw MCP to author. | single agent |

### W9 — GitHub repo audit (single agent)

Marc verbatim: *"über das Github-Repo gucken: Ist das alles richtig
konfiguriert? Sind da irgendwelche falschen Sachen noch im Repo, die
da eigentlich nicht reingehören?"*

- Settings: description, topics, homepage URL, license badge,
  social preview, security/code-scanning, branch protections on
  `main`
- Workflows: any dead/flaky/redundant ones?
- Files at repo root: anything that doesn't belong (sensitive
  test data, stale scripts, AI/marathon trail leftovers)
- `.github/` templates: issue / PR templates current?
- Demo deployment + landing page links current?

### W10 — Multi-Agent QA reconcile

Standard line-up dispatched at the end:
- `superpowers:code-reviewer` over the full diff since v1.4.36
- `general-purpose` security audit
- `general-purpose` UX / responsive / a11y audit
- `general-purpose` architectural correctness
- `code-simplifier` dead-code / simplification
- `general-purpose` i18n runtime probe (all 6 locales × all routes)

Critical / High findings APPLIED before release tag. Lows defer
to a v1.4.38 backlog if any.

### W11 — Release prep

Version bump → CHANGELOG → squash to main → tag → GH release →
live verify → perf re-check → closure + memory.

## Quality gates (non-negotiable per round)

- typecheck clean
- lint 0 errors / 0 warnings on touched files
- unit + integration test suite green (modulo the documented
  pre-existing flakes)
- no PII in CHANGELOG / GH release / docs / landing
- Marc-Voice English commits + user-facing artefacts
- No `Co-Authored-By: Claude`, no `--no-verify`, no `--no-gpg-sign`
- Touch-disjoint between parallel agents

## Tracking

Per-wave reports written to `.planning/phase-W<n>-v1437-<topic>-report.md`.
Backlog at `.planning/round-v1437-backlog.md`.
This kickoff doc is the source-of-truth for scope.
