# Contributing to HealthLog

Contributions are welcome. This guide covers how to set up the project and submit changes.

## Prerequisites

- Node.js 20+
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
POSTGRES_PASSWORD=<base64, 24 bytes>
DATABASE_URL="postgresql://healthlog:${POSTGRES_PASSWORD}@db:5432/healthlog"
SESSION_SECRET=<64-char hex>
ENCRYPTION_KEY=<64-char hex>
API_TOKEN_HMAC_KEY=<64-char hex>
```

Generate the four secrets:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)" >> .env
echo "SESSION_SECRET=$(openssl rand -hex 32)"       >> .env
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
- **English-default UI** -- the default locale is English. German is user-selectable. Code, comments, commit messages, and docs are English. All user-facing strings go through `t("key")` with translations in both `messages/en.json` and `messages/de.json`. The `i18n-locale-integrity.test.ts` suite blocks merges if keys drift between locales or duplicate at any nesting depth.
- **API responses** follow the `{ data, error }` envelope via `apiSuccess()` / `apiError()` in `src/lib/api-response.ts`. Wrap every route handler in `apiHandler()` (`src/lib/api-handler.ts`) for error handling, structured Wide-Event logging, and `x-request-id` propagation.
- **Zod v4** (`import { ... } from "zod/v4"`) for input validation in API routes and forms.
- **shadcn/ui** components (new-york style) for UI primitives.
- **Dracula theme** -- dark mode is the default; a `light`/`system` toggle is exposed in the topbar. Chart and accent colors use the `--dracula-*` CSS tokens so both themes stay coherent.

See `CONTRIBUTING-AI.md` for detailed architecture and patterns.

## Database Changes

```bash
# After modifying prisma/schema.prisma:
pnpm db:migrate     # Creates a new migration
pnpm db:generate    # Regenerates Prisma client
```

Always include the migration file in your PR.

## Branch Model

HealthLog uses a long-lived `develop` branch for daily work and reserves `main` for releases.

```
   feature/* ──┐
               ├──► develop ──► (release-merge) ──► main ──► tag vX.Y.Z ──► GHCR build ──► Coolify deploy
   fix/*    ──┘                                        │
                                                       └──► hotfix/* ──► main + tag, then merge back to develop
```

Two simple rules:

- **`develop` is the daily target.** Open feature, fix, test, and docs PRs against `develop`. Builds do not run on `develop` pushes — the branch is free of release ceremony.
- **`main` is release-only.** It receives a single release-merge per version, gets tagged (`v1.4.20`, etc.), and that tag is what triggers the Docker image build, the GHCR push, and the Coolify deploy. Pushes to `main` outside a release are reserved for hotfixes that cannot wait for the next cycle.

If a critical bug needs a hotfix:

1. Branch from `main`: `git checkout -b hotfix/something main`
2. Land the fix; tag a patch release on `main`
3. Merge `main` back into `develop` so the next release inherits the fix

End users: track the latest `v*` tag (or `:latest` on GHCR). The `main` branch always equals the latest release.

Contributors: track `develop`. PRs target `develop`.

## Pull Requests

1. Fork the repository
2. Create a feature branch off `develop` (`git checkout -b feature/your-feature develop`)
3. Make your changes
4. Ensure all checks pass (`pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build`)
5. Submit a PR against `develop` with a clear description of the changes

## Translations

HealthLog ships with English (`en`) and German (`de`) maintained by the project, plus French (`fr`), Spanish (`es`), Italian (`it`), and Polish (`pl`) that are **AI-initial, community-maintained**. The maintained locales are reviewed line-by-line; the community-maintained ones surface a small banner inviting users to improve them.

### Improving an existing locale

Translation files live at `messages/<locale>.json`. Each key matches the same key in `messages/en.json` (which is the source-of-truth — never delete a key here without coordinating).

To suggest a fix or improvement:

1. Fork the repository.
2. Create a branch like `i18n-fr/<area>` (e.g. `i18n-fr/coach-prompts`, `i18n-pl/dashboard`).
3. Edit `messages/<locale>.json`. Keep the JSON valid; the i18n integrity test will flag missing or extra keys against `en.json` before CI accepts the PR.
4. Open a PR titled `i18n(<locale>): <area>`. Describe what was unclear, awkward, or wrong in the previous wording.

### Adding a new locale

If you want to introduce a locale that isn't shipped (e.g. `nl`, `pt-BR`, `cs`):

1. Open an issue first using the **Translation request** template. We'll confirm the locale is in scope and decide whether it joins the AI-initial-community-maintained tier or the maintained tier.
2. Copy `messages/en.json` to `messages/<locale>.json`.
3. Translate. AI assistance is welcome as a starting point but the PR description should note whether it's an AI-initial pass or a fully human-reviewed one — that information drives the banner state.
4. Add the locale to the supported list in `src/lib/i18n/locales.ts` (or wherever the registry lives — grep `SUPPORTED_LOCALES`).
5. The Coach system prompts at `src/lib/ai/prompts/coach-prompt.ts` and `src/lib/ai/prompts/insight-generator.ts` and the doctor-report PDF strings need translation too. Include those in the same PR.
6. Run `pnpm test -- i18n-integrity` locally before submitting.

### Style guide for translators

- Tone: warm but reserved, curious not pushy. Examples in EN: "Your blood pressure has settled into the green zone" — not "Awesome, your BP is amazing!"
- Numbers and units stay numeric: "120/80 mmHg" stays "120/80 mmHg" in every locale.
- Brand terms stay untranslated: HealthLog, Coach, Tagesbriefing (the DE Coach term — leave as-is in EN if it appears).
- Medical terms: prefer the language community's native medical vocabulary (e.g. "Blutdruck" in DE, "tensión arterial" in ES, "ciśnienie krwi" in PL). When in doubt, mirror the style used in the country's clinical guidelines.
- Avoid US-specific units (lb, oz, °F) — HealthLog is metric-first.
- No PII in copy. No real names, no real readings. Sample data uses round numbers.

### Long-term

When the community grows beyond ad-hoc PRs, we'll spin up a self-hosted [Weblate](https://weblate.org/) instance. That replaces the JSON-PR workflow with a web UI but keeps every translation under our own roof — no third-party telemetry. Tracking issue: `v1.6 — Weblate self-hosted on edge-01`.

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating, you agree to uphold its standards. Reports of unacceptable behavior go to `conduct@bombeck.io`.

## Security

If you find a security vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.
