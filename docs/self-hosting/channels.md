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

A nightly is not a release. It is the release branch as it stood that
night: features that are half done, migrations that may still change before
the release, and bugs nobody has found yet. It has no release notes and no
GitHub release, and nothing about it is promised. Do not run it on an
instance whose data you need.

Migrations only go forward. A database that a nightly has migrated cannot be
opened by the previous release again; the way back is the dump the entrypoint
writes before a migration (`healthlog-<time>-pre-migration.dump` in the
`backups` volume) or a backup of your own taken before the switch. Run a
nightly on a copy of your data, not on the original. The same holds, to a
smaller degree, for edge.

## Which channel an instance runs

From 1.50.0 on, and on every nightly, `/api/version` reports `channel` as
`release`, `edge`, `nightly` or `development` (a build without a commit, such
as `pnpm dev`), next to `version` and `buildSha`. Admin > Version and database shows the same, with
the tag to pull for that channel. A nightly's `version` is the version on the
release branch at that night, which is the previous release until the release
commit; the channel and the commit tell it apart.

## Verifying a nightly's signature

```sh
cosign verify \
  --certificate-identity 'https://github.com/MBombeck/HealthLog/.github/workflows/nightly-image.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/mbombeck/healthlog:nightly
```

A release is verified against `docker-publish.yml` on a `v*` tag instead
(`docs/ops/deploy.md`, "Verify the image signature").
