# W8-OPS phase report — v1.4.43

Branch: `worktree-agent-abf6af166a9d95b13` (pushed).
Base: `develop` at `7daff01a`.
Commits: 3 atomic, one per B-item.

## B2 — Widgets audit-ledger rate-limit

- `src/app/api/dashboard/widgets/route.ts`: added a `Map<key, ts>` dedup memo with a 60 s `(userId, action)` window. The audit-row write is gated through `shouldEmitAuditRow(...)`; the 422 response is unchanged. Opportunistic GC at >512 entries drops expired rows. Exported `__resetAuditDedupMemoForTests` for the unit test.
- Test: new case "dedups the audit-ledger write across two sequential 422s for the same user". Two PUTs in succession → exactly one `prisma.auditLog.create` call. Existing W2 tests still green (4 → 5 tests).
- Commit: `6301a640 feat(widgets): dedup validation-failed audit rows per user 60s`.

## B11 — Docker BuildKit cache fix (option 2)

- `Dockerfile`: `ARG NEXT_PUBLIC_APP_VERSION` + `ENV` in builder and runner stages. Comment notes that the build-arg becomes part of the layer cache key, forcing per-release invalidation.
- `.github/workflows/docker-publish.yml`: added `build-args: NEXT_PUBLIC_APP_VERSION=${{ github.ref_name }}` to the build-push step.
- `src/app/api/version/route.ts`: `process.env.NEXT_PUBLIC_APP_VERSION?.trim() || packageJson.version`. Whitespace-only env value falls through to the package.json read.
- Tests: two new cases — env-var preference + blank-fallthrough. 5 → 7 tests, all green.
- Commit: `88e80949 fix(docker): bake CI tag into image, prefer it at runtime`.

## B5 — pnpm check-env CI integration

- New `.env.production.example` with placeholder strings for every required manifest var; optional groups commented out. Verified locally: `pnpm check-env --file .env.production.example` exits 0 with 6/6 required `[OK]` rows.
- New `.github/workflows/env-check.yml` that runs on push + PR against `main`/`develop`. Runs `pnpm check-env --file .env.production.example`, greps `[MISSING-REQUIRED]` from the rendered output, and surfaces each missing var as a GitHub Actions error annotation with file pinning.
- Existing `scripts/__tests__/check-env.test.ts` (19 tests) pin the dedup + anyOf + all-or-none logic; left untouched — no new branches added.
- Commit: `1db52d0c ci(env-check): enforce manifest <-> example lockstep`.

## Quality gates

- `pnpm typecheck`: green (no output).
- `pnpm lint`: green (no output).
- Impacted-subset tests: `src/app/api/dashboard/widgets src/app/api/version scripts/__tests__/check-env.test.ts` → 3 files, 31 tests passed.

## Touched files

- `src/app/api/dashboard/widgets/route.ts`
- `src/app/api/dashboard/widgets/__tests__/route.test.ts`
- `src/app/api/version/route.ts`
- `src/app/api/version/__tests__/route.test.ts`
- `Dockerfile`
- `.github/workflows/docker-publish.yml`
- `.github/workflows/env-check.yml` (new)
- `.env.production.example` (new)

No unrelated files touched. Marc-voice, no Claude attribution, no `--no-verify`.
