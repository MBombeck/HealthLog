# Image channels

The image `ghcr.io/mbombeck/healthlog` is published on three channels. Pick
one per instance and stay on it; the release calendar behind them is
[`docs/contributing/release-policy.md`](../contributing/release-policy.md).

| Channel | Tag                                      | Built from                                        | When                                                  | For                                    |
| ------- | ---------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| release | `:latest`, `:vX.Y.Z`                     | a release tag on `main`                           | Saturdays, by the calendar                            | everyone, production                   |
| edge    | `:edge`, `:edge-<commit>`                | every push to `main`, the fixes of the next patch | on every merge                                        | checking a fix before its Saturday     |
| nightly | `:nightly`, `:nightly-YYYYMMDD-<commit>` | the newest `release/vX.Y.0`, the next minor       | every night, when the branch moved since the last one | trying the next minor's features early |

`:latest` and the version tags are multi-arch (amd64 and arm64) and signed.
`:nightly` is multi-arch and signed too. `:edge` is amd64 only and unsigned.
Every image carries build provenance and an SBOM.

## Choosing a channel in compose

The published `docker-compose.yml` reads the tag from `HEALTHLOG_IMAGE_REF`
(the leading colon is part of the value). Set it in the `.env` next to the
compose file, or in your platform's environment variables:

```sh
# release (the default when the variable is unset)
HEALTHLOG_IMAGE_REF=:latest

# edge: main, fixes before their release
HEALTHLOG_IMAGE_REF=:edge

# nightly: the next minor, may break
HEALTHLOG_IMAGE_REF=:nightly
```

Then `docker compose pull && docker compose up -d`. With a compose file of
your own, put the tag in the image line instead:
`image: ghcr.io/mbombeck/healthlog:nightly`.

## What nightly means

A nightly is not a release. It is the release branch as it stood that night,
with no release notes and no GitHub release. Features in it may be unfinished
and change again before the minor ships. Three things hold all the same:

- **Only green heads.** A nightly is built only from a branch head whose full
  test run passed on exactly that commit: Security & Quality, the integration
  suite and the end-to-end suite. If any of them failed or has not finished,
  that night builds nothing and the previous `:nightly` stays. A night on which
  the branch did not move builds nothing either.
- **Signed and traceable.** The image is multi-arch, signed with cosign
  (below) and carries build provenance and an SBOM. The run log and its
  summary name the digest and the commit. `/api/version` reports
  `channel: "nightly"` and the commit as `buildSha`.
- **Migrations are never edited.** Once a migration is merged into a release
  branch or `main`, it is not changed, renamed or deleted; CI refuses that
  (`docs/contributing/release-policy.md`, "Migrations"). A database a nightly
  migrated therefore moves on to the next nightly and to the release without
  a checksum error.

### Before you switch

- **The automatic dump needs the `backups` volume.** Before it applies a
  migration, the entrypoint writes `healthlog-<time>-pre-migration.dump` into
  `DB_BACKUP_DIR`, the `backups` volume of the published compose file. A
  compose file without that volume gets no dump: take one yourself
  (`docs/ops/disaster-recovery.md`) before the first nightly.
- **There is no way back without a restore.** Migrations only go forward. A
  database that a nightly has migrated cannot be opened by an older image,
  whether the previous nightly or the last release. Going back means stopping
  the app, restoring the dump taken before the migration, and only then
  starting the older image (`docs/ops/disaster-recovery.md`, "Going back to
  before a migration"). Data written since that dump is lost in the restore.
- Edge follows the same rules, for `main`.

## Which channel an instance runs

From 1.50.0 on, and on every nightly, `/api/version` reports `channel` as
`release`, `edge`, `nightly` or `development` (a build without a commit, such
as `pnpm dev`), next to `version` and `buildSha`. Admin > Version and
database shows the same, with the tag to pull for that channel. A nightly's
`version` is the version on the release branch at that night, which is the
previous release until the release commit; the channel and the commit tell it
apart.

## Verifying a nightly's signature

```sh
cosign verify \
  --certificate-identity 'https://github.com/MBombeck/HealthLog/.github/workflows/nightly-image.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mbombeck/healthlog:nightly
```

A release is verified against `docker-publish.yml` on a `v*` tag instead
(`docs/ops/deploy.md`, "Verify the image signature").
