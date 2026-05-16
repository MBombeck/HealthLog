# Code Quality + Documentation Audit — 2026-05-17

## Executive summary

The repo is in unusually good shape for its size: `tsc --noEmit` and `eslint`
both pass clean, there are zero `TODO`/`FIXME`/`XXX`/`HACK` markers in product
code, zero empty `catch` blocks outside one inline `<script>` fallback, and all
test files contain at least one `expect()`. The dominant debt is **archaeology
in comments** — 2 366 `v1.4.x` version-tag references across 200+ files, plus
244 wave/phase markers (`W5 reconcile (Code-H2)`, `IW-B`, `phase B8`). These
read like commit messages inlined into the source and will only get worse with
each release. The other three real wins are (1) deleting the 7-file
`getXSystemPrompt` / `getXUserPrompt` boilerplate in `src/lib/ai/prompts/`,
(2) removing the dead `SESSION_SECRET` env contract, and (3) closing the
JSDoc gap on `src/lib/**` exports (171/535 missing). Recommended order:
F-1 first (low-risk additive cleanup, biggest readability win), then F-2 and
F-9 in the same release, then the long-tail items.

## Findings — prioritized

### F-1: Version-tagged inline comments have become source-control archaeology

**Severity**: high
**Category**: comment debt
**File(s)**: `src/proxy.ts:28,32,36,50,179,190`, `src/app/page.tsx:85,93,99,109,201,207,217,253,259,272,281,288,307,328,353,396,401,539,564,589,675,890,921,935,1196,1214,1225`, `src/app/api/analytics/route.ts:36,55,67,...` (47 hits), `src/components/charts/health-chart.tsx` (46 hits), `src/lib/ai/schema.ts:5,28,32,52,55,...` (29 hits), and 30 other files
**What's wrong**: 2 366 inline references to `v1.4.x` plus 244 markers
shaped like `// v1.4.22 W5 reconcile (Sec-MED-2) — ...` or
`// v1.4.34 IW-B — ...`. They were useful while the release was in
flight, but they now narrate the commit history inside the source. A
reader of `dashboard-layout.ts:288` doesn't care that the comparison
baseline shipped in `v1.4.16 phase B8`; they want to know what the
field means. The convention also locks future archaeology into the
codebase forever — every patch release inherits the previous tags.
**Fix shape**: Sweep in two passes:
1. Strip the leading `v1.4.x [WAVE-CODE] —` marker from any comment whose
   remaining body is still meaningful WHY-narration. Reduces every offender
   without losing intent.
2. Delete the comment outright when the body is just "added the X" or
   "see plan Y". Sample target: `src/proxy.ts:28,32,36` collapse into one
   `// public paths bypassed by auth` block; `src/lib/dashboard-layout.ts:288,294,319,323` lose all four tags and
   the field-doc above each definition stays.
**Effort**: medium (one focused half-day, additive, deletes ~2 000 lines)
`[hotfix-ready]`

### F-2: Seven domain prompt files duplicate the same shell

**Severity**: high
**Category**: duplicate logic
**File(s)**: `src/lib/ai/prompts/bmi.ts:34-61`, `blood-pressure.ts:?`, `weight.ts:46-75`, `pulse.ts:52-81`, `mood.ts`, `general-status.ts`, `medication-compliance.ts`
**What's wrong**: Every file in `src/lib/ai/prompts/` exports the same pair —
`getXSystemPrompt(locale)` returns `${getBaseSystemPrompt(locale)}\n\n${section}`,
and `getXUserPrompt(snapshotJson, todayKey, locale, previousContextBlock?)`
returns a date-prefixed prompt with an optional context block. Only the
DE/EN section constants and the analytical "Analyse the X with focus on…"
sentence differ. The function signature drift risk is real — adding a
new arg today means editing seven files.
**Fix shape**: Replace the seven pairs with a single
`buildDomainPrompts({ id, sectionDe, sectionEn, taskDe, taskEn })` factory
in `prompts/factory.ts` and a registry per metric. The
locale-`en`/-`de` branching in `getXUserPrompt` collapses to one
template-literal interpolation.
**Effort**: small (mechanical, fully covered by existing `__tests__`)

### F-3: `SESSION_SECRET` is documented + required by entrypoint but never read

