# Pre-deploy env-var sanity check

`pnpm check-env` reads `scripts/env-manifest.json` and verifies every
variable declared `required: true` is present + non-empty in the
runtime environment. Optional groups are surfaced too, so an operator
can spot the "3 out of 4 vars set" pattern that silently disables a
feature.

This is the answer to the v1.4.40 AP-2 silent-disable: the `.p8` file
went missing during a Coolify migration, three of four `APNS_*` vars
remained set, the app booted cleanly, and APNs notifications stopped
working — undetected for three days because the dispatcher's fallback
chain hid the gap behind the Telegram → ntfy → Web Push path.

## Usage

### Against the live shell

```sh
pnpm check-env
```

Runs against `process.env` (after the local `.env` / `.env.local` load,
if any). Exit code 0 on green, 1 on at least one required variable
missing, 2 on a malformed manifest.

### Against a Coolify export / .env.production

```sh
pnpm check-env --file /path/to/.env.production
```

The file is parsed locally (no shell execution, no variable expansion)
and checked against the manifest. Useful for spot-checking a Coolify
export without polluting the local shell.

## Output format

Output is one row per declared variable, grouped by section. Three
states:

| Marker                | Meaning                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `[OK]`                | Variable is set and non-empty.                                                     |
| `[MISSING-REQUIRED]`  | Variable is required for boot. The script exits 1.                                 |
| `[missing-optional]`  | Variable is optional. The script reports it but does not fail.                     |

The grep-friendly format lets a CI pipeline do `grep -q
'\[MISSING-REQUIRED\]'` to gate a deploy. The CI integration itself
is deferred to v1.4.43 — this release ships the CLI tool only.

## All-or-none groups

Some groups (e.g. off-host backups) are marked `allOrNone: true` in
the manifest. When such a group is partially populated — some vars
set, some missing — the script emits a synthetic `<all-or-none>` row
with severity REQUIRED, even if the surrounding group is `required:
false`. This is the v1.4.40 AP-2 detection pattern.

Example output for a partial APNs config:

```
# APNs (iOS push)
  [OK] APNS_KEY_ID
  [OK] APNS_TEAM_ID
  [OK] APNS_BUNDLE_ID
  [missing-optional] APNS_KEY — Satisfied by any of: APNS_KEY, APNS_KEY_FILE
```

A reviewer immediately sees that `APNS_KEY` (or its `APNS_KEY_FILE`
alternative) is missing while the other three APNs vars are set — the
exact configuration that silently disables iOS push.

## Editing the manifest

The manifest lives at `scripts/env-manifest.json` and is git-tracked
so changes go through a PR. To add a new variable:

1. Pick the right group (or add a new one if the variable doesn't
   belong to any existing category).
2. Decide whether the variable is required for boot, optional, or
   part of an all-or-none feature group.
3. Document the variable's `purpose` in one sentence — the operator
   reads this text when the var shows up as missing.
4. Run `pnpm check-env` locally against your live shell to confirm
   the manifest still passes (or fails for the right reason).
5. Add a regression test under `scripts/__tests__/check-env.test.ts`
   if the manifest change introduces a new classification branch
   (anyOf, allOrNone, …).

## Future: CI gate

Deferred to v1.4.43:

- GitHub Actions workflow that runs `pnpm check-env --file
  .env.production.example` on every PR, blocking changes that
  introduce new required vars without updating the example file.
- Coolify pre-deploy hook that runs `pnpm check-env` inside the
  target container and aborts the deploy on exit code 1.
