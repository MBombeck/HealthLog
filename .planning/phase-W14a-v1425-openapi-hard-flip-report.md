# Phase W14a — OpenAPI drift-gate hard-flip

**Branch:** `develop`
**Status:** complete
**Commits:**
- `74bf608` chore(openapi): regenerate spec after v1.4.25 schema additions
- `41147bd` ci(openapi): hard-fail on spec drift (was warn-only)

## Context

W10 product-lead assessment flagged the OpenAPI drift gate as the biggest
pre-tag risk for v1.4.25 → v1.5: the gate has been warn-only since v1.4.23
W4 F5c (`continue-on-error: true`), meaning any route-signature change
between the v1.4.25 tag and the first iOS Swift codegen lands on develop
without CI ever surfacing the drift. The first iOS build would be the
canary, which is too late.

## Warn-only state before this phase

- **Workflow** `.github/workflows/security.yml`, step "OpenAPI spec drift check":
  - `continue-on-error: true` set, so a non-zero exit was swallowed.
  - Used `::warning::` annotation instead of `::error::`.
- **Script** `scripts/check-openapi.ts`:
  - Already exited 1 on drift, so the script half of the gate was wired
    correctly; the CI step is the only thing that needed flipping.
- **Header comment** on both files described the warn-only state as
  intentional for v1.4.23 with a "flip in v1.4.24+" TODO.

## Pre-flip surprise: drift on current develop

Running `pnpm openapi:check` on `develop` (`cb07d5c`) **failed**: the Zod
registry had picked up schema slots added across the v1.4.25 wave (Apple
Health DTOs, GLP-1 injection sites, dashboard token slots) without anyone
regenerating `docs/api/openapi.yaml`. The warn-only gate had been hiding
this since the registry started growing.

Resolved with a separate prep commit (`74bf608`) so the gate-flip commit
itself contains only the CI behavioural change. The prep commit
regenerates the spec via `pnpm openapi:generate` (+565 / -29 lines).

## Changes in the flip commit (`41147bd`)

`.github/workflows/security.yml`:
- Removed `continue-on-error: true` from the drift-check step.
- Replaced the `::warning::` annotation with `::error::` carrying an
  actionable hint: regenerate via `pnpm openapi:generate`, registry lives
  under `src/lib/openapi/`.
- Rewrote the header comment to describe the hard-fail invariant and
  call out the iOS Swift-codegen consumer.

`scripts/check-openapi.ts`:
- Updated the file-header docblock to match — "Hard-fails on drift since
  v1.4.25" instead of the v1.4.23 TODO.

## Verification

1. **Clean baseline.** `pnpm openapi:check` after the prep commit → green
   ("OpenAPI spec in sync with source schemas").
2. **Drift probe.** Added a temporary `driftProbe: z.string().optional()`
   field to the `errorEnvelope.meta` schema in `src/lib/openapi/routes.ts`.
   Re-ran `pnpm openapi:check` → exited 1 with the expected diff-hint
   output ("OpenAPI spec drift detected. Run `pnpm openapi:generate`…").
3. **Revert + reconfirm.** Removed the probe → `pnpm openapi:check`
   green again.
4. **Quality gates.** `pnpm typecheck` and `pnpm lint` both clean.

## Expected CI behaviour on the next push

When Draft-PR #168 re-runs against the next push to `develop`:
- The "OpenAPI spec drift check" step runs `pnpm openapi:generate` and
  compares `docs/api/openapi.yaml` against the regenerated output.
- **Match** → step prints `::notice::OpenAPI spec in sync with Zod source
  schemas.` and passes.
- **Mismatch** → step prints `::error::OpenAPI drift detected — regenerate
  the spec via 'pnpm openapi:generate' and commit the result.` and exits 1,
  failing the "Security & Quality / Lint, Typecheck & Test" job and
  blocking the PR.

No `continue-on-error` remains on the step, so the job exit code now
propagates to the PR check.

## Follow-ups

None — the gate is now self-enforcing. The legacy hand-maintained spec
at `docs/api/openapi-v1422-legacy.yaml` is untouched; it remains a
reference document and is not consulted by the CI gate.
