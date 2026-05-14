# W10 i18n Runtime Gaps — v1.4.25 Reconcile Input

Generated 2026-05-14 by the W10 reconcile probe. Read-only — no code commits.

## Scope and methodology

HealthLog ships two locale catalogs:

- `messages/en.json` — 2 556 leaf keys, 3 002 source lines.
- `messages/de.json` — same 2 556 keys (parity already enforced by
  `src/lib/__tests__/i18n-locale-integrity.test.ts`).

`t(key)` is provided by the React `I18nProvider`
(`src/lib/i18n/context.tsx`) and a server-side mirror in
`src/lib/i18n/server-translator.ts`. Both fall back to the EN catalog
when DE is missing the key, and ultimately render the raw key string
when neither catalog has it. The W9d test enforces *catalog parity* but
does **not** verify that `t()` calls in code actually have catalog
entries, nor that catalog entries are still referenced.

This probe ran three complementary analyses against `develop` HEAD:

1. **Static call-site sweep** — every `t("…")`, `t('…')`, and
   `t(\`prefix.${"$"}{var}\`)` invocation in `src/**/*.{ts,tsx}` (582
   files after excluding `node_modules`, `.next`, `__tests__`,
   `generated`).
2. **Indirect-key sweep** — every plain string literal in code whose
   shape (`a.b.cD`) matches a known catalog key, because HealthLog
   ships dozens of `titleKey: "settings.sections.account.title"`
   patterns where the key never appears inside a `t()` call directly.
3. **Template-prefix sweep** — every backtick template whose
   pre-interpolation prefix matches at least one catalog key
   (`achievements.badges.${prefix}${target}.title`, etc.).

A **runtime Playwright probe** of every major route in both locales
was attempted (Task 2 + 3 in the brief). Both `next dev` modes failed
to boot a working server:

- Turbopack (default) — `globals.css:3107` Tailwind v4 ring/color-mix
  PostCSS parse error → every request returns 500.
