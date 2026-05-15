---
file: .planning/v1427-plan.md
purpose: v1.4.27 comprehensive QoS pass — visual symmetry, UX polish, data-driven hiding, iOS handshake foundations, v1.4.26 backlog cleanup
created: 2026-05-15
target_tag: v1.4.27
predecessor: v1.4.26
---

# v1.4.27 Plan — QoS Pass + Backlog Sweep

## Headline

Maintainer directive: pull v1.4.26 backlog forward + apply 27 QoS findings spanning Dashboard, Settings, Coach, Insights, Notifications, Admin, plus an iOS-handshake foundation pass for the parallel native client. Conservative-semver patch.

## Convention

Marc-Voice English everywhere — including this plan, fix-surface specs, CHANGELOG, GitHub Release notes. Forbidden terms: AI, Claude, agent, marathon, wave, phase, session, subagent. Use neutral alternatives: round, pass, slot, contributor, automation. No PII (maintainer's name, health figures, target ranges). Branch model: commit to `develop`, release via PR `develop → main`, tag on main.

## 27 Findings (verbatim from maintainer briefing)

### Dashboard

1. **GLP-1 (Mounjaro) therapy card shows only weight history** — needs the drug-level chart as a second tile or section. Drug-level is more informative than weight alone for the active-treatment view.
2. **Green band on the side of the GLP-1 card is optically unclear** — currently "letzte Indikation / nächste Indikation" sits awkwardly mid-card.
3. **Point-count selector inconsistency** — other charts let the user pick range (7d / 30d / 90d / etc.); GLP-1 card doesn't. Standardize.
4. **Trend charts use different heights** — bring all trend-row charts to a single height across the strip.
5. **"KI-Gesundheitsanalyse" card at bottom of dashboard is dead** — leftover surface, remove entirely.
6. **Daily Briefing duplicates the hero greeting text** — hero already says "Guten Tag, …"; the briefing repeats the same line. Strip the prose from the briefing and show only the structured findings.
7. **Weekly report click is dead** — the tile is clickable but nothing routes from it. Either implement the weekly report route or remove the affordance.
8. **Health-Score card needs to fill the hero column properly** — currently it's a small inset inside the hero rectangle. Make it occupy a larger share, both width and height, of the hero card.

### Settings, Profile, Admin

9. **Settings → Account → Profile field arrangement is asymmetric** — spacing between fields is not consistent. Apply design-system rhythm.
10. **Zeitzone Berlin gap to its neighbour button is smaller than the top-row gaps** — restore vertical rhythm.
11. **Language Deutsch sits alone at the bottom of the profile form**, wasting a row. Move next to "Datum" so the form ends symmetrically.
12. **Page-height shifts on click of items like "persönliche Zielwerte" and "Quellen" inside settings + admin sub-pages** — sidebar and main column re-flow on every click. Likely a viewport-bound miscalculation.
13. **Symmetry audit overall** — across every settings / admin / profile / preferences sub-page, button positions, label-input gaps, card paddings.

### Coach (`/coach`)

14. **Helper "what is this?" chips render below every answer with literal metric values exposed** — e.g. "Blutdruck letzte 30 Tage: 226" then "Worauf bezieht sich das?" beneath. Hide the prose; keep only the disclosure (expandable) for "Worauf bezieht sich das?".
15. **"Enter zum Senden / Shift+Enter für neue Zeile" footer under the textarea is verbose** — replace with a single info icon (tooltip on hover) so the input has more vertical room.

### Insights (mother page + sub-pages)

16. **`metric:PULSE` raw tokens leak at the end of insight prose** — visible in Blutdruck, Gewicht, Stimmung, Medikamente, BMI, Schlaf insight cards. A prompt template variable that didn't substitute.
17. **Show only metrics with data** — currently VO2max sub-page renders even with zero observations.
18. **Auto-include metrics when their data source connects** — e.g. steps + active-energy from Apple HealthKit should appear automatically once the iOS native client uploads them. Today these sub-pages render empty banners.
19. **No data ⇒ hide everywhere** — including the top nav strip. If no sleep observations exist, the sleep tab itself should not render.

### Notifications + Withings

20. **Telegram error "Withings error"** fires even when the sync succeeds and new data is fetched. Manual "Synchronisieren" button confirms the sync works. The error-classification path is firing on a benign code path.
21. **Telegram notification copy is English now** — should follow the user's selected locale (`User.locale`). Regression from a recent commit.

### Admin → Login overview

22. **Standort cell shows a dash where the city should be** — geo-IP lookup is failing or the field is mismapped.
23. **Provider column lists API-Token / Passkey but not the carrier provider** — e.g. "Telekom" / "Vodafone" / "1&1" derivable from the ASN of the IP. Add ASN-to-carrier lookup.

### iOS native client handshake

24. **iOS app should run standalone (offline-first) + optionally pair with a server later** — research how comparable health apps solve the offline-first + optional-cloud-sync architecture. Document patterns + propose iOS-side adaptations.
25. **iOS feature parity** with as many server-side surfaces as makes sense — re-survey what's in v1.4.26 + identify which surfaces map to native counterparts.
26. **Sync conflict resolution** — when offline writes conflict with server state on reconnect, what's the policy? Research + propose.

### Generic

27. **Quality-of-Service everywhere** — symmetry, predictability, no scroll-jumps, locale-honouring copy across the app.

## Round structure

### Round 1 — Audit + research (6 parallel)

| Slot | Focus | Output |
|---|---|---|
| **R1.1 Dashboard UX** | Findings 1-8 + the GLP-1 drug-level secondary tile spec | `.planning/research/v1427-r1-dashboard.md` |
| **R1.2 Settings + Admin UX** | Findings 9-13 + 22-23 (admin login enrichment) | `.planning/research/v1427-r1-settings-admin.md` |
| **R1.3 Coach + Insights data-driven** | Findings 14-19 (Coach blue text, Insights data-gating, `metric:PULSE` bug) | `.planning/research/v1427-r1-coach-insights.md` |
| **R1.4 Notifications + Withings** | Findings 20-21 (false error classification, locale-aware Telegram) | `.planning/research/v1427-r1-notifications.md` |
| **R1.5 iOS offline-first + sync research** | Findings 24-26 + pattern survey (Apple Health, Withings Health Mate, Pillow, Bearable, AutoSleep) | `.planning/research/v1427-r1-ios-offline.md` |
| **R1.6 v1.4.26 backlog sweep** | Re-read `.planning/v1426-backlog.md` + decide which items pull forward into v1.4.27 | `.planning/research/v1427-r1-backlog-sweep.md` |

### Round 2 — Triage + fix-surface plan

Single consolidator reads all six outputs, produces `.planning/v1427-fix-plan.md` with:
- De-duplicated findings (some R1.x outputs will overlap)
- Touch-disjoint fix-surface buckets (target 5-7)
- File-touch collision matrix (zero same-file conflicts)
- Defer matrix (apply now vs v1.4.28 vs v1.5)

### Round 3 — Implementation (parallel)

4-6 fix-surface contributors per Round 2 plan. TDD on every new helper. Per-commit gates clean (`pnpm typecheck && pnpm lint && pnpm test --run <touched-surface>`). Atomic commits.

### Round 4 — QA pass

Eight parallel reviewers (code-review, security, design, senior-dev, simplifier, product-lead, i18n-runtime, dead-code) write findings to `.planning/research/v1427-r4-*.md`. Reconcile pass applies Medium+/High+/Critical findings.

### Round 5 — Release

Editorial pass over CHANGELOG.md (Marc-Voice, no convention violations). Version bump. PR `develop → main`. Squash merge. Tag `v1.4.27`. Push. Verify GHCR multi-arch build. Deploy on apps01 + edge-01. Create GitHub Release. Bump sister repos (`healthlog-docs` + `healthlog-landing`).

## Anti-goals

- No iOS-side code in this release (the iOS client is a separate repository with its own release cadence). Round 1 produces iOS-handshake research + server-side preparations only.
- No MDR / regulatory scope expansion. GROUND RULES 1-15 stay verbatim.
- No new Prisma migrations unless absolutely required. Aim for additive Prisma model changes only with `IF NOT EXISTS` guards.

## Done when

- `healthlog.bombeck.io/api/version` returns `"1.4.27"`
- `demo.healthlog.dev/api/version` returns `"1.4.27"`
- GitHub release page lists `v1.4.27` at the top
- `https://healthlog.bombeck.io/privacy` still returns 200 (regression guard)
- All findings 1-27 either landed or explicitly deferred with reason in `.planning/v1428-backlog.md`
