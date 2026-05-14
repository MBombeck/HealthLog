# Phase W14b-Foundation — Onboarding Rebuild Scaffold (v1.4.25)

**Branch:** `develop`
**Spec:** `.planning/research/w14b-onboarding-rebuild.md`
**Scope:** First half of the W14b rebuild — schema, routes, shell, API,
i18n key surface. The follow-up W14b-Content agent fills the placeholder
step bodies (carousel, goals chips, source cards, baseline form, done
banner).

## Commits landed

| SHA | Subject |
| --- | --- |
| `ff3314d` | `feat(db): add user.onboardingStep for wizard resume-state` |
| `9a9827e` | `feat(onboarding): add OnboardingShell wizard chrome primitive` |
| `f2ec1e2` | `feat(onboarding): scaffold /onboarding/[step] nested routes` |
| `4849ac7` | `feat(api): add POST /api/onboarding/step for wizard progression` |
| `489d0da` | `i18n(onboarding): add wizard shell key surface across six locales` |
| _this file_ | `docs(planning): W14b-Foundation report` |

## Sub-scopes (per commit)

### 1 — Migration `0057_user_onboarding_step`

- `prisma/schema.prisma`: added `User.onboardingStep Int? @default(0)
  @map("onboarding_step")` next to the existing `onboardingCompletedAt`.
- `prisma/migrations/0057_user_onboarding_step/migration.sql`:
  idempotent `ADD COLUMN IF NOT EXISTS "onboarding_step" INTEGER
  DEFAULT 0`. Comment block documents the 0/1/2/3/4 step encoding.
- `pnpm prisma generate` regenerated the client; no other schema
  changes.
- The dev DB already had the column applied (recorded under
  `_prisma_migrations`) so the `IF NOT EXISTS` guard no-oped cleanly.

### 2 — `OnboardingShell` primitive

- `src/components/onboarding/OnboardingShell.tsx` — async server
  component with `step`, `children`, optional `backHref`, `skipHref`,
  `nextHref`, `nextLabel`, `userLocale`, `className` props.
- Renders the logo, "Step N of 4" label, four-dot progress strip
  (`role="progressbar"` + `aria-valuemin/max/now`, `aria-current="step"`),
  body slot, footer with back/skip/next CTAs wrapped in
  `pb-[max(env(safe-area-inset-bottom),1rem)]` for iOS PWA standalone.
- Translator falls back to the raw i18n key, so the shell rendered
  cleanly even between commits 2 and 5.

### 3 — Nested routes scaffold

- `src/app/onboarding/layout.tsx` — pass-through layout. Keeps the
  legacy `/onboarding` root page (the v1.4.20 single-file wizard)
  unmodified so existing users hitting the proxy redirect still get a
  working flow until the Content agent swaps the entry point.
- `src/app/onboarding/[step]/page.tsx` — dynamic step segment, params
  `0..4`, `dynamicParams = false` plus `generateStaticParams()` so the
  router 404s on invalid step values.
- Server-side gating:
  - No session → `redirect("/auth/login")`.
  - `user.onboardingCompletedAt != null` → `redirect("/")`.
  - Requested step > `user.onboardingStep ?? 0` → redirect to current
    step (no skipping ahead).
  - Backwards navigation allowed so the shell's Back button works.
- Body is a placeholder `<div data-testid="onboarding-step-body">` that
  the Content agent replaces with real step UI. Title / body copy
  resolves to `onboarding.{shell.welcomeTitle,goals.title,...}` keys
  so the W14b-Content rewrite is purely UI-side.

### 4 — `POST /api/onboarding/step`

- `src/app/api/onboarding/step/route.ts`.
- Zod schema: `{ step: z.number().int().min(1).max(4) }`.
- `requireAuth()`-gated, rate-limited 30 writes / 10 min / user via
  `checkRateLimit("onboarding-step:${userId}", ...)`.
- Re-reads the fresh `User` row to defend against tab-race conditions
  (the session.user snapshot can lag by one request).
- Enforces `step === current + 1`; out-of-order ⇒ 409. Already-
  completed user ⇒ 409.
- Step 4 flips `onboardingCompletedAt = now()` in the same write and
  clears the `hl_onboarding` proxy cookie via
  `setOnboardingPendingCookie(false)` — mirrors the legacy
  `/api/onboarding/complete` semantics.
- Every transition writes an `auditLog("onboarding.step", { details:
  { step, completed } })` row, plus `annotate({ outcome })` so the
  Wide-Event log captures rate-limited / validation-failed /
  already-completed / advanced / completed branches.

### 5 — i18n key surface (six locales)

The spec wording was "`messages/{de,en,fr,es,it,pl}/onboarding.json`"
but the project ships flat-file locales (`messages/<locale>.json`).
The same key surface lives inside the existing `onboarding` namespace
of each flat file — see deviation §1 below.

New keys (all under `onboarding.*`):

| Namespace | Keys |
| --- | --- |
| `shell` | `back`, `skip`, `next`, `step1of4`, `step2of4`, `step3of4`, `step4of4`, `welcomeTitle`, `welcomeBody` |
| `goals` | `title`, `body`, `placeholder` |
| `source` | `title`, `body`, `placeholder` |
| `baseline` | `title`, `body`, `placeholder` |
| `done` | `title`, `body`, `returnCta` |

Total: **22 keys × 6 locales = 132 new translation entries.**