**Severity**: medium
**Category**: dead code
**File(s)**: `.env.example:48`, `docker-entrypoint.sh:12`, `README.md:94,154`, `CONTRIBUTING.md:25,34`, `docker-compose.yml:23,68`, `docs/self-hosting/scaling.md:24`
**What's wrong**: The env var is listed as required, the docker entrypoint
fails-fast if it is missing, and onboarding docs tell every operator to
generate one with `openssl rand -hex 32`. `grep -rn "SESSION_SECRET" src/`
returns nothing. Sessions are server-stored in `prisma.session` keyed by
the cookie value (`src/lib/auth/session.ts`), so the secret has nothing
to sign. Every self-hoster carries a ceremonial 64-char hex string that
the app ignores. Either (a) wire it into a real signing path (HMAC the
cookie value) or (b) drop the requirement and the docs.
**Fix shape**: Pick (a) or (b). (b) is one removal in
`docker-entrypoint.sh`, the `.env.example` line, two `README.md`
lines, and the `docker-compose.yml` mapping. (a) is a real auth
change and should not be a hotfix.
**Effort**: small (for the deletion path) `[hotfix-ready]` if route (b) chosen

### F-4: 171/535 exported functions in `src/lib/**` have no JSDoc

**Severity**: medium
**Category**: docs gap
**File(s)**: highest offenders by file: `src/lib/dashboard-layout.ts` (0/3 functions documented), `src/lib/telegram.ts` (1/6), `src/lib/process-type.ts` (1/4), `src/lib/glucose.ts` (1/5), `src/lib/utils.ts` (0/1), `src/lib/api-response.ts` (2/4), `src/lib/format-locale.ts` (1/3)
**What's wrong**: The most-imported helpers (`cn()`, `apiError()`,
`safeJson()`, `getProcessType()`, `mgdlToMmol()`, `getGravatarUrl()`)
have no one-line summary. Some have rich type signatures that carry
the meaning; some don't. `safeJson<T>(req, schema)` is a wrapper that
returns an `apiError` `Response` on parse failure — a non-obvious
shape worth documenting once.
**Fix shape**: One-line `/** … */` on every top-10 import. Aim for
WHY/return-shape only, not WHAT. Marc's pattern in
`src/lib/format.ts:40-62` is the model — single-line, locale-aware example
embedded.
**Effort**: medium (manual sweep, ~170 spots) `[hotfix-ready]`

### F-5: `as never` and `as unknown as` chains hide schema drift

**Severity**: medium
**Category**: type safety
**File(s)**: `src/app/api/admin/backups/[id]/restore/route.ts:299,302,357`, `src/lib/personal-records/pr-detection-worker.ts:271,357,434,437,438`, `src/lib/devices/revoke.ts:79`, `src/lib/ai/coach/snapshot.ts:403,482`, `src/lib/ai/prompts/insight-generator.ts:729,730,731,737,738,739` (and 14 more), `src/lib/medications/route-guards.ts:61`, `src/lib/jobs/apple-health-import-worker.ts:85,176,194,195`
**What's wrong**: 20 `as unknown as T` and 9 `as never` assertions. The
PR worker's `where: where as never` and dynamic-key `orderBy` casts
disable the very Prisma narrowing the rest of the file relies on; if
the schema renames a column the worker silently builds a malformed
query at runtime. `MEDICAL_REFERENCE_IDS as unknown as [string, ...string[]]`
in `provider-chain/route.ts:82` exists because Zod wants a non-empty
tuple — a `.refine()` against the readonly array would type-check
without the cast.
**Fix shape**: For each cast, either fix the underlying type or add a
WHY-comment. The Prisma JSON casts in `chart-overlay-prefs`,
`widgets`, `healthkit`, `doctor-report-prefs` (5 sites) collapse onto
one helper `toInputJsonValue<T>(value: T): Prisma.InputJsonValue`. The
`pr-detection-worker.ts` dynamic-orderBy can switch to a
`Record<string, "asc" | "desc">` and drop the cast entirely.
**Effort**: medium

### F-6: Legacy `src/lib/format.ts` is a soft-deprecation that won't die

