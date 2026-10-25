# `prisma/`

The database layer. HealthLog runs on PostgreSQL 18 (the compose default) or 16 via Prisma 7. This directory holds the single schema file and the forward-only migration history; the generated client is emitted elsewhere.

## Contents

- **`schema.prisma`** — 61 models, one file. `cuid()` primary keys, `snake_case` columns via `@map(...)`, encrypted columns mostly suffixed `*Encrypted` (search the file; there are 24 encrypted column references). The `generator client` block emits to `../src/generated/prisma` (imported as `@/generated/prisma`).
- **`migrations/`** — numbered, forward-only SQL migrations (`0001_…` upward). `migration_lock.toml` pins the provider to `postgresql`.

## Migration workflow

```bash
# author a migration from a schema edit
pnpm dlx prisma migrate dev --name <short_snake_case_name>

# regenerate the client after any schema change
pnpm dlx prisma generate
```

Number a new migration with the next free prefix. The production entrypoint runs `prisma migrate deploy` on boot, so every migration must apply cleanly forward — there is no down-migration path. Always include the migration file in the same change as the schema edit.

## Conventions

- Encryption is fail-closed: `*Encrypted` columns are written through `@/lib/crypto` (AES-256-GCM, versioned key ids); never store plaintext in an encrypted column. Key rotation is `scripts/rotate-encryption-key.ts` + `docs/ops/encryption-key-rotation.md`.
- The generated client under `src/generated/prisma` is build output — do not edit it.
- Schema-touching changes that affect the API surface must regenerate `docs/api/openapi.yaml` (see [`../CLAUDE.md`](../CLAUDE.md)).

Related: [`../src/lib/README.md`](../src/lib/README.md) (`db.ts`, `rollups/`), [`../docs/ops/`](../docs/ops/) (migrations + backup runbooks).