- Webpack — boots, but `src/lib/api-handler.ts:56` crashes on
  `request.method` access ("Cannot read private member #state from an
  object whose class did not declare it") on every request, including
  `/auth/login` and `/api/version`, so no route renders.

The dev server is broken on `develop` HEAD. Task 2 + 3 were skipped
per the spec's fallback clause; Tasks 1 + 4 cover the actionable
findings. **A separate ticket should be filed for the dev-server
breakage** — it blocks every form of manual / Playwright testing.

The three analyzer scripts live in `/tmp/w10-i18n-*.mjs` (not
committed) for reproducibility.

## Static analysis findings

| metric | count |
| --- | --- |
| EN catalog keys | 2 556 |
| DE catalog keys | 2 556 |
| Distinct keys referenced (literal + indirect + template) | 2 151 |
| Keys referenced but **missing from both catalogs** | 1 |
| Catalog keys **never referenced** anywhere in code | 405 |
| Interpolation-parameter mismatches between EN and DE | 0 |
| Dynamic-prefix call sites | 44 |

### Missing key — must fix before v1.4.25

| key | call site | impact |
| --- | --- | --- |
| `comparison.toggleHint` | `src/components/settings/dashboard-layout-section.tsx:239` | Renders the literal string `comparison.toggleHint` as the helper text below the "Compare to" baseline picker on `/settings/dashboard`. Both EN and DE leak the raw key. The neighbouring keys `comparison.toggleLabel`, `comparison.baseline.{none,lastMonth,lastYear}` exist; only `toggleHint` was forgotten when the helper-text paragraph was added. |

(The three `empty.measurements.{title,description,add}` keys that the
naive regex also flagged are **JSDoc example references** inside
`src/components/ui/empty-state.tsx:15-17`, not real call sites — false
positive, no fix needed.)

### Interpolation parity

Every key that exists in both catalogs uses the same `{param}` set on
both sides. No DE → EN regression where DE expects `{change}` and EN
expects `{delta}` or similar. This is the W9d test's biggest blind
spot; it is currently clean.

### Locale-switch behaviour

Static review of `I18nProvider` and `getServerTranslator` confirms
they fall back EN→key when a DE entry is missing, and EN→key when
both are missing. With catalog parity guaranteed by the W9d test and
zero interpolation mismatches, a runtime switch from EN to DE on any
page **cannot** produce a key-as-string leak for any of the 2 555
catalog-known keys. The only EN-only-then-key-fallback path is the
single missing `comparison.toggleHint` above, which fails identically
in both locales.

## Dead catalog keys

405 keys exist in both `messages/en.json` and `messages/de.json` but
are not referenced anywhere in the source — neither inside a `t()`
call, nor as an indirect `titleKey: "…"` string literal, nor as a
template-built dynamic key. They are dead weight: every translator
pays for them, the bundle ships them, the W9d parity test guards them.

Top namespaces:

| namespace | dead-key count | rationale |
| --- | --- | --- |
| `settings.*` | 114 | Old setup screens replaced by `settings/[section]` route. Examples: `settings.title`, `settings.subtitle`, `settings.kiInsightsBenefitsTitle`, `settings.openAdminConsole`, `settings.tokenCreatedAt`, `settings.withingsConnected`. The `settings.ai.*` cluster alone has 30 leftover provider-test labels (e.g. `testConnection.button`, `testConnection.successTitle`). |
| `classifications.*` | 69 | The `classifications.alerts.*` group (26 keys, `bmiBelowNormalTitle` etc.) and the per-metric leaf labels (`classifications.bp.Optimal`, `classifications.bmi.Underweight`…). The classification UI now uses `targets.status.*` / `targets.label.*`; the legacy catalogue branches were never deleted. |
| `admin.*` | 40 | Replaced by `admin/[section]` shell. `admin.bugReportConfigured`, `admin.dangerZone`, `admin.monitoring`, `admin.section.auditLog.*`, `admin.webPushVapid`, `admin.version`, `admin.gitCommit`, etc. |
| `medications.*` | 30 | `medications.takeMedication`, `medications.reminderTitle`, `medications.intakeRecorded`, etc. Likely orphans from the v1.4.18 medications redesign. |
| `onboarding.*` | 21 | Steps that were merged or removed during the v1.4.22 onboarding rewrite. |
| `charts.*` | 19 | `charts.avg7dShort`, `charts.bucketWeekly`, `charts.days30/90/365`, `charts.compliance` — chart-label slugs left over from the v1.4.20 insights redesign. |
| `dashboard.*` | 15 | `dashboard.greeting`, `dashboard.nextSteps`, `dashboard.glp1.*` (2 keys). |
| `bugreport.*` | 12 | `bugreport.attachScreenshot`, `bugreport.notConfiguredAdmin`, `bugreport.viewOnGithub`. The bug-report screen has been simplified. |
| `common.*` | 12 | Generic strings still in catalog but no longer referenced. |
| `auth.*` | 10 | Password-strength labels (`auth.strengthFair` … `auth.strengthVeryStrong`), `auth.loginTitle`, `auth.passkeyFailed`. Auth UI now uses inline copy. |
| `notifications.*` | 10 | Toast variants no longer fired. |
| `doctorReport.*` | 9 | Section labels superseded by the v1.4.22 PDF rewrite. |
| `targets.*` | 9 | `targets.bloodPressure`, `targets.weight`, `targets.steps`, etc. — old target-card label namespace replaced by `targets.label.{BMI,WEIGHT,...}`. |
| `measurements.*` | 7 | Stale list-row labels. |
| `comparison.*` | 6 | Including the `comparison.delta.*` triple (improved/worsened/stable) and `comparison.insightsCallout.{lastMonth,lastYear}`. |
| `mood.*` | 5 | Mood-tag descriptors. |
| `thresholds.*` | 5 | `thresholds.title`, `thresholds.subtitle`, `thresholds.defaultLabel`, etc. |
| `achievements.*` | 4 | `achievements.progress`, `achievements.remaining`, `achievements.inProgress`, `achievements.hiddenUnlockToast.description`. |
| `format.*` | 3 | Unused number-format helpers. |
| `telegram.*` | 2 | `telegram.helpHeader`, `telegram.helpBody`. |
| `gettingStarted.*` | 2 | Two leftover quick-start items. |
| `nav.*` | 1 | `nav.coachLabel` or similar. |

Full sorted list is at `/tmp/w10-i18n-unused-list.txt` (405 entries).
Recommended approach is **not** to delete in one sweep — at minimum,
spot-check each namespace cluster against the corresponding feature
to be sure no recent feature uses `getServerTranslator(t).t("settings.title")`
or a similar pattern that the static analyzer can't see (the
analyzer covers any `t(literal)`, but if a key is *built* by string
concatenation at runtime, it would be invisible). The safer pattern is
to delete one namespace cluster per patch, ship, and watch for raw-key
DOM leaks in the live app.

## Runtime probe — blocked

The `next dev` server on `develop` HEAD does not serve any route:

- **Turbopack mode**: CSS compile fails at synthetic `globals.css:3107`
  with `Unexpected token Delim('.')` inside a `color-mix(in oklab,
  var(...) 30%, transparent)` expansion of a Tailwind v4 `ring-*`
  utility. Every URL returns 500 with the same payload.
- **Webpack mode** (`NEXT_TURBOPACK=0`): server boots, but every
  request crashes in `src/lib/api-handler.ts:56` with `TypeError:
  Cannot read private member #state from an object whose class did
  not declare it` when reading `request.method`. This affects
  `/auth/login`, `/api/version`, `/dashboard`, and every API route.

Because no route renders, the Playwright DOM-scan for raw-key leaks,
the per-locale screenshot pass, and the locale-switch click test were
all skipped. The screenshots directory is empty. The Playwright
storage state at `e2e/setup/storageState.json` is stale (points at
`port 3000` for a session cookie that has since been rotated).

