---
file: .planning/round-4-reconcile-rc1-ci-i18n-convention-report.md
purpose: RC1 reconcile report — CI + i18n + convention surfaces for v1.4.27 R4
created: 2026-05-15
target_tag: v1.4.27
branch: develop
contributor: RC1
---

# RC1 — CI + i18n + convention reconcile report

Owns the must-fix findings from R4 reviewers that touch CI, i18n
bundles, and convention surfaces. Six atomic commits on `develop`,
all gates green at each commit boundary, all pushed to origin.

## Findings addressed

### CR-1 — `MAXMIND_LICENSE_KEY` secret missing in the GHCR build pipeline

Source: `.planning/research/v1427-r4-product-lead.md` lines 19-42 (CR-1, release-blocking).

Fix: added a `Fetch GeoLite2 databases` step to `.github/workflows/docker-publish.yml` between the metadata-action and the buildx build-push. The step exports `MAXMIND_LICENSE_KEY` from repo secrets and fails the workflow with a clear `::error::` message when the secret is unset (instead of letting the script silently exit 0 and producing an empty `assets/geolite2/` directory). The Dockerfile COPY at line 78 now lands the real MMDB files, the runtime resolver in `src/lib/geo.ts` resolves geo + ASN locally, and the `/admin/login-overview` carrier column starts populating on the production image.

Commit: `47d20719 fix(ci): wire MAXMIND_LICENSE_KEY into the build workflow and fail fast on missing secret`

### HI-3 — `insights.aiAnalysisTitle` rendered "AI Health Analysis" / "KI-Gesundheitsanalyse" on `/insights`

Source: `.planning/research/v1427-r4-product-lead.md` lines 94-119 (HI-3).

Fix: renamed `insights.aiAnalysisTitle` → `insights.advisorTitle` across all six locale bundles and updated the four call sites in `src/components/insights/insight-advisor-card.tsx`. New copy: EN `Personal health advisor`, DE `Persönlicher Berater`, FR `Conseiller santé personnel`, ES `Asesor personal de salud`, IT `Consulente personale di salute`, PL `Osobisty doradca zdrowotny`. The card now reads in the same voice as the rest of the Coach + advisor surfaces; no `AI` / `KI` substring remains.

Commit: `3b045d6f chore(insights): rename the advisor title key to neutral phrasing across six locales`

### ME-1 + ME-2 — forbidden words in translation values

Source: `.planning/research/v1427-r4-product-lead.md` lines 125-159 (ME-1 + ME-2).

Fix: rewrote two strings across all six locale bundles to neutral wording.

- `account.timezoneHint`: `"AI Coach context"` / `"AI-Coach-Kontext"` → `"Coach context"` / `"Coach-Kontext"`. FR/ES/IT/PL inherit the EN form (already English fallbacks before this round; left untouched per the wider 1,664-row partial-translation residue queued in the v1.4.28 backlog).
- `i18n.maintainershipBanner.notice`: the AI-authorship disclosure was recast as `"machine-translated"` / `"maschinell übersetzt"` / `"traduite automatiquement"` / `"traducido automáticamente"` / `"tradotta automaticamente"` / `"tłumaczona maszynowo"`. Operational meaning preserved; no `AI` / `KI` / `IA` substring remains in the notice copy.

### ME-3 + ME-4 — vendor-label exemptions documented

Source: `.planning/research/v1427-r4-product-lead.md` lines 161-200 (ME-3 + ME-4).

Fix: appended a `## Convention-compliance exemptions` section to `docs/audit/v1427-summary.md` recording the two exempt-by-necessity labels (provider-chooser dropdown `Anthropic (Claude)` + GitHub URL `MBombeck/HealthLog` on `/about`) with the rationale so future audits stop re-flagging the same finding.

Commit (ME-1 + ME-2 + ME-3 + ME-4 documentation): `7850976b chore(i18n): replace remaining assistant-product references with neutral terms across six locales`

### P0-1 — mid-string interpolation spacing drift on 10 keys

Source: `.planning/research/v1427-r4-i18n.md` lines 31-75 (P0).

Fix: restored space-flanked connectors on all 10 keys across FR/ES/IT/PL, and translated the surrounding nouns natively in the same pass. Keys closed: `measurements.pageInfo`, `mood.pageInfo`, `medications.pageInfo`, `admin.section.auditLog.pageOf`, `admin.showingEntries`, `onboarding.tour.stepOf`, `gettingStarted.progress`, `targets.consistency.daysInRange`, `targets.consistency.daysLogged`, `targets.summary.weekTitle`. Drift-guard test stays green (69/69 pass); a follow-up tightening to assert `/[A-Za-zÀ-ÿ]\{|\}[A-Za-zÀ-ÿ]/` returns no match is queued in the v1.4.28 backlog.

