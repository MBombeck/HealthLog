# Release policy

HealthLog ships on a calendar. This page says when a release happens, what it
may contain, and what counts as a reason to break the schedule. Where an older
document, a code comment or a habit disagrees, this page wins.

## Calendar

- **Minor release (`X.Y.0`):** the first Saturday of the month. It ships with
  everything that is done and green on `release/vX.Y.0` by then. Whatever is
  not ready waits for the next month; the release does not wait for a feature.
- **Patch release (`X.Y.Z`):** any other Saturday, when there is something a
  user would notice. A week with nothing worth shipping has no release.
- **One release per Saturday.**

Releases ship on Saturday because that is when self-hosters have time to read
the notes and update.

A Saturday runs from 00:00 on Saturday to 06:00 on Sunday, Europe/Berlin, so
an evening release may run past midnight.

A minor is due on the first Saturday of the calendar month after the month
of the previous minor. For a minor on a first Saturday that is simply the next
month.

### Starting point

1.49.0 is the last release before the calendar. It shipped on 2026-11-23, when
the work planned for it was done and green. The calendar applies to every tag
after it: the first scheduled minor, 1.50.0, is on the first Saturday of
December, 2026-12-05, and 1.51.0 follows on 2027-01-02. The Saturday in
between, 2026-11-28, is a patch Saturday.

## What goes where

A patch contains fixes only. Its changelog entry has `### Fixed` and
`### Security`, plus `### Updating` when an operator has a step to take and
`### Thanks`. No other heading.

| Change                                                   | Patch                                                               | Minor                               |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Bug fix, security fix, security update of a dependency   | yes                                                                 | yes                                 |
| Translation and copy corrections, documentation          | yes                                                                 | yes                                 |
| Small performance fix with no change in behaviour        | yes                                                                 | yes                                 |
| Database migration                                       | only when a fix needs it, additive, run against a copy of real data | yes                                 |
| New feature, new surface, new setting                    | no                                                                  | yes                                 |
| New route, new field in the API contract, new capability | no                                                                  | yes                                 |
| New or changed environment variable, compose change      | no                                                                  | yes                                 |
| Major dependency update (Next, Prisma, Node, Postgres)   | no                                                                  | yes                                 |
| New locale                                               | no                                                                  | yes                                 |
| Removing or renaming a route, flag or integration        | no                                                                  | yes, announced one minor in advance |

The major version stays at 1. A breaking change ships in a minor and is
announced in the notes of the minor before it. The minor number counts months,
not size: a month that brought mostly fixes and speed is still `X.Y.0`.

## Migrations

A migration merged into `main` or a `release/vX.Y.0` branch is never changed
again: not edited, not renamed, not renumbered, not deleted. Only new files
appear under `prisma/migrations/`. An `:edge` host has applied every
migration on `main` and a `:nightly` host every one on the release branch,
and Prisma refuses to start when a migration it ran has a different checksum
now. A mistake in a merged migration is corrected by a new migration.
`.github/workflows/migration-immutability.yml` fails any push or pull request
to `main` or `release/**` that changes an existing file there
(`node scripts/release-policy.mjs migrations`).

## Out-of-schedule releases

A release leaves the schedule for one of three reasons and no other:

1. **Security.** A vulnerability that can be exploited on a default install or
   from an ordinary account, rated high or critical. Lower ratings ship on the
   next Saturday.
2. **Data loss.** Writes are lost, wrong data is stored, backup or restore is
   broken, or a migration destroys something.
3. **Broken install.** The container does not start, a migration fails, sign-in
   is impossible, the app is unusable for a whole class of clients after an
   update, or medication reminders stop arriving.

Anything else waits for Saturday. It is on `main` and in the `:edge` image the
moment it is merged.

Procedure:

1. Branch `hotfix/vX.Y.Z` from `main`. The fix and nothing else.
2. The changelog entry opens, directly under its heading, with one line:
   `Out of schedule: <security | data loss | broken install>, <one sentence>`.
3. Pull request to `main`, green CI, merge, release commit, tag.
4. The publish workflow sees a tag outside the calendar and waits for the
   maintainer's approval on the `off-schedule-release` environment.
