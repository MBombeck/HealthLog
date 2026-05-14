# W10 Reconcile C — Security + Auth + API fixes

Date: 2026-05-14
Branch: `develop`
Quality gates per commit: `pnpm typecheck` clean, `pnpm lint` clean, relevant tests green.
Scope guard: only files in the W10 Reconcile C list were modified. Fix-A's component changes and Fix-B's analytics changes were left untouched.

---

## 1. Code-Review H2 — `requireAuth()` 403'd narrow-scope tokens on unscoped routes
- Commit: `c38a2c8` — `fix(auth): allow narrow-scope tokens on unscoped routes — unblocks v1.5 iOS endpoints`
- Source: `/Users/marc/Projects/HealthLog/src/lib/api-handler.ts:267-296` — removed the "no requiredPermission ⇒ wildcard only" branch; restated the contract so a route without a declared scope accepts any authenticated token, and a route with a declared scope still gates wildcard-or-listed.
- Test: `/Users/marc/Projects/HealthLog/src/lib/__tests__/require-auth-bearer.test.ts:201-265` — replaced the inverted-policy test with three explicit cases (narrow + unscoped, wildcard + unscoped, narrow + scoped-and-matching). The existing "narrow + scoped-and-not-matching → 403" case is preserved as the regression anchor.
- iOS impact: unblocks `/api/measurements/by-external-ids`, `/api/personal-records`, `/api/medications/[id]/glp1`, `/api/dashboard/glp1`.

## 2. Security H-1 — GLP-1 prompt-injection (patient-safety)
- Commit: `a2bcbe9` — `fix(security): sanitize GLP-1 medication strings before LLM interpolation (patient-safety)`
- Sources:
  - `/Users/marc/Projects/HealthLog/src/lib/insights/glp1-plateau.ts:18-20,116-128,131-149` — routed `ctx.drug` and `ctx.doseUnit` through `sanitizeForPrompt` and reused a `doseLabel` constant so both DE and EN bodies share the sanitised value.
  - `/Users/marc/Projects/HealthLog/src/lib/ai/coach/glp1-snapshot.ts:22,305-340,381-391` — sanitised `display`, `generic`, every `doseChange.doseUnit`, every `doseChange.note`, and the `currentDose.unit`. Brand-recognition fast path preserved.
- Tests:
  - `/Users/marc/Projects/HealthLog/src/lib/insights/__tests__/glp1-plateau.test.ts` — 4 new cases (control-sequence strip, word-boundary injection strip, normal-name passthrough, doseUnit newline strip).
  - `/Users/marc/Projects/HealthLog/src/lib/ai/coach/__tests__/glp1-snapshot.test.ts` — new file, 6 cases covering null/no-GLP-1, normal name, malicious name strip, doseUnit strip, note strip, and a normal-name regression anchor.

## 3. Security H-2 — Batch ingest rate-limit
- Commit: `04dd972` — `fix(security): rate-limit batch-measurements ingest (60/min default)`
- Source: `/Users/marc/Projects/HealthLog/src/app/api/measurements/batch/route.ts:39,42-50,98-117` — 60 batches/min/user via `checkRateLimit("measurements:batch:<userId>", 60, 60_000)`. Returns 429 with an unambiguous message so the iOS client backs off and retries instead of assuming the row landed.
- Test: `/Users/marc/Projects/HealthLog/tests/integration/measurements-batch.test.ts:329-364` — pre-seeds the `rate_limits` counter at the cap and asserts 429 + zero rows persisted.

## 4. Code-Review M4 — `createMeasurementSchema` missing `deviceType`
- Commit: `c49fe73` — `fix(measurements): accept deviceType on single-entry POST (mirrors batch route)`
- Sources:
  - `/Users/marc/Projects/HealthLog/src/lib/validations/measurement.ts:198-228` — added `deviceType: z.string().min(1).max(32).nullable().optional()`.
  - `/Users/marc/Projects/HealthLog/src/app/api/measurements/route.ts:97-103,131-156` — threaded `deviceType` through both the array-body multi-entry path and the single-entry path. Null defaults preserved.
- Tests: `/Users/marc/Projects/HealthLog/src/lib/validations/__tests__/measurement.test.ts:135-176` — three cases (present/null/omitted) so the parsed shape stays observable.

## 5. Senior-Dev H-1 — Batch ingest race reconciliation no-op
- Commit: `ad62fe2` — `fix(api): correct batch-ingest race reconciliation — accurate inserted/duplicate counts under contention`
- Source: `/Users/marc/Projects/HealthLog/src/app/api/measurements/batch/route.ts:283-309` — rewrote the reconciliation to trust `createMany.count` for `insertedCount` and only downgrade `toInsert.length - insertedCount` per-entry "inserted" statuses to "duplicate". The previous loop was a no-op because `skipDuplicates` keeps the raced row in the DB (just written by the other batch). The new loop preserves the iOS sync cursor's per-entry vs aggregate count invariant under contention and cannot drift the aggregate negative.
- Test: `/Users/marc/Projects/HealthLog/tests/integration/measurements-batch.test.ts:262-327` — runs two parallel batches with overlapping externalIds and asserts the three invariants the iOS cursor depends on: per-entry sums equal aggregate counts, aggregate counts stay non-negative, DB row count matches the combined `inserted` total.

## 6. Security M-3 — Audit-log gap on source-priority + doctor-report-prefs writes
- Commit: `53a7992` — `fix(audit): log source-priority + doctor-report-prefs writes`
- Sources:
  - `/Users/marc/Projects/HealthLog/src/app/api/auth/me/source-priority/route.ts:19,21,57-83` — captures `before` shape, persists, then `auditLog("user.source-priority.update", { userId, ipAddress, details: { previous, next } })`.
  - `/Users/marc/Projects/HealthLog/src/app/api/auth/me/doctor-report-prefs/route.ts:20,22,82-94` — same pattern with `user.doctor-report-prefs.update` event name.
- Tests:
  - `/Users/marc/Projects/HealthLog/src/app/api/auth/me/source-priority/__tests__/route.test.ts` — new file, 6 cases (GET + PUT happy paths, both auth gates, invalid shape, audit-log assertion).
  - `/Users/marc/Projects/HealthLog/src/app/api/auth/me/doctor-report-prefs/__tests__/route.test.ts:154-187` — new Case 5 asserts the audit-log call shape.

---

## Flags / notes
- Pre-existing `src/lib/__tests__/i18n-locale-integrity.test.ts` failures (en/es, en/it, en/pl drift on `insights.sleep.headlineCaptionSuffix`) are caused by W3 untracked changes in `messages/*.json` + `sleep-overview.tsx`, NOT by this reconcile. Out of scope for Fix-C.
- Parallel agents (Fix-A, Fix-B) modified `src/components/**`, `src/lib/analytics/**`, and `src/app/api/personal-records/route.ts` during this session. Their commits interleave with ours in the develop log; this reconcile did not touch their files.
- All six commits use professional Marc-Voice, no `Co-Authored-By: Claude` trailer, no `--no-verify`.

## Validation summary
- 65/65 unit tests for touched files pass (`require-auth-bearer`, `glp1-plateau`, `glp1-snapshot`, `measurement` schema, `auth/me/*`).
- 8/8 batch integration tests pass (including new rate-limit + race-reconciliation cases).
- `pnpm typecheck` and `pnpm lint` clean after every commit.