**Severity**: low
**Category**: simplify | duplicate logic
**File(s)**: `src/lib/format.ts:23-62` (the file itself) and 20 import sites
**What's wrong**: The file's docstring tells new code to use
`useFormatters()` instead, but 20 production import sites still call
`formatDate` / `formatDateTime` / `formatTime` / `formatDateShort`.
The shim reads `document.cookie` on the client and falls back to `en`
on the server, which means SSR can render English where the user has
German selected — exactly the locale hydration mismatch the docstring
warns about.
**Fix shape**: Either migrate the 20 callers to `useFormatters()`
(client) or `makeFormatters(serverLocale)` (server) and delete
`src/lib/format.ts`, or accept it and remove the soft-deprecation
docstring so a future contributor doesn't re-introduce the bug it
warns against.
**Effort**: small (mechanical migration)

### F-7: Mega-files near 1 700 lines in product code

**Severity**: low
**Category**: simplify
**File(s)**: `src/lib/jobs/reminder-worker.ts` (1 653 lines), `src/app/api/insights/targets/route.ts` (1 198), `src/app/api/analytics/route.ts` (1 073), `src/app/api/gamification/achievements/route.ts` (988), `src/components/settings/ai-section.tsx` (1 739), `src/components/charts/health-chart.tsx` (1 710), `src/app/page.tsx` (1 348)
**What's wrong**: Single files holding multiple concerns. `reminder-worker.ts`
mixes scheduling, channel adapters, dedup, and tests-flag logic.
`/api/analytics/route.ts` has an unrelated "slim slice" branch
inlined into the same handler.
**Fix shape**: Only the worker is genuinely a problem — split per
channel and per phase. The route files are acceptable because they
read top-to-bottom; the chart components have to be one file for
Recharts callbacks to share state cheaply. Reminder worker → split
in a dedicated round, not a "while-I'm-here".
**Effort**: large (do not bundle into a hotfix)

### F-8: `coach-prefs` excludeMetrics is a subset enum cast at runtime

**Severity**: low
**Category**: type safety
**File(s)**: `src/lib/ai/coach/snapshot.ts:400-405`
**What's wrong**: `CoachExcludeMetric` is a strict subset of
`CoachScopeSource` and the snapshot loop casts each source via
`as unknown as CoachExcludeMetric` then runs a `Set.has()` lookup as
defence-in-depth. The cast is documented but the comment says
"the runtime check is just defence-in-depth" — which contradicts
the cast. A `(src in EXCLUDABLE_SET)` predicate-typed helper would
remove the cast and keep the narrow type at compile time.
**Fix shape**: Introduce `function isExcludable(src: CoachScopeSource): src is CoachExcludeMetric`.
**Effort**: trivial

### F-9: Prisma JSON serialisation needs one helper

**Severity**: low
**Category**: duplicate logic
**File(s)**: `src/app/api/auth/me/doctor-report-prefs/route.ts:81`, `src/app/api/dashboard/chart-overlay-prefs/route.ts:83`, `src/app/api/dashboard/widgets/route.ts:156`, `src/app/api/integrations/healthkit/route.ts:177`, `src/lib/jobs/apple-health-import-worker.ts:85,176,194,195`
**What's wrong**: Seven sites do `value as unknown as Prisma.InputJsonValue`
to satisfy Prisma's `JsonValue` union. The cast is correct (the values are
plain JSON-serialisable objects) but each call site re-invents the same
escape hatch.
**Fix shape**: One generic helper in `src/lib/db.ts`:
`export const toJson = <T>(v: T) => v as unknown as Prisma.InputJsonValue;`
with a WHY-comment about why the cast is needed.
**Effort**: trivial `[hotfix-ready]`

### F-10: `db-compat.ts` is the maintained migration system

