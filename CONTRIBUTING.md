# Contributing to HealthLog

Contributions are welcome. This guide covers how to set up the project and submit changes.

## Prerequisites

- Node.js 22+
- pnpm
- PostgreSQL 16+ (or Docker)
- Git

## Setup

```bash
git clone https://github.com/MBombeck/HealthLog.git
cd HealthLog
cp .env.example .env
```

Edit `.env` and configure at minimum:

```
POSTGRES_PASSWORD=<hex, 32 bytes>
DATABASE_URL="postgresql://healthlog:${POSTGRES_PASSWORD}@db:5432/healthlog"
ENCRYPTION_KEY=<64-char hex>
API_TOKEN_HMAC_KEY=<64-char hex>
```

Generate the three secrets:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"       >> .env
echo "API_TOKEN_HMAC_KEY=$(openssl rand -hex 32)"   >> .env
```

### With Docker (database only)

```bash
docker compose up -d db
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

### Full Docker

```bash
docker compose up -d
```

## Development Workflow

```bash
pnpm dev             # Start dev server (http://localhost:3000)
pnpm lint            # ESLint
pnpm format:check    # Prettier (check)
pnpm typecheck       # TypeScript strict mode
pnpm test            # Vitest
pnpm build           # Next.js production build
```

All five checks must pass before submitting a PR. The full one-liner that mirrors CI:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build
```

## Code Conventions

- **TypeScript strict mode** -- avoid `any`. Where it's truly unavoidable (e.g. variadic Next.js handler signatures in `src/lib/api-handler.ts`), document the reason inline.
- **English-default UI**: the default locale is English, and nine more languages are user-selectable. Code, comments, commit messages, and docs are English. All user-facing strings go through `t("key")`, with the key in every `messages/*.json`. The `i18n-locale-integrity.test.ts` suite blocks merges if keys drift between locales or duplicate at any nesting depth.
- **API responses** follow the `{ data, error }` envelope via `apiSuccess()` / `apiError()` in `src/lib/api-response.ts`. Wrap every route handler in `apiHandler()` (`src/lib/api-handler.ts`) for error handling, structured Wide-Event logging, and `x-request-id` propagation.
- **Zod v4** (`import { ... } from "zod/v4"`) for input validation in API routes and forms.
- **shadcn/ui** components (new-york style) for UI primitives.
- **Dracula theme** -- dark mode is the default; a `light`/`system` toggle is exposed in the topbar. Chart and accent colors use the `--dracula-*` CSS tokens so both themes stay coherent.

Whoever commits a change has read it and stands behind it. Committed text names no real users or reporters and carries no live health figures; fixtures and examples use invented data. Nothing secret, and nothing secret-shaped, goes into code, fixtures or docs.

## Database Changes

```bash
# After modifying prisma/schema.prisma:
pnpm db:migrate     # Creates a new migration
pnpm db:generate    # Regenerates Prisma client
```

Always include the migration file in your PR.

## Branch Model

HealthLog is trunk-based: `main` is the single long-lived branch and is always releasable. There is no `develop` branch. Releases follow a calendar, described in [docs/contributing/release-policy.md](docs/contributing/release-policy.md): a minor on the first Saturday of the month, patches with fixes only on the other Saturdays.

```
   fix/*  ──► PR ──► main ──► tag vX.Y.Z on a Saturday ──► GHCR build
                      │
                      └──► every push: :edge image

   feat/* ──► PR ──► release/vX.Y.0 ──► PR (merge commit) on the first Saturday ──► main ──► tag vX.Y.0
```

The rules:

- **`main` is the fix line.** It always builds, passes CI, and is deployable. Fixes, docs and maintenance land there through pull requests; each user-visible fix adds its line under `## [Unreleased]` in `CHANGELOG.md`. A merge to `main` is not a release; the release is the tag.
- **Features go to `release/vX.Y.0`**, the branch that collects the next minor. It is cut from `main` the day the previous minor ships and merges back with a merge commit on the first Saturday of the month. A pull request to `main` from any other branch fails when it carries a `feat` commit.
- **A release** is a `chore(release): vX.Y.Z` commit on `main` and its tag. The tag push triggers the GHCR multi-arch image build (and `:latest`). Deploy is manual.
- **Hotfixes** outside the calendar are for security problems, data loss and broken installs only. They branch from `main` as `hotfix/vX.Y.Z`, carry one fix, and the publish workflow waits for the maintainer's approval.
- Never force-push `main` or any release branch.

End users: track the latest `v*` tag (or `:latest` on GHCR). `main` carries fixes that are merged but not yet released, so do not deploy `main` itself; the `:edge` image is there to check a fix before its release.

Contributors: branch off `main` for a fix and target `main`; branch off the current `release/vX.Y.0` for a feature and target it. Not sure which one? Open the PR against `main` and the check will say.

## Pull Requests

1. Fork the repository
2. Create a branch: a fix off `main` (`git checkout -b fix/your-fix main`), a feature off the current `release/vX.Y.0`
3. Make your changes
4. Ensure all checks pass (`pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build`)
5. Submit a PR against `main` (fix) or the release branch (feature) with a clear description of the changes

Signing your commits is welcome and not required; [docs/contributing/commit-signing.md](docs/contributing/commit-signing.md) explains the setup and why the rule stops short of requiring it.

## Translations

HealthLog ships with English (`en`) and German (`de`) maintained by the project, plus French (`fr`), Spanish (`es`), Italian (`it`), Polish (`pl`), Korean (`ko`), Dutch (`nl`), Brazilian Portuguese (`pt-BR`) and Russian (`ru`), which started as machine-translated first drafts and are reviewed by the community. The maintained locales are reviewed line by line; the community-reviewed ones show a small banner inviting users to improve them.

### Improving an existing locale

Translation files live at `messages/<locale>.json`. Each key matches the same key in `messages/en.json` (which is the source-of-truth — never delete a key here without coordinating).

To suggest a fix or improvement:

1. Fork the repository.
2. Create a branch like `i18n-fr/<area>` (e.g. `i18n-fr/coach-prompts`, `i18n-pl/dashboard`).
3. Edit `messages/<locale>.json`. Keep the JSON valid; the i18n integrity test will flag missing or extra keys against `en.json` before CI accepts the PR.
4. Open a PR titled `i18n(<locale>): <area>`. Describe what was unclear, awkward, or wrong in the previous wording.

### Translating in the browser

Every locale can be edited in [Fink](https://fink.inlang.com/?repo=MBombeck/HealthLog&project=project.inlang), inlang's browser editor, without cloning the repository. Fink reads `project.inlang/settings.json`, which points it at `messages/<locale>.json`, shows each message next to its translations, and flags strings that are missing or use other placeholders than English.

1. Open the link and sign in with GitHub.
2. Without write access to this repository, choose **Fork**. Fink asks you to install the Inlang GitHub App on your own account so it can push to your fork.
3. Edit, then choose **Push**. Fink commits to the fork; **Open pull request** takes you to GitHub's compare page, where you submit the change against `main`.

Fink writes the same nested JSON this repository uses and changes only the lines you edited. A string you add for a key the locale did not have yet goes to the end of its section instead of the position it has in `en.json`, which is harmless.

What a reviewer checks on a translation pull request:

- Only `messages/*.json` changed, and only the strings the description names.
- Every `{placeholder}` of the English string is still there and spelled the same. The i18n integrity test fails the build otherwise.
- Medical terms are the ones the language's clinical guidelines use, and the register matches the rest of the locale (`du` in German, `você` in Brazilian Portuguese).
- Words the app or the Telegram bot matches literally stay as they are: slash commands, `taken <name>`, and the unit symbols.
- Machine translation is fine as a first draft, but someone who reads the language has gone through every string before the pull request is opened, and the description says so.
- No questionnaire text. The bundles hold the app's own copy around the questionnaires (titles, notes, buttons), never an item, an answer option or a stem; see the next section.

To run the checks Fink shows on a local checkout: `npx @inlang/cli@3.4.4 check --project ./project.inlang`. It reads the files and changes nothing.

### Questionnaire wording

The PHQ-9, GAD-7, WHO-5 and SCI are not translated through the bundles, and Fink never shows them. Their text lives in code, one file per instrument and language under `src/lib/mental-health/wording/<instrument>/<locale>.ts`, because changing a word in a validated questionnaire changes what it measures. Each file declares what it is:

- `validated: true` with a `source`: a published validated translation, reproduced word for word (stem, items, answer options and, for the PHQ-9, the follow-up question, in the form of address the source uses). The source names who made it, the document it was read from with its link, and the terms that allow reproducing it in software. The file's header comment names anything that differs from the printed form, such as a corrected misprint.
- `validated: false`: no validated version exists that may be reproduced, so the file carries a translation written for HealthLog, faithful to the English and on the same scale. The app shows a note beside it that the result is orientation, offers the English original in one tap, and records on the result that it was answered in an unvalidated translation. The header comment names any validated version that was found and why it is not used (paywalled, terms that allow private study only).

To propose a validated version for a language that has none, or a better source for one that does, open an issue or a pull request with the publication, a link to the PDF it can be read from, and its terms of use. A pull request replaces the language's file: the text copied exactly from the PDF, `validated: true`, and the `source` filled in. The tests in `src/lib/mental-health/__tests__/` check that every instrument has text in every language, that every validated entry names its source, and that each answer is bound to the score the instrument gives it; the spot checks in `instrument-wording.test.ts` are the place to pin a line that is easy to transcribe wrongly. A correction to HealthLog's own translation of an unvalidated entry is welcome too; it stays `validated: false`.

### Adding a new locale

If you want to introduce a locale that isn't shipped (e.g. `sv`, `cs`):

1. Open an issue first using the **Translation request** template. We'll confirm the locale is in scope and decide whether it joins the community-reviewed tier or the maintained tier.
2. Copy `messages/en.json` to `messages/<locale>.json`. Questionnaire text is not in it; the new language needs a wording file per instrument instead (see Questionnaire wording above), which step 4 makes impossible to forget.
3. Translate. A machine translation is fine as a starting point, but the PR description should say whether the pass is machine-translated or fully reviewed by someone who reads the language; that decides the banner state.
4. Add the locale to `locales` in `src/lib/i18n/config.ts` and to `locales` in `project.inlang/settings.json`, then run `pnpm typecheck`. Every per-locale table that still lacks the new locale fails to compile, and that list is the work: date and number formatting, the reply-language footers of the Coach and insights prompts, the outbound safety banks, the prose-grounding patterns, the no-key fallback copy and the questionnaire wording registry. Include those in the same PR.
5. Run `pnpm test` before submitting. The i18n guards hold the new bundle to the English keys and placeholders.

### Style guide for translators

- Tone: warm but reserved, curious not pushy. Examples in EN: "Your blood pressure has settled into the green zone" — not "Awesome, your BP is amazing!"
- Numbers and units stay numeric: "120/80 mmHg" stays "120/80 mmHg" in every locale.
- Brand terms stay untranslated: HealthLog, Coach, Tagesbriefing (the DE Coach term — leave as-is in EN if it appears).
- Medical terms: prefer the language community's native medical vocabulary (e.g. "Blutdruck" in DE, "tensión arterial" in ES, "ciśnienie krwi" in PL). When in doubt, mirror the style used in the country's clinical guidelines.
- Avoid US-specific units (lb, oz, °F) — HealthLog is metric-first.
- No PII in copy. No real names, no real readings. Sample data uses round numbers.

### Long-term

Fink covers browser editing today. It edits the files in this repository directly and keeps no copy of the translations anywhere else. If the community outgrows it, a self-hosted [Weblate](https://weblate.org/) instance remains the fallback.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating, you agree to uphold its standards. Reports of unacceptable behavior go to `conduct@healthlog.dev`.

## Security

If you find a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

The project is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). By contributing, you agree that your contributions are submitted under the project license.
