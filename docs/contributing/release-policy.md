# Release policy

HealthLog ships on a calendar. This page says when a release happens, what it
may contain, and what counts as a reason to break the schedule. Where an older
document, a code comment or a habit disagrees, this page wins.

## Calendar

- **Minor release (`X.Y.0`):** the first Tuesday of the month. It ships with
  everything that is done and green on `release/vX.Y.0` by then. Whatever is
  not ready waits for the next month; the release does not wait for a feature.
- **Patch release (`X.Y.Z`):** any other Tuesday, when there is something a
  user would notice. A week with nothing worth shipping has no release.
- **One release per Tuesday.**

A Tuesday runs from 00:00 on Tuesday to 06:00 on Wednesday, Europe/Berlin, so
an evening release may run past midnight.

A minor's month starts at least three weeks after the previous minor shipped.
For a minor on a first Tuesday that is always the next month. The rule matters
once: after 1.49.0, which ships on no fixed day.

### Starting point

1.49.0 is the last release before the calendar. It ships when the work planned
for it is done and green, on whatever day that is. The calendar applies to
every tag after it: the first scheduled minor, 1.50.0, is on the first Tuesday
of the first month that starts at least three weeks after 1.49.0 ships, and the
Tuesdays in between are patch Tuesdays.

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

## Out-of-schedule releases

A release leaves the schedule for one of three reasons and no other:

1. **Security.** A vulnerability that can be exploited on a default install or
   from an ordinary account, rated high or critical. Lower ratings ship on the
   next Tuesday.
2. **Data loss.** Writes are lost, wrong data is stored, backup or restore is
   broken, or a migration destroys something.
3. **Broken install.** The container does not start, a migration fails, sign-in
   is impossible, the app is unusable for a whole class of clients after an
   update, or medication reminders stop arriving.

Anything else waits for Tuesday. It is on `main` and in the `:edge` image the
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

An out-of-schedule release does not move or replace the next Tuesday.

## Where work collects

- **`main`** is the fix line. Fixes land continuously through `fix/X` branches
  and pull requests. Every commit is releasable, but a merge is not a release.
  A release is the tag made on Tuesday, preceded by one `chore(release): vX.Y.Z`
  commit (version, changelog heading, regenerated OpenAPI).
- **`release/vX.Y.0`** collects the next minor. It is cut from `main` the day
  the previous minor ships and takes features through `feat/X` branches. After
  each patch tag, `main` is merged into it: one direction, never a rebase,
  never a force-push.
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
`release/vX.Y.0` from `main`. Red is never shipped. If the gate is not green on
the first Tuesday, the work that holds it up leaves the branch and the rest
ships.

A patch is the same on a smaller scale: release commit on `main`, Security &
Quality green for it, tag.

After any release, `/api/version` is checked on every deploy target
(`docs/ops/deploy.md`).

## Images

| Tag                       | Built from              | For                           |
| ------------------------- | ----------------------- | ----------------------------- |
| `:latest`, `:X.Y.Z`       | a release tag on `main` | everyone                      |
| `:edge`, `:edge-<commit>` | every push to `main`    | checking a fix before Tuesday |

`:edge` is amd64 only, unsigned, and reports its version as the release line
plus `-edge.<commit>`. It carries fixes only, but it is not a release. Take a
backup before you try it: migrations do not run backwards.

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

What the checks cannot do: they do not catch a feature committed as `fix`. The
changelog rule catches part of that, review the rest.
