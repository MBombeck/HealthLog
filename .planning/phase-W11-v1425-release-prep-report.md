# Phase W11 — v1.4.25 release prep

Date: 2026-05-14
Branch: develop (no tag, no main push)
Driver: autonomous release-prep run — Marc directive (review + tag self after UAT)

## Outcome

`package.json` bumped 1.4.24 → 1.4.25. CHANGELOG.md gains a 387-line
v1.4.25 entry covering the full wave delta (W2 through W11) in the
canonical Added / Changed / Fixed / Security / Refactor / Tests /
Deferred sections. Single atomic commit on `develop`. Draft-PR opened
against `main` to trigger the pre-tag CI workflow battery.

## Version bump

| File | Old | New |
| --- | --- | --- |
| `package.json` | `"version": "1.4.24"` | `"version": "1.4.25"` |

No other files version-encoded (CHANGELOG header is the version source
of truth; docs site image-pins update lives in W12 per handoff §2).

## CHANGELOG entry — section coverage

| Section | Bullet count | Source coverage |
| --- | --- | --- |
| Lead paragraph | 1 | Marathon outcome — feature density framing only, no process-meta |
| Added | 17 | W3e, W4, W4d, W4c, W6c, W8c, W7+W7b, W8e, W9e, W8d (3 items: VO2-tile, PR, Workout), W5d, W8b, W4b, W11a, W9 |
| Changed | 8 | W3 (insights slim), W3e, W5, W6 (global default), W4e, W8 (padding parity + icon-heading), PROMPT_VERSION |
| Fixed | 17 | W6, W6 (comparison shift), W5b, W5c, W7d, W3 (StatusCard), W8 (admin header), W8 (icon parity), W4d/W5/W3 a11y, W3 (sleep strokes), W3 (per-night i18n), W8 (padding asymmetry), W7b (berlinIsoWeekday), W8d (batch race), v1.4.24 followup (requireAuth narrow-scope), W8d (deviceType POST), W8d (PR pagination) |
| Security | 6 | GLP-1 dose refusal (W4d), GLP-1 sanitiser, batch rate-limit, audit-log writes, Withings OAuth scope, source-priority storage |
| Refactor | 7 | pickCanonicalSource two-axis, Health-Score hoist, SubPageSlug derivation, source-priority null bucket, apple-health sleep collapse, HK_QUANTITY_TYPE_TO_MEASUREMENT removal, W7e dead-code pass, Coach drawer controlled-prop |
| Tests | 3 paragraphs | 2244 → 2652 unit (+408); 140 → 174 integration (+34); enumerated new suites |
| Deferred to v1.4.26 | 12 bullets | Headline items from v1426-backlog.md P0–P4 |
| Deferred to v1.5 | 7 bullets | iOS P1–P5, workout ingest, two-brain refactor, HRV detection, mindfulness/water/symptoms, ECG/FHIR, Pearson incomplete-beta |

Cross-checked against handoff §2 W11 "Inputs that MUST go in" — every
listed feature landed in CHANGELOG. Items shipped via W4d-tests are
folded into the Tests block. Items shipped via W3f polish-wins
(orphan endpoint removal, comparison-overlay grey-out, per-card cog,
sleep-stages per-night) are folded into Added (Sleep sub-page) /
Refactor (W7e dead-code pass) as appropriate.

## PII grep verification

```
$ grep -nE "Bombeck|Marc|mbombeck@" CHANGELOG.md | head -20; echo "exit:$?"
# (empty)
exit:0
```

Zero hits — the new v1.4.25 entry contains no maintainer name, no
email, no test-fixture username, no real measurement readings, no
city or country mentions.

## Process-meta grep verification (v1.4.25 block only)

```
$ awk '/^## \[1\.4\.25\]/,/^## \[1\.4\.24\]/' CHANGELOG.md \
    | grep -niE "marathon|wave|parallel agent|multi-agent|claude|phase[ -]?[0-9]|as part of the v1\.4\.25 (release|sprint|marathon)"
122:  fat mass, muscle mass, skin temperature, pulse-wave velocity,
383:- **ECG waveform ingest + FHIR / HKClinicalRecord.**
```

Two grep hits — both technical terms, not process-meta:

- Line 122 — "pulse-**wave** velocity" is the Withings PWV measurement
  type, not a release-process wave.
- Line 383 — "ECG **wave**form" is the standard cardiology term for
  the cardiac-electrical trace, not a release-process wave.

No "marathon", "phase", "parallel agent", "multi-agent" or
"Claude/AI agent" surfaces in the new entry.

## Commit

`chore(release): v1.4.25`

Single atomic commit on `develop`. No `Co-Authored-By: Claude`
trailer. No `--no-verify`. No `--no-gpg-sign`.

## Draft-PR

URL: https://github.com/MBombeck/HealthLog/pull/168

Opens `develop → main`, draft, title "Release v1.4.25", body carries
the eight feature highlights + test count + migration-safety
statement + CI-trigger note + link back to CHANGELOG.

## CI workflows triggered by the Draft-PR

Observed live on PR #168 within seconds of open
(`gh pr checks 168`):

- `Lint, Typecheck & Test` — pending (from `security.yml`'s
  aggregate workflow — actually defined in the umbrella CI workflow
  on this repo)
- `integration` — pending (`integration.yml`)
- `e2e` — pending (`e2e.yml`)
- `Build linux/amd64` — pending (`docker-publish.yml` matrix branch)
- `Build linux/arm64` — pending (`docker-publish.yml` matrix branch
  on `ubuntu-24.04-arm` runner — first arm64 build of v1.4.25, see
  W11a flag re: cold start)
- `Dependency Audit` — pending (`security.yml`)
- `Secret Scanning` — passed in 6s (`security.yml`)
- `Container Security` — skipped (only runs on container publish, not
  on PR dry-run)
- `auto-merge` — skipped (Draft PR, dependabot-auto-merge no-op)

W11a noted the docker-publish multi-arch matrix is exercised on the
PR without consuming a GHCR tag; a real publish only fires on tag
push or on merge to `main`.

## Stop-point honored

- ✅ No tag created.
- ✅ No push to `main`.
- ✅ Draft-PR open for Marc UAT.

Marc reviews the Draft-PR + CI run, tags + merges himself after his
UAT pass per the handoff §6 Step 4 contract.

## Flags / things to know

- **Draft-PR triggers docker-publish.yml `pull_request` clause** —
  the matrix runs without push (no `:1.4.25` tag in GHCR yet). When
  Marc tags + pushes, the tag-trigger fires the same workflow with
  push enabled. Expect ~12 min cold-start on the `linux/arm64`
  branch (first build on the new `build-arm64-<ref>` cache scope
  per W11a phase report).
- **CHANGELOG order** — Tests block lives between Refactor and
  Deferred-to-v1.4.26 in this release. v1.4.24 carried Tests as a
  trailing block. Either order has CHANGELOG precedent in v1.4.x;
  this release groups Tests with the implementation sections.
- **Deferred-to-v1.5 list reads against the v1.4.23/4 commitments**
  — every v1.5 P1–P5 item from `.planning/v1422-product-lead-review.md`
  is named explicitly so the iOS sprint can cross-reference without
  reading the marathon planning docs.
- **No v1425-backlog.md** — the backlog file is named
  `v1426-backlog.md` per the v1.4.x naming convention (next release's
  open list). CHANGELOG link target reads accordingly.

## Atomic commits

| Commit | Subject |
| --- | --- |
| `cb07d5c` | `chore(release): v1.4.25` |

Pushed to `origin/develop` at 2026-05-14. Draft-PR #168 opened
immediately after push.
