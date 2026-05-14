# v1.4.25 Handoff — neue Claude-Session

Erstellt: 2026-05-14 ca. 14:30. Kontextstand der vorherigen Session: 79% verbraucht.
Nächste Session liest diesen File zuerst, dann `.planning/STATE.md`, dann die in §3 gelisteten Phase-Reports.

---

## 1. Was bereits gelandet ist auf `develop`

| Wave | Was | Commit-Range / Letzte SHA |
| --- | --- | --- |
| W0 | develop ↔ main sync (post v1.4.24 hotfix) | `ac54bb2` |
| W2 | CI red-fix (coach-prefs URL mock + e2e Pixel-5 Selektoren) | `10dd2fc`, `25477e8`, `4cb8ba3` |
| W3 + W3b | Insights polish (duplicate StatusCard weg, regenerate-Icon in Tab-Strip, trends-row equal-height + mood-grid parity, score-card breath, x-axis density) | `3e9881f`, `72e64c8`, `6054180`, `75cf0b6`, `80544b7` |
| W3e | Zielwerte komplett redesigned (10 Phasen, neue Card-Primitive, consistency-strip, Coach-Handoff conditional auf AI, mobile-first 3-col) | `86a52da` → `ebde50d` |
| W3f | Polish wins (per-card cog Zielwerte, comparison-overlay grey-out, orphan endpoint cleanup, sleep-stages per-night) | `edae569`, `7b6b916`, `7846d68`, `6f04123` |
| W4 | Insights Sub-Pages (7 Routen: blutdruck/gewicht/puls/stimmung/medikamente/bmi/schlaf, shared tab-strip, mother-page schlank) | `38bbba1`, `959adec`, `cb825ec`, `7644bd0/84b54d9`, `d63fa27`, `347c4f1` |
| W4b | `DELETE /api/measurements/by-external-ids` für iOS HealthKit Deletion-Sync | in `959adec` |
| W4c | Sleep sub-page UI + Stacked-Bar | `cb825ec`, `7846d68` |
| W4d | GLP-1 full integration (10 Phasen: `Medication.treatmentClass`, `MedicationDoseChange`, `InjectionSite`, body-map picker, dashboard tile, weight-chart markers, therapy timeline auf `/insights/medikamente`, plateau-detection, doctor-report GLP-1 section, PROMPT_VERSION 4.25.0 mit GROUND RULE 9) | `cbcc059` → `03f58c7` |
| W4d-tests | RTL component tests (medication-card-glp1 + injection-site-picker, +25 tests) | `f9621e4`, `7c720e8` |
| W4e | medication_schedules @map snake_case (Migration 0047) | `8b79ed8` |
| W5 | Coach polish (7 items: chip-order, evidence-labels weg, default-window-pref, header alignment, mic weg, composer auto-grow, distinct error UX) | `1895fd3` → `d631502` |
| W5b | AI token-leak Audit (stripChartTokens regex erweitert, alle AI-prose surfaces durchverdrahtet, GROUND RULE 13/8 Prompt-side, PROMPT_VERSION 4.24.0) | `5deed3f`, `a19768c`, `feeff38` |
| W5c | Withings API coverage audit + interim wins (meastypes 12/35/71/123 + BP/temp webhook subscription — BP latency von 1h auf Sekunden) | `ae8e2d7` → `a732b19` |
| W5d | Withings full coverage (7 neue MeasurementType enum values, meastypes 5/8/76/91/155/170, OAuth scope upgrade `user.activity`, reconnect banner, Migration 0049+0050) | `c50931b`, `7846d68 (mappings)`, `5a96128` |
| W5e | Cross-source dedup architecture (`User.sourcePriorityJson` JSONB, Zod schema + DEFAULT_SOURCE_PRIORITY, analytics `pickCanonicalSource()` helper, Settings → Sources UI, Migration 0048) | in `03f58c7`/`98f7d11` |
| W6 | Dashboard fixes (Settings-save Zod v4 record-bug fix, comparison-shift e2e, global default raus, weight-chart vertical injection markers, GLP-1 tile mounted) | `c2fc95f`, `861fe7a`, `6047e52`, `1332342`, `88efd42` |
| W6c | Doctor-Report toggles (per-section UI, mood default OFF + server filter, hide-when-empty, Migration 0045, PUT /api/auth/me/doctor-report-prefs) | `7c06b89`, `5cb4a1d`, `759fdae`, `64d50fd`, `d51e488` |
| W7 | Per-User-Timezone Option B (6 of 10 surfaces: CSV-export ISO-offset, formatters, profile picker, admin default, signup browser-detect, doctor-report PDF) | 11 commits ending `aea39d9` |
| W7b | Timezone deferred surfaces (alle 4 weiteren: berlinDayKey 5 callers, chart x-axis prop threading, Coach snapshot tz-aware, MoodEntry.tz column Migration 0044) | `35f068a`, `eeaa563`, `7d878c1`, `989243a`, `2bdfdc2`, `a66c044` |
| W8b | Admin Login-Übersicht (Standort restore, Provider column, CSV cleanup, collapse removal) | `6d6f4c4`, `b5062ea`, `d87a631`, `095578f` |
| W9 | Repo polish (README hero, description, topics 10→18, homepage → demo, Discussions on, branch protection v2 mit conversation resolution, Issue #167 comment posted) | `ef03705`, `044f971` |
| W9b | Branch protection v1 minimal | gh-api |
| W9c | CONTRIBUTING translations section | `2668020` |
| W9d | i18n integrity test auto-discovers locales + fallback-chain runtime test | `57bd445` |
| W11b | Demo-Server `demo.healthlog.dev` auf v1.4.24 deployed (GHCR image, Coolify-built-from-git → GHCR-image-based switched, fresh DB mit 60-Tage Seed-Daten, demo / demo123demo123 als Admin) | external (edge-01) |
| Plus | Dependabot Action-PRs 163/164/166 MERGED via `gh pr merge` nach Marc's `gh auth refresh -s workflow` | merged |

**Test count Progression**: 2244 → **2537 unit + ~140 integration** (+293 unit). Demo läuft. v1.4.24 tagged.

---

## 2. Was noch zu tun ist — DAS hier ist der Arbeitsauftrag für die neue Session

In **strikter Reihenfolge**, NICHT parallel (jede Wave braucht stabilen Tree davor):

### W8 — Settings + Admin + cross-page consistency + mobile-first audit

Eine fokussierte Wave die ALLE Surfaces durchgeht:

1. **Settings icon+heading stringency**: Marc directive 2026-05-14 — „in Benachrichtigung ist 'Kanalzuverlässigkeit' ohne Icon davor; in anderen Sektionen nur Icon ohne Heading". Pick eine Convention (Vorschlag: **Icon + Heading durchgängig** für a11y) und apply uniform über alle `src/components/settings/*-section.tsx` + `src/components/admin/*-section.tsx`. Quick-grep: `src/components/settings/notification-status-card.tsx` ist der konkrete Beispielfall den Marc nannte.

2. **Coach-feedback admin header layout-shift fix**: Marc directive — „klicken auf Coach-Feedback verschiebt die Seite, andere Admin-Sections nicht". Sticky-header consistency, padding parity, font-size parity across `src/app/admin/[section]/page.tsx` renderer.

3. **Mobile-first audit über ALL surfaces**: Pixel-5 Width (393px) sweep aller Pages — hide-when-not-essential rule angewandt. Plus iPad-portrait check. Plus desktop ≥1024px sanity.

4. **Font / size / padding parity across pages**: Marc directive — „mir ist diese Symmetrie halt wichtig". Top-padding nach Top-Nav, h1/h2 size, section spacing — alles dokumentiert + uniform.

5. **W8 Conflict-cleanup**: The merge resolution at `98f7d11` took --ours for 7 conflicted files. Wenn ein Agent dabei legitime Stashed-Changes verloren hat (Login-Overview hat 7 conflicts gehabt), diese aus den Phase-Reports rekonstruieren. Konkret prüfen: `src/components/admin/login-overview-section.tsx` (W8b lieferte Standort + Provider + CSV + Collapse-Removal — alle vier Bug-fixes sind in den Phase-Reports beschrieben).

**Output**: `.planning/phase-W8-v1425-cross-page-consistency-report.md` + atomic commits.

### W9e — FR + ES + IT + PL AI-translation + maintainership banner

Marc directive: **alle 6 Sprachen in v1.4.25** (Option B).

- AI-translate `messages/en.json` → `messages/fr.json` + `es.json` + `it.json` + `pl.json` (~1500 Keys × 4 = ~6000 Übersetzungen). En ist source-of-truth (parität test enforced).
- Coach-Prompts EN → FR/ES/IT/PL (`src/lib/ai/prompts/coach-prompt.ts` + `insight-generator.ts` — beide haben DE + EN bodies; 4 weitere Sprachen)
- PDF doctor-report strings (i18n der Section-Titel + Disclaimer)
- OG/Twitter meta tags (Landing repo separat — `/Users/marc/Projects/healthlog-landing/`)
- **MaintainershipBanner Component** (`src/components/i18n/maintainership-banner.tsx`) — rendert auf non-maintained locales (FR/ES/IT/PL) eine kleine Hinweis-Leiste mit Link auf GitHub-Translation-PR-Workflow. EN + DE haben keinen Banner.
- LocalePicker in Profile-Settings erweitert auf 6
- Browser-locale-detect auf signup supports `fr|es|it|pl`
- Existing i18n-integrity-test (`src/lib/__tests__/i18n-locale-integrity.test.ts` — schon auto-discovering seit W9d) wird automatisch grün/rot für die neuen Locales

**Output**: 6 atomic commits (1 per Locale + 1 banner-component + 1 LocalePicker + 1 phase report). Phase-report `.planning/phase-W9e-v1425-translations-report.md`.

**PL-Hinweis**: AI-Übersetzungs-Qualität für PL ist typischerweise schwächer (Genus + Aspekt). Banner-CTA besonders prominent.

### W10 — Freeze-quality Multi-Agent QA (KRITISCH)

Marc directive 2026-05-14: „**alles funktioniert, nichts mehr blockt, alles deferred ist explizit dokumentiert**". v1.4.25 ist letzter Patch vor iOS-Freeze.

10 Checks (siehe Task-Description #20 in der vorherigen Session):

1. **code-reviewer** Agent — full diff review von develop seit v1.4.24 (~50+ commits)
2. **security** review — full surface scan, alle neuen Endpoints, GLP-1-Prompt-Refusal-Guardrails, Withings OAuth-scope-handling, source-priority privacy implications
3. **design / UX** review — alle neuen Components, responsive viewports, color tokens, a11y
4. **senior-dev** review — architektonische correctness, edge cases, schema migrations (0044–0050 alle landed)
5. **simplify** review — propose simplifications, kill duplicate code
6. **product-lead** review — strategisches alignment, iOS-readiness statement
7. **dead-code audit** — every imported-but-unused, every component without callers, every endpoint without frontend, every i18n key without rendering site. **The orphan `/api/insights/general-status` route already deleted in W3f Win 3** — re-check ob noch ähnliche.
8. **i18n end-to-end test** — switch app auf fr/es/it/pl in test, jede Page rendert ohne raw-key fallbacks
9. **All tests green** — unit (2537+) + integration (140+) + e2e workflow on main must NOT be failing when v1.4.25 release-merges. Bekanntes carry-over: pre-existing coach-snapshot failures (16) wenn die noch da sind aus parallel-agent enum-drift — müssen vor W11 gefixt werden.
10. **Reconcile pass — ALL Medium + High + Critical findings APPLIED before tag**, nur LOW/stylistic deferrals nach v1.4.26 mit explicit `.planning/v1425-backlog.md` entry.

**Output**: 6 Review-Reports + 1 Reconcile-Report. `.planning/phase-W10-v1425-qa-reconcile-report.md`.

### W11 — Release-Prep v1.4.25 (KEIN TAG, KEIN MAIN-PUSH)

Marc directive — **NICHT taggen, NICHT auf main pushen**. Marc wants to verify before tag.

1. `package.json` version 1.4.24 → 1.4.25
2. CHANGELOG.md entry — gigantisch (sehr viele Features). Sections:
   - **Added** (Insights sub-pages, Sleep UI, Doctor-Report toggles, GLP-1 full integration, source-priority architecture, Withings full coverage incl. body-comp + OAuth scope, FR/ES/IT/PL locales, Maintainership banner, batch-delete endpoint, ...)
   - **Changed** (Targets redesign, Coach polish, Dashboard global default removed, schema @map snake_case, ...)
   - **Fixed** (Settings-save Zod regression, BP webhook latency 1h→s, AI metric token leaks, comparison-baseline data correctness, admin Login-Übersicht 4 bugs, ...)
   - **Security** (GROUND RULE 9 dose-refusal, source-priority privacy clarity, OAuth-scope user.activity gates, ...)
   - **Refactor** (insights-tab-strip extraction, useResettableValue Coach drawer cleanup, mood verbal labels, ...)
   - **Deferred to v1.4.26** (Onboarding rebuild, Withings Activity sync routine, Withings Sleep v2 routine, GLP-1 RTL polish, medication_schedules backlog cleanup, ...)
   - **Deferred to v1.5** (iOS launch P1-P5, Withings ECG/AFib/Workouts, Coach extended for HRV/Sleep/Resting HR/Steps, ...)
3. Single commit `chore(release): v1.4.25` auf develop
4. **Marc-Voice**: KEIN `Co-Authored-By: Claude` trailer. Schreibstil = professional, terse, technical, never overselling.
5. Open Draft-PR develop → main mit Title „Release v1.4.25" und CHANGELOG-Highlights als Body. PR triggert ALLE Workflows (e2e, integration, security, docker-publish-on-pr) → verify-all-green.
6. **STOP HERE**. Marc reviewt + tagged selbst nach UAT.

### W12 — Final repo + docs + website deploy audit (Marc directive: own phase)

NACH dem Tag erst:
1. Demo-Server redeploy zu v1.4.25 via SSH `edge-01` + `docker compose up -d --force-recreate app` (compose ist schon auf GHCR pinned aus W11b — nur Tag-Bump auf v1.4.25 statt v1.4.24)
2. healthlog-docs Site verify (image pins update auf 1.4.25 — 3 Stellen wie in v1.4.23 release, plus ai-insights callout für die neuen v1.4.25 features)
3. healthlog-landing softwareVersion JSON-LD bump auf 1.4.25
4. GitHub repo config sweep — alle gh-api Calls aus W9 verifizieren, FUNDING.yml + Social-Preview-Image entscheiden (Marc-Decision nötig), branch-protection required-status-checks **flippen jetzt** (CI ist grün nach W10)
5. DNS + HTTPS verify auf docs.healthlog.dev + healthlog.dev + demo.healthlog.dev + healthlog.bombeck.io

**Output**: `.planning/phase-W12-v1425-holistic-audit-report.md`.

### W13 — Final deliverables for Marc

1. `docs/audit/v1425-summary.md` — Marc-Brief im Stil von v1421-summary.md (v1422 + v1423 existieren auch — read for tone). Sections: Release brief (lead, was sich an v1.4.x ändert), Live state (URL + image digest + version transition + deploy path + GH release URL + branch model), Smoke verification, What shipped (Wave-by-Wave overview W1–W13), iOS-readiness statement (cross-link auf `.planning/phase-W6-v1423-product-lead-review.md` section C — die ist immer noch der v1.5 P1 plan), Branch model note, Carry-overs (deferred items aus v1.4.26 backlog), Strategic next.
2. **0-10 Score per area**: Insights / Dashboard / Coach / Settings / Admin / Mobile / Tests / CI / Docs / Repo / Demo. Marc explicit asked for this.
3. **Codex audit prompt**: schreib einen prompt für Marc, den er an Codex (OpenAI) geben kann. Fokus: TypeScript-Typprüfung-Edge-Cases, Next.js routing edge cases, Prisma migration safety auf den 6 neuen Migrations (0044-0050). Plus die Bereiche wo Marc Codex stärker findet als andere AI: dead-code-detection, refactoring-suggestions.
4. **iOS handoff doc** für die parallele Claude-Session die das iOS-App-Repo macht: `.planning/v15-ios-handoff.md` mit alle locked-server-contracts (Apple Health batch ingest, APNs scaffolding, OpenAPI 3.1 spec, device-management endpoints, source-priority defaults für Apple Health passthrough, GROUND RULE 9 Coach refusal guardrails — alles was iOS Tag-1 brauchen wird).

---

## 3. Phase-Reports zu lesen für Kontext

In dieser Reihenfolge wenn du tiefer einsteigen willst:
- `.planning/STATE.md` — laufender State (UPDATE NÖTIG — schreibt jeder Wave-Owner einen Tick)
- `.planning/ROADMAP.md` — Milestone-Roadmap
- `.planning/v1425-handoff.md` — DIESER File
- `.planning/feature-user-timezone.md` — design doc (Marc-Direktive 2026-05-14)
- `.planning/research/withings-api-coverage.md` — Withings audit
- `.planning/research/insights-sub-pages-ux.md` — Insights UX research
- `.planning/research/zielwerte-redesign.md` — Targets research
- `.planning/research/glp1-injection-tracking.md` — GLP-1 research
- `.planning/research/withings-plus-comparison.md` — Competitive intel
- `.planning/phase-W*-v1425-*-report.md` — Jeder W*-Wave-Report (W2, W3+W3b, W3e, W3f, W4, W4d, W4d-tests, W5, W5b, W5c, W6, W6c, W7, W7b, W8b, W9)
- `.planning/v1423-backlog.md` + `v15-backlog.md` — what's queued for v1.4.26 + v1.5

---

## 4. Kritische Konstanten / Konventionen

- **Branch-Model**: `develop` ist daily target. `main` ist release-only. Release-merge mit `--no-ff` + tag.
- **NO `Co-Authored-By: Claude` trailer** auf Commits (ab v1.4.25 Marc-Voice-Directive).
- **NO `--no-verify`, NO `--no-gpg-sign`**.
- **Marketing-Voice**: never expose Claude/AI-as-author/marathon/phase in user-facing artifacts (CHANGELOG, GH release notes, docs, in-app copy, Show HN draft, awesome-selfhosted PR).
- **Mobile-first** durchgängig: Pixel-5 width = ground truth. Hide-when-not-essential rule.
- **i18n integrity**: jeder Key in en.json muss in jeder anderen Locale exakt 1× existieren (parity test ist enforced).
- **Migration numbering**: nächste freie ist **0051**. (0044=MoodEntry.tz, 0045=doctorReportPrefs, 0046=GLP1, 0047=med_sched @map, 0048=sourcePriority, 0049=Withings_full, 0050=Withings_scope).
- **PROMPT_VERSION**: 4.25.0 (von 4.24.0 in v1.4.24 → 4.25.0 in v1.4.25 wegen GROUND RULE 9 GLP-1-dose-refusal).
- **Source-Priority Defaults** (Marc bestätigt 2026-05-14):
  - Cumulative + Sleep + HRV + RHR: APPLE_HEALTH > WITHINGS > MANUAL
  - Point measurements (weight, BP, pulse, body-fat, body-temp, SpO2, VO2 max): WITHINGS > APPLE_HEALTH > MANUAL
- **Marc-Direktive zu GLP-1**: „komplett rein in v1.4.25, nichts brickt, harmonisch einlistet, KEIN Chart in der Medikamenten-Seite — Chart NUR auf Dashboard + Insights `/medikamente`".
- **Marc-Direktive zu Sprachen**: 6 Locales in v1.4.25 (EN/DE maintained + FR/ES/IT/PL AI-initial mit MaintainershipBanner).
- **Marc-Direktive zu Onboarding**: in v1.4.26 (promoted from v1.5).
- **Marc-Direktive zu Withings**: alle v1.4.26-cheap-wins in v1.4.25 vorgezogen. **Activity sync routine bleibt v1.4.26** (separate Wave wegen OAuth-Reconnect-User-Impact).

---

## 5. Bekannte offene Risks / Test-failures auf develop HEAD

Zum Zeitpunkt des Handoffs:
1. **Pre-existing coach-snapshot failures** (~16) — gemeldet von mehreren Agents als „enum drift aus parallel-agent Withings additions". Sollte sich auflösen wenn W10 die test files mit den neuen MeasurementType-Werten in Sync bringt.
2. **measurements-batch-delete integration test** scheint einen duplicate-seed unique constraint zu treffen — flagged by W7b agent. Klein, in W10 mit-fixen.
3. **The 5-conflict resolution at commit `98f7d11`** took --ours für 7 files. **Login-Overview-Section hatte 7 conflicts** — verify dass alle vier W8b bug fixes (Standort, Provider, CSV cleanup, Collapse-Removal) noch da sind. Check via `git log -p src/components/admin/login-overview-section.tsx` und die `phase-W8b` Tests. Falls was fehlt — aus W8b Phase-Report re-apply.

---

## 6. Konkrete Anleitung für Marc — SO startest du die neue Session

### Step 1: Diese Session schließen

Nichts zu tun — die Session-Endrunde habe ich (Marc-Voice CHANGELOG für „heute Nacht" gibt's noch nicht, aber die phase reports + dieser handoff sind komplett).

### Step 2: Neue Claude-Session starten

Im Terminal:
```bash
cd /Users/marc/Projects/HealthLog
claude
```

### Step 3: Die neue Session begrüßen mit GENAU dieser Nachricht:

```
Wir setzen v1.4.25 fort. Lies zuerst .planning/v1425-handoff.md — das ist der Übergabe-Stand. Dann arbeite in dieser strikten Reihenfolge:

1. W8 cross-page consistency + Settings/Admin icon-heading + mobile-first audit
2. W9e FR + ES + IT + PL AI-translation + maintainership banner
3. W10 Freeze-quality multi-agent QA (6 reviews + dead-code + i18n + reconcile)
4. W11 Release-prep v1.4.25 (NO TAG, NO MAIN PUSH — Draft-PR develop→main für CI verify)
5. W12 Final repo+docs+website audit + Demo redeploy zu v1.4.25
6. W13 Final deliverables (v1425-summary.md, 0-10 Score, Codex audit prompt, iOS handoff)

Wichtig:
- NO Co-Authored-By: Claude trailer auf Commits (Marc-Voice ab v1.4.25)
- Sechs Sprachen in v1.4.25 (EN+DE maintained, FR+ES+IT+PL AI-initial mit Banner)
- Kein --no-verify
- Multi-Agent QA muss ALLE Medium+High+Critical findings applied haben vor Tag
- Demo-Server demo.healthlog.dev redeploy in W12 (compose schon auf GHCR pinned)
- Marc reviewt v1.4.25 vor dem Tag — also bei W11 stop bei Draft-PR

Status check: git status, git log --oneline -5, pnpm typecheck, pnpm lint, pnpm test (erwartetes Baseline 2537 unit pass + ~16 pre-existing coach-snapshot enum-drift failures die W10 mitfixt).

Wenn du verstanden hast, fang mit W8 an.
```

### Step 4: Marc-spezifische Aktionen die du selbst machen musst (nicht der Agent)

| Wann | Was |
| --- | --- |
| **Vor W10** | Nichts |
| **In W11** | Falls Draft-PR-CI alle grün ist: dem Agent „Tag jetzt v1.4.25" geben. Falls nicht: blockierende Findings durchsprechen, dann ja/nein |
| **In W12** | Falls FUNDING.yml gewünscht: dem Agent das `.github/FUNDING.yml` skeleton geben (oder „skip"). Social-Preview-Image: musst du via GitHub-UI hochladen (Settings → Options → Social preview). |
| **Nach W13** | v1425-summary.md selber durchlesen, dann GH-Release create approven, dann production-deploy verifizieren (apps01 Coolify + edge01 Demo) |

### Step 5: Was die neue Session NICHT machen darf

- Tag v1.4.25 ohne deine explizite Zustimmung
- Push auf main ohne deine explizite Zustimmung (force-push schon gar nicht — branch-protection blockiert das aber)
- Demo-Datenbank wipen ohne backup
- healthlog-marketing / healthlog-docs / healthlog-landing pushes ohne dein OK (Marc reviewt sister-repo commits)
- React PR #155 mergen — der braucht noch dependabot-rebase für dual react-dom bump
- Co-Authored-By: Claude trailer einbauen

---

## 7. Daten + URLs zur Hand

- Repo: https://github.com/MBombeck/HealthLog
- Production: https://healthlog.bombeck.io (apps01 — `pg8wggwogo8c4gc4ks0kk4ss`)
- Demo: https://demo.healthlog.dev (edge01 — `ck8cs4osswg8w440gskw08w8`, credentials `demo` / `demo123demo123`)
- Docs: https://docs.healthlog.dev (edge01 — `g4ok4ow8os8s0os88so44ckw`)
- Landing: https://healthlog.dev (edge01 — `o8g80o008scc48c884coo0kk`)
- Edge01 SSH: `ssh edge-01` (alias in `~/.ssh/config`)
- Apps01 SSH: `ssh root@apps-01` (production)
- Open dependabot PR (still open after W9): https://github.com/MBombeck/HealthLog/pull/155 (React 19.2.5 → 19.2.6 — needs react-dom dual-bump)
- Issue #167 (already commented, open for close after release): https://github.com/MBombeck/HealthLog/issues/167
- Marketing folder: `/Users/marc/Projects/healthlog-marketing/` (7 files, including small-wins.md + show-hn-draft.md)

---

Viel Erfolg in der neuen Session. Marc — bei W11 anhalten und mich/UAT bevor Tag. Alles ist dokumentiert; der nächste Claude weiß alles was ich weiß.