Commit: `815f31a3 fix(i18n): restore interpolation spacing on pagination and counter keys across FR/ES/IT/PL`

### P0-2 — GLP-1 dashboard tile English-leak on FR/ES/IT/PL

Source: `.planning/research/v1427-r4-i18n.md` lines 77-111 (P0).

Fix: translated four `dashboard.glp1.*` keys to native phrasings on FR/ES/IT/PL.

- `lastInjection`: FR `Dernière injection`, ES `Última inyección`, IT `Ultima iniezione`, PL `Ostatnia iniekcja`.
- `nextInjection`: FR `Prochaine injection`, ES `Próxima inyección`, IT `Prossima iniezione`, PL `Następna iniekcja`.
- `weightDelta`: FR `depuis le début`, ES `desde el inicio`, IT `dall'inizio`, PL `od początku`.
- `inDays`: FR `dans {count} jours`, ES `en {count} días`, IT `tra {count} giorni`, PL `za {count} dni`.

Commit: `9266e405 fix(i18n): translate the GLP-1 dashboard tile copy across FR/ES/IT/PL`

### HI-1 — `.planning/v1428-backlog.md` incomplete

Source: `.planning/research/v1427-r4-product-lead.md` lines 47-68 (HI-1).

Fix: appended a comprehensive deferral catalogue to `.planning/v1428-backlog.md` covering every Medium+ / Low item the nine R4 reviewers explicitly tagged for v1.4.28. New sections:

- `From mobile-fix plan v1.4.27 (R3c → R3d MB1-MB7)` — CF-77 through CF-90 plus CF-20 cross-reference.
- `From R4 simplifier` — F-H1 + F-M1..7 + F-L1..9 grouped under the v1.4.28 simplification micro-bucket.
- `From R4 senior-dev` — HIGH-1, HIGH-2, MED-1..4, Dialog drift cleanup, RHF deps.
- `From R4 design` — M1 through M12 (Medium-priority polish queue).
- `From R4 UI-conformity` — 11 admin section heading divergence, 21 SectionCard candidates, 18 spinner palette variations, two tab-strip implementations, Sleep InsightStatusCard miss, admin feedback-inbox card list parity.
- `From R4 product-lead — vendor label exemptions` — pointer to `docs/audit/v1427-summary.md`.
- `From R4 i18n — partial-translation residue across the wider bundle` — 1,664-row prioritisation + three drift-guard tightening proposals.
- `From R4 dead-code` — 14 orphan exports + stale Vitest mock + 2 cosmetic comments.

Every entry carries source reviewer + finding ID, severity, summary, recommended fix, effort estimate, and why-deferred rationale.

Commit: `67fddb98 docs(planning): append v1.4.28 backlog with R4 reviewer deferrals`

## Commit ledger

| Commit | Subject |
|---|---|
| `47d20719` | `fix(ci): wire MAXMIND_LICENSE_KEY into the build workflow and fail fast on missing secret` |
| `3b045d6f` | `chore(insights): rename the advisor title key to neutral phrasing across six locales` |
| `7850976b` | `chore(i18n): replace remaining assistant-product references with neutral terms across six locales` |
| `815f31a3` | `fix(i18n): restore interpolation spacing on pagination and counter keys across FR/ES/IT/PL` |
| `9266e405` | `fix(i18n): translate the GLP-1 dashboard tile copy across FR/ES/IT/PL` |
| `67fddb98` | `docs(planning): append v1.4.28 backlog with R4 reviewer deferrals` |

All six commits pushed to `origin/develop`.

## Gate status

Per-commit gates run at each boundary:
- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm vitest run src/lib/__tests__/i18n-locale-integrity.test.ts src/__tests__/i18n-drift-guard.test.ts src/lib/i18n/__tests__/format-locale-order.test.ts` — 3 files, 69 tests, 0 failures.
- `pnpm vitest run src/components/insights/__tests__/insight-advisor-card.test.tsx` — 13/13 pass after the title key rename.

## Coordination notes

- Other contributors' in-progress edits (RC2 `mood-list.tsx`, RC3 `measurement-list.tsx` + workouts route + form-stack changes, plus several lib-side reshapes) were observed in the working tree throughout the round. Each was left untouched and only RC1's own files were staged for every commit. The commit log shows RC2/RC3 commits interleaved with RC1 commits — no merge conflicts surfaced because the file sets were touch-disjoint per the coordination plan.
- The v1.4.27 vendor-label exemptions doc was placed in `docs/audit/v1427-summary.md` rather than a new `messages/_meta/forbidden-words.md` because the canonical convention surface does not exist yet; the backlog file points the next round at the migration if and when that surface lands.