**Severity**: informational
**Category**: dead code (false positive)
**File(s)**: `src/lib/db-compat.ts` (200 lines), 51 call sites
**What's wrong**: At first glance this file looks like accumulated
backwards-compat (which Marc's preferences explicitly forbid). On read
it's the production "ALTER TABLE IF NOT EXISTS" path that bootstraps a
fresh container without `prisma migrate deploy`. Worth a top-of-file
docstring saying so — right now anyone scanning for cruft will flag it.
**Fix shape**: Add a header comment naming it the "schema-bootstrap" path
and pointing at the `prisma/migrations/` directory for the proper
migration history. No code change.
**Effort**: trivial `[hotfix-ready]`

### F-11: `eslint-disable` on `passkey.ts` `response: any` parameters

**Severity**: low
**Category**: type safety
**File(s)**: `src/lib/auth/passkey.ts:103-104,169-170`
**What's wrong**: Both `verifyRegistration` and `verifyAuthentication`
take `response: any` with a per-line eslint-disable. The upstream
`@simplewebauthn/server` exports `RegistrationResponseJSON` and
`AuthenticationResponseJSON` types for these payloads.
**Fix shape**: Import the SimpleWebAuthn types, drop the
`eslint-disable` lines.
**Effort**: trivial

### F-12: Comment quality wins: WHAT-narration leaks

**Severity**: low
**Category**: comment debt
**File(s)**: sample: `src/lib/dashboard-layout.ts:262-263` ("Merge with defaults so new widgets…"), `src/lib/ai/coach/snapshot.ts:413-416` ("Trim down to the metrics…"), `src/app/api/analytics/route.ts:55-66` ("v1.4.33 C1 — slim summaries slice…")
**What's wrong**: Most long block comments narrate WHAT the code does
in plain English right above identical code. Some carry the WHY (the
`/api/analytics` slim-slice block does explain the read-budget
trade-off). The WHAT-only sections should collapse.
**Fix shape**: Treat any block comment whose next 3 lines paraphrase the
comment as deletable. Sample: `dashboard-layout.ts:253-258` keeps the
"v1.4.28 retired" version tag (drop per F-1) and the WHY ("PUT route's
Zod enum rejects the entire blob") — drop the WHAT-rephrasing in the
middle.
**Effort**: medium (folds into F-1 sweep)

### F-13: `route-guards.ts` import is lazy with an unstubbable cast

**Severity**: informational
**Category**: type safety | test discipline
**File(s)**: `src/lib/medications/route-guards.ts:56-62`
**What's wrong**: `loadPrisma()` lazy-imports `@/lib/db` so test files can
stub the module — fine pattern — but the return type forces a
`prisma as unknown as MedicationOwnershipPrisma` cast at the boundary.
`MedicationOwnershipPrisma` is a stripped-down interface declared
locally; the real `PrismaClient` is structurally compatible. The cast
is honest but a brief comment saying "stripped interface for test
stubbability" sits below the function instead of above. Move it up.
**Fix shape**: WHY-comment relocation.
**Effort**: trivial

### F-14: `as never` cast comment in `backups/restore/route.ts` is the right pattern

**Severity**: informational
**Category**: positive example
**File(s)**: `src/app/api/admin/backups/[id]/restore/route.ts:299`
**What's wrong**: Nothing. `type: m.type as never, // already enum-validated above`
is the model for every other cast in F-5: the WHY is the trailing
comment, not a block above. Aim for this in F-5.
**Effort**: n/a

### F-15: Test discipline spot-check is clean

**Severity**: informational
**Category**: test discipline
**File(s)**: 400 test files scanned
**What's wrong**: Nothing material. Every test file contains at least one
`expect()`. No empty `catch` blocks in production tests. No
`try/catch` swallow patterns. The codebase has 0 `TODO`, 0 `FIXME`,
0 `XXX`, 0 `HACK` markers — this is genuinely rare and worth
preserving with a CI grep.
**Fix shape**: Add a tiny CI grep gate enforcing the zero-TODO rule
explicitly, so a future contributor doesn't reintroduce the pattern
in the next marathon.
**Effort**: trivial `[hotfix-ready]`

## Counts

- Files with > 10 obsolete version-tagged comments: **35**
- `any` / `as unknown as` / `as never` cast-throughs: **6 + 20 + 9 = 35** (excluding tests + generated)
- Open TODO / FIXME / XXX / HACK total in product code: **0**
- Exported functions in `src/lib/**` without doc-comment: **171 / 535** (32 %)
- Total `v1.4.x` references in product code: **2 366**
- Test files without `expect()`: **0 / 400**
- `tsc --noEmit` clean: yes
- `pnpm lint` clean: yes

## Out of scope

- Splitting `reminder-worker.ts` (F-7) — wants its own round, not a hotfix.
- Refactoring `health-chart.tsx` (1 710 lines) — Recharts callbacks share
  state cheaply only when colocated; a split needs UX validation first.
- Migration of legacy `src/lib/format.ts` callers (F-6) — touches 20 files
  across the dashboard; defer until the next i18n pass.
- Generated Prisma client (`src/generated/prisma/`) — third-party output,
  not maintained source.
- E2E tests under `e2e/` and `tests/` — separate audit scope.
- Translation/copy quality in `messages/` — separate audit scope.
