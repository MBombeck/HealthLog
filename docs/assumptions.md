# Assumptions

Design decisions made without explicit user confirmation. These can be revised.

## General

- **Single-user focus**: The app is designed for a single user (or very few users). No multi-tenant concerns.
- **Language**: UI text is in German. Code and docs are in English.
- **Timezone**: All user-facing timestamps display in `Europe/Berlin`. DB stores UTC.

## Tech Choices

- **Package manager**: pnpm (faster, disk-efficient, strict by default).
- **Prisma output**: Generated client goes to `src/generated/prisma` (gitignored).
- **shadcn/ui style**: "new-york" variant (more compact).
- **Default theme**: Dark (Dracula). Light mode available but secondary.
- **Tailwind v4**: Using the new `@import "tailwindcss"` syntax and CSS-first configuration.

## Security

- **Passkeys as primary auth**: Password is a fallback, not the main path.
- **Session-based auth**: Using server-side sessions stored in PostgreSQL (not JWTs) for easy revocation.
- **Encryption key**: Single symmetric key from env. For production, consider envelope encryption or a KMS.
- **Rate limiting**: Initially in-memory, with Redis backing when Redis is added for BullMQ.

## Database

- **Measurement dedup**: Unique constraint on `(userId, type, measuredAt, source)`. Withings data uses `externalId` for additional dedup.
- **Soft delete**: Not implemented. Audit log tracks destructive actions.
- **Medication intake idempotency**: External ingest uses `idempotencyKey` to prevent double-recording.

## Charts

- **Recharts**: Chosen for React-native integration, smooth line support (`type="monotone"`), and responsive containers. Trade-off: larger bundle than lightweight alternatives.
- **Time ranges**: Default filter options are 7d, 30d, 90d, and custom range.

## Deployment

- **Standalone output**: Next.js `output: "standalone"` for minimal Docker image.
- **Migrations on boot**: The Docker entrypoint runs `prisma migrate deploy` before starting. This is acceptable for single-instance deployments.
