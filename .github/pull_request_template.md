## What and why

<!-- One to three sentences. Link the issue: "Fixes #123" or "Refs #123". -->

## How it was tested

<!-- Commands, manual steps, and screenshots for a UI change (phone and desktop width). -->

## Checklist

- [ ] A fix targets `main`, a feature the current `release/vX.Y.0` (see [CONTRIBUTING.md](../CONTRIBUTING.md#branch-model))
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm build` pass
- [ ] A changed request or response schema comes with a regenerated `docs/api/openapi.yaml` (`pnpm openapi:generate`)
- [ ] A user-visible fix has its line under `## [Unreleased]` in `CHANGELOG.md`
- [ ] New UI text goes through `t("key")`, with the key in every `messages/*.json`
- [ ] No personal data anywhere in the change or this description: no real names, health figures, account identifiers or secrets