**This is the most urgent reconcile finding.** Two unrelated dev-only
bugs — one Tailwind v4 PostCSS issue, one TS-private-field issue under
webpack — currently make local development impossible. Both should be
isolated and ticketed regardless of the i18n work.

## Critical fixes — must apply before v1.4.25 tag

1. **Add `comparison.toggleHint` to both catalogs.** One real-user
   raw-key leak on `/settings/dashboard`. Either supply a sensible
   helper string ("Show a baseline trace on every chart" / "Zeige
   eine Vergleichslinie auf allen Charts") or remove the
   `<p>{t("comparison.toggleHint")}</p>` block in
   `dashboard-layout-section.tsx:238-240`.

2. **Repair `next dev` (both Turbopack and webpack paths).** This
   has no direct i18n consequence but it blocks every form of
   manual QA, the Playwright suite, the W10 Wave runtime probes, and
   anyone trying to verify a fix locally. File two separate tickets;
   both feel like recent dependency-bump regressions.

3. **Remove or fix the `empty.measurements.*` JSDoc references** in
   `src/components/ui/empty-state.tsx:15-17`. They are example code
   in a comment block. Either (a) drop the example, (b) replace with
   real keys that exist in the catalog, or (c) add the three keys to
   the catalog so the JSDoc is honest. Option (c) costs nothing and
   keeps future "I want a measurements empty state" copy-paste users
   from cargo-culting a broken example.

4. **Spot-check `classifications.alerts.*`** (26 dead keys). The
   `bmiBelowNormalTitle` / `bpDangerMessage` / `weightIncreasingMessage`
   etc. wording is *templated with parameters that the rest of the
   classification pipeline still produces*. It is plausible an alerts
   route consumes them via `getServerTranslator` with keys built from
   `\`classifications.alerts.${metric}${severity}Title\`` — that
   would be invisible to the analyzer. Run a 5-minute search through
   `src/app/api/insights/**` and `src/lib/alerts/**` to confirm
   whether these are truly dead before deleting.

5. **Spot-check `targets.bloodPressure` / `targets.weight` /
   `targets.steps`** etc. Same reason — looks like a legacy target-card
   path that *might* still be active in the iOS native bridge
   (v1.4.23 added `iosFormat`). Grep the iOS shadow first.

## Defer-to-v1.4.26 fixes

- **Dead-key cleanup, by namespace cluster.** 405 keys to retire.
  Suggested order: `settings.*` (114) → `classifications.*` (69
  after the alerts spot-check) → `admin.*` (40) → `medications.*`
  (30) → `onboarding.*` (21) → `charts.*` (19). One PR per
  namespace, each with a one-paragraph "verified no runtime caller"
  note in the commit body. Smaller landmines (`format.*`, `mood.*`,
  `telegram.*`) can be batched into a final cleanup commit.

- **Add a runtime raw-key sentinel test.** Once the dev server boots,
  extend the Playwright suite with a smoke that visits each major
  route in both locales and asserts the DOM body contains no string
  matching `/^[a-z]+\.[a-zA-Z]+(\.[a-zA-Z0-9]+)+$/`. Catches future
  forgotten-key regressions automatically. The static analyzer
  produced here can be wired into vitest as a new `i18n-call-coverage`
  test — fail CI when a code-side `t("foo.bar")` resolves to no
  catalog entry. The script is reproducible at
  `/tmp/w10-i18n-deep3.mjs`.

- **Audit dynamic-prefix call sites.** 17 distinct prefixes were
  detected (`achievements.badges.${prefix}${target}.title`,
  `insights.coach.window.${w}`, `comparison.baseline.${value}`,
  `settings.ai.providerChain.types.${entry.providerType}`, …). Each
  one is a place where a future enum extension can silently miss a
  catalog entry, and the static parity test passes anyway. A safer
  pattern is a `keyof typeof messages.en` exhaustive switch, or a
  unit test that enumerates the enum and asserts each rendered key
  exists.

- **Decide on the `settings.testConnection.*` cluster** (14 dead
  keys). These look like leftover error/success copy from a provider
  test-button feature. Confirm whether the v1.4.22 AI section uses
  them via a different path before deletion.

- **Remove or repurpose `comparison.delta.*`** (3 keys —
  improved/worsened/stable). The current insights cards use
  `comparison.deltaVs.lastMonth` / `lastYear` instead; the bare-delta
  flavour appears to be unreachable.

## Numbers at a glance

- 1 missing-key DOM bug (`comparison.toggleHint`).
- 0 interpolation-parameter mismatches between EN and DE.
- 405 unreferenced catalog keys (≈ 16 % of the catalogue) split across
  21 namespaces.
- 17 dynamic-prefix templates resolving 235 keys at runtime — every
  one is invisible to the W9d static parity test and represents a
  future regression surface.
- 2 dev-server blockers preventing every form of runtime probe on
  `develop` HEAD.

The single missing key is the only must-fix-before-tag item. Everything
else is cleanup with no user impact, suitable for a v1.4.26 hygiene
patch. The dev-server breakage is the most urgent unrelated finding
surfaced by this probe.
