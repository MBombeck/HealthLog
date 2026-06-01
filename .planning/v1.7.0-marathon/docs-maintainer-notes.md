# Docs update — maintainer framing notes (apply at docs review)

## Gravatar → self-hosted avatars: tell the migration story, don't just swap the fact
The two Gravatar hallucinations (`api/authentication.mdx`, `configuration/admin-settings.mdx`)
should NOT merely be replaced with "returns a self-hosted avatarUrl". Per the
maintainer (2026-05-31), state the HISTORY explicitly and frame it as a privacy win:
- HealthLog used to use Gravatar.
- It was deliberately changed to self-hosted avatars **for privacy reasons** — Gravatar
  resolves an avatar from a hash of the user's email at a third-party service, which
  leaks that the email is in use (and to whom) off the self-hosted instance.
- Now avatars are uploaded + served from the operator's own instance; nothing about
  the user leaves it.
Keep it factual and short — one or two sentences in the maintainer's voice. No
marketing tone. This turns a stale doc line into a documented privacy improvement.

When the docs-site agent returns, verify this framing is present at both sites; if it
only swapped the fact, adjust to include the migration story.

## General principle (maintainer, 2026-05-31): explain the WHY at critical points
The maintainer wants the docs to explain *why* a decision was made at critical
architecture / privacy / security points — a short rationale, not just the what.
At the docs review, add a one-or-two-sentence "why" wherever a non-obvious choice
appears, e.g.:
- self-hosted avatars over Gravatar (privacy — above)
- Postgres-backed sessions (no SESSION_SECRET / no stateless JWT) — server-side
  revocation, sliding expiry, no secret to leak
- AES-256-GCM encryption at rest — what's protected and why fail-closed
- FHIR R4 for the health-record export — interoperability / German ePA ingests FHIR
- soft-delete tombstones — needed so an offline client learns of deletions
- requireAdmin cookie-only — a Bearer token can never reach admin, by construction
- BYOK / multi-provider AI — no vendor lock-in, data stays under operator control
- AGPL-3.0 — why copyleft for a self-hosted health app
Keep each rationale short, factual, maintainer's voice. Don't bolt a "why" onto
trivial settings — only where a reader would reasonably ask "why this way?".