5. The release notes open with the reason in one sentence.
6. For a security fix, a GitHub Security Advisory is published with the
   release. The notes say that it is a security fix and that updating is
   recommended. Details follow no sooner than seven days later.

An out-of-schedule release does not move or replace the next Saturday.

## Third-party updates

Dependabot proposes updates weekly for npm, GitHub Actions, the Docker base
image and the compose file; the dependency audit and the image scan run every
day. An advisory is rated by what it means for HealthLog: whether the
vulnerable code is reachable on a default install or from an ordinary
account, not only by the score the advisory carries. The clock starts when a
fixed version of the dependency is available.

| Rating                        | Ships                                                 | At the latest                    |
| ----------------------------- | ----------------------------------------------------- | -------------------------------- |
| Critical or high, reachable   | an out-of-schedule patch (reason: security)           | 7 days                           |
| Medium                        | the next patch Saturday                               | the Saturday after next          |
| Low, or not reachable         | the next minor                                        | the first Saturday of next month |
| No advisory (routine updates) | collected on `release/vX.Y.0`, shipped with the minor | monthly                          |

A security update that needs a major version of a dependency is still a
security fix and follows the table, not the "major dependency update" row
above. When no fixed version exists yet, the release notes or the advisory
say what an operator can do in the meantime. The image scan fails on a
critical finding in the published image, so a critical one cannot sit
unnoticed.

## Where work collects

- **`main`** is the fix line. Fixes land continuously through `fix/X` branches
  and pull requests. Every commit is releasable, but a merge is not a release.
  A release is the tag made on Saturday, preceded by one `chore(release): vX.Y.Z`
  commit (version, changelog heading, regenerated OpenAPI).
- **`release/vX.Y.0`** collects the next minor. It is cut from `main` the day
  the previous minor ships and takes features through `feat/X` branches. After
  each patch tag, `main` is merged into it: one direction, never a rebase,
  never a force-push. A pull request into it, and a push to it, runs the same
  battery as one into `main`; only the fix-line check is `main`'s alone.
  `src/__tests__/release-branch-ci-coverage-guard.test.ts` fails when a gate
  workflow covers `main` and not `release/**`.
- **`CHANGELOG.md`** keeps an `## [Unreleased]` section at the top. Each fix
  adds its line there in the same pull request; on release day the section
  becomes the version heading. The release branch keeps its own section for
  the minor.

There is no backporting and no second long-lived branch. Fixes start on `main`
and flow forward. A fix that only concerns the coming minor stays on the
release branch.

## Release day

For a minor, the release branch goes to `main` as a pull request with the same
gate as always:

- CI green on the pull request, the full battery included (unit, integration,
  end-to-end, build).
- An adversarial review of the whole diff since the previous minor, with every
  finding of medium severity or above fixed or written down as accepted.
- The Security & Quality push run green for the exact merge commit on `main`
  before the tag is pushed.

Then merge with a merge commit, tag, delete the branch and cut the next
`release/vX.Y.0` from `main`. The tag is annotated and signed, on the merge
commit:

```sh
git tag -s -m "vX.Y.Z" vX.Y.Z <merge-sha>
git push origin vX.Y.Z
```

A bare `git tag vX.Y.Z` stops at "no tag message" where `tag.gpgsign` is on,
and the tag ruleset allows no delete and no move, so a wrong tag cannot be
taken back: check the sha before the push. `pnpm release:next` prints the
command on a release day. The calendar check dates an annotated tag by its
tagger date (`creatordate`); the lightweight tags up to v1.48.5 are dated by
their commit. Red is never shipped. If the gate is not green on
the first Saturday, the work that holds it up leaves the branch and the rest
ships.

A patch is the same on a smaller scale: release commit on `main`, Security &
Quality green for it, tag (annotated and signed, as above).

After any release, `/api/version` is checked on every deploy target
(`docs/ops/deploy.md`).