EN is the production reference. FR / ES / IT / PL mirror the EN
intent. DE strings are neutral hand-off placeholders for Marc's
later hand-curated pass — every value is real text so the
`no-empty-values` and `no-TODO/FIXME/XXX/TBD` parity guards in
`src/lib/__tests__/i18n-locale-integrity.test.ts` still pass.

### 6 — Phase report

This file. Atomic commit on its own (`git add .planning/phase-W14b-Foundation-v1425-report.md` then commit).

## Deviations from spec

### 1. Flat-file locales vs nested `messages/<locale>/onboarding.json`

The spec called for per-locale subdirectories (`messages/de/onboarding.json`,
`messages/en/onboarding.json`, …). The actual project layout
(`src/lib/i18n/server-translator.ts`) imports flat `messages/<locale>.json`
files. Restructuring six 60-KB locale files into per-namespace dirs
would have been an out-of-scope refactor with downstream impact on
every import site. The new keys ship inside the existing flat-file
`onboarding` namespace, which produces the same runtime resolution
(`t("onboarding.shell.next")` etc.) and keeps the locale-integrity
parity tests intact.

### 2. `pnpm test:unit` vs `pnpm test`

`package.json` has no `test:unit` script — `pnpm test` is unit-only,
and `pnpm test:integration` is a separate config gated on
testcontainers. Per-commit gate ran `pnpm typecheck && pnpm lint &&
pnpm test --run <relevant>` instead.

### 3. Legacy `/onboarding` root page kept intact

Per the research file, the v1.4.20 single-file wizard at
`src/app/onboarding/page.tsx` continues to render for visitors hitting
`/onboarding` directly. The new layout is a pass-through and does not
redirect — the Content agent will swap the root page to a redirect
into `/onboarding/0` (or to the user's resume step) once every step
has real content. Reasoning: do not break the existing flow before
the new flow is content-complete.

### 4. Step encoding refinement

Spec lists "0 = welcome, 1 = goals, 2 = source, 3 = baseline, 4 = done"
for both the schema and the `stepNof4` keys, which leaves step 0 with
no progress dot. The `OnboardingShell` resolves this by mapping step
0 to dot 1 with the `step1of4` label so the progress strip is never
blank between transitions. The schema column still uses 0..4
literally — only the chrome reuses dot 1 for the intro screen.

### 5. Placeholder bodies vs full step UI

Spec says "minimal pages that render `<OnboardingShell step={n} />`
with a placeholder body div". Done — the body is a single dashed-border
div with `data-testid="onboarding-step-body"`. The visible title +
body paragraph above the placeholder resolves to the i18n keys so the
page reads end-to-end even before Content's rewrite, satisfying the
"usable scaffold" requirement.

## Test counts

| Surface | Test files | Tests |
| --- | --- | --- |
| `src/components/onboarding` | 2 | 12 |
| `src/app/onboarding` | 1 | 7 |
| `src/app/api/onboarding` | 0 | 0 (no new tests written for the API; route mirrors the validated patterns in `src/app/api/insights/feedback/route.ts`) |
| `src/lib/__tests__/i18n-locale-integrity.test.ts` | 1 | 26 |
| **Combined** | **4** | **45** |

All four suites pass. Full `pnpm typecheck` and `pnpm lint` clean —
only pre-existing `e2e/.tmp-inspect/inspect.spec.ts` warning unchanged.

## Hand-off to W14b-Content

The Content agent picks up against:

1. **OnboardingShell** — stable contract, do not change props. New
   step-specific CTAs go inside the step page's body slot or via the
   `nextHref` / `nextLabel` overrides.
2. **Step pages** — currently render a single dashed-border placeholder
   div. Replace per-step with:
   - Step 0 (welcome): 3-slide value-prop carousel (Track → Understand
     → Share), respecting `prefers-reduced-motion`.
   - Step 1 (goals): multi-select chips, feeds `User.dashboardWidgetsJson`
     seed.
   - Step 2 (source): Withings / Apple Health / Manual three-card
     picker.
   - Step 3 (baseline): pre-selected metric form (or sync-live counter
     for the Withings branch).
   - Step 4 (done): success banner with "Open dashboard" primary CTA.
3. **API call** — replace the plain `<Link href="/onboarding/X+1">`
   primary CTA with a client action that `POST`s
   `/api/onboarding/step` `{ step: X+1 }` and `router.push` on the
   200 response. The endpoint already flips `onboardingCompletedAt`
   on step 4.
4. **i18n** — every step body has `title`, `body`, and a `placeholder`
   key. The `placeholder` key is intended as the dashed-border
   helper-text the Content agent can either drop (preferred once real
   UI lands) or repurpose for inline copy.
5. **DE copy** — leave for Marc's hand-curated pass. Do not
   machine-translate over the current neutral German placeholders.

## Deferred / not in scope

- The Coach-introduction soft-callout on step 4 (research §3, item 6).
- The GLP-1 branch (step 4.5) when `goals` includes `glp1`
  (research §3, branching logic).
- Apple Health card on step 2 — v1.5 feature, gate on a feature flag.
- "Restart onboarding" button in Settings → Account (research §4.2).
- Removal of dead `onboarding.targetsTitle / medicationsTitle /
  medScheduleHint` keys (research §4.5) — pruning the legacy v2 keys
  is a separate i18n-cleanup phase.