The tag build attaches a signed image manifest, its cosign bundle and its
SLSA provenance to the GitHub release for the tag, and creates that release
as a draft when it does not exist yet. It never publishes. The release is
made public by editing the draft (notes, then `--draft=false`), not by
creating a second one: `docs/ops/deploy.md`, "The GitHub release".

## Images

| Tag                                      | Built from                           | For                                   |
| ---------------------------------------- | ------------------------------------ | ------------------------------------- |
| `:latest`, `:X.Y.Z`                      | a release tag on `main`              | everyone                              |
| `:edge`, `:edge-<commit>`                | every push to `main`                 | checking a fix before Saturday        |
| `:nightly`, `:nightly-YYYYMMDD-<commit>` | the newest `release/vX.Y.0`, nightly | trying the next minor, not production |

`:edge` is amd64 only and unsigned. Its `/api/version` reports the version of
the release it builds on and the commit, and from 1.50.0 on the channel
`edge`. It carries fixes only, but it is not a release. Take a
backup before you try it: migrations do not run backwards.

`:nightly` is built every night from the release branch of the next minor,
when its head moved since the last nightly and Security & Quality, the
integration suite and the end-to-end suite all passed on a push run for that
exact commit; otherwise the previous `:nightly` stays. It is multi-arch and
signed like a release, but it is not one: no `v*` tag, no `:latest`, no GitHub
release. `/api/version` reports it as the channel `nightly`.
[`docs/self-hosting/channels.md`](../self-hosting/channels.md) has the compose
line for each channel.

## The iOS app

The iOS app keeps its own schedule. These rules connect it to the server:

- The API contract changes in minor releases only.
- The app reads the capabilities the server announces. It never decides a
  feature by comparing version numbers.
- The app supports the current and the previous minor. A self-hoster who
  updates once a month is always covered.
- The server ships first, then the app. An app release that needs a newer
  server reaches the App Store no earlier than that server's release and names
  the minimum version in its notes.

A field or route that a published app version reads is marked deprecated in
one minor and removed no earlier than two minors later.

## Enforcement

- `scripts/release-policy.mjs` holds the calendar and the content rules, with
  its tests in `scripts/__tests__/release-policy.test.ts`.
- `pnpm release:next` prints the next patch and minor, their dates, how many
  entries wait under `## [Unreleased]`, and whether today is a release day.
  Run it before any release step.
- The `release-policy` job in `.github/workflows/docker-publish.yml` runs the
  same script on every tag. A tag that breaks a rule fails without the
  `Out of schedule:` line; with it, publishing waits for approval on the
  `off-schedule-release` environment.
- `.github/workflows/release-branch-policy.yml` fails a pull request to `main`
  from anything other than a `release/v*` branch when it carries a `feat`
  commit or adds a heading under `## [Unreleased]` that a patch cannot have.
- `.github/workflows/edge-image.yml` publishes `:edge` on every push to
  `main`.
- `.github/workflows/migration-immutability.yml` refuses a change to a merged
  migration on `main` and `release/**`, and a pull request to either that
  deletes a file under `.github/workflows/`, `scripts/`, `prisma/migrations/`
  or `docs/` which the base still has, unless the description names the file
  on a `Removes:` line (`node scripts/release-policy.mjs deletions`). A
  branch rebuilt from a stale copy deletes whatever landed on its base after
  it was cut, and no test notices a workflow or a page that is gone.
- `.github/workflows/nightly-image.yml` publishes `:nightly` from the newest
  `release/vX.Y.0` every night, skips a night on which the branch did not
  move or is not green, and checks the published image's `/api/version` through
  `post-publish-verify.yml`.
- The `release-manifest`, `release-provenance` and `release-assets` jobs in
  `docker-publish.yml` attach the signed manifest and its provenance to the
  release for every `v*` tag, with the shape held by
  `scripts/__tests__/release-workflows.test.ts`.
- The `image-provenance` job in `docker-publish.yml` calls
  `.github/workflows/image-provenance.yml`, which signs SLSA Build L3
  provenance for the image index on every `v*` tag and verifies it. Tag
  builds use no shared build cache. The same test file holds both.

What the checks cannot do: they do not catch a feature committed as `fix`. The
changelog rule catches part of that, review the rest.
