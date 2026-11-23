import { prisma } from "@/lib/db";

/**
 * Account lookup by e-mail address or username, regardless of case.
 *
 * The one place an account is found by a name a person typed or an identity
 * provider sent. Each query compares `lower(column) = lower($1)`: an exact
 * equality on the expression the case-blind unique keys of migration 0517
 * are built on (`users_email_lower_key`, `users_username_lower_key`), so the
 * lookup and the uniqueness rule mean the same thing and the lookup reads
 * the index.
 *
 * Prisma's `mode: "insensitive"` is not used for these columns, and must not
 * be: on Postgres it compiles to `ILIKE`, where `_` and `%` in the value are
 * wildcards. `a_ice` found `alice`, `%` found any account, and an invitation
 * meant for `j_doe` could reach `jxdoe`. `identity-lookup-guard.test.ts`
 * keeps the operator off the identity columns everywhere under `src/`.
 *
 * Every function returns the account id, or null. A caller that needs more of
 * the row reads it by that id.
 */

type IdRow = { id: string };

/** The account whose e-mail address equals `email`, ignoring case. */
export async function findUserIdByEmail(
  email: string,
  options: { excludeId?: string } = {},
): Promise<string | null> {
  const rows = options.excludeId
    ? await prisma.$queryRaw<IdRow[]>`
        SELECT "id" FROM "users"
         WHERE lower("email") = lower(${email})
           AND "id" <> ${options.excludeId}
         LIMIT 1`
    : await prisma.$queryRaw<IdRow[]>`
        SELECT "id" FROM "users"
         WHERE lower("email") = lower(${email})
         LIMIT 1`;
  return rows[0]?.id ?? null;
}

/** The account whose username equals `username`, ignoring case. */
export async function findUserIdByUsername(
  username: string,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<IdRow[]>`
    SELECT "id" FROM "users"
     WHERE lower("username") = lower(${username})
     LIMIT 1`;
  return rows[0]?.id ?? null;
}

/**
 * The account a sign-in name names: its e-mail address or its username,
 * ignoring case. The two keys are unique each on their own, so at most one
 * account matches either; should one account's address equal another's
 * username, the address wins, so the answer never depends on row order.
 */
export async function findUserIdBySignInName(
  identifier: string,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<IdRow[]>`
    SELECT "id" FROM "users"
     WHERE lower("email") = lower(${identifier})
        OR lower("username") = lower(${identifier})
     ORDER BY (lower("email") = lower(${identifier})) IS TRUE DESC
     LIMIT 1`;
  return rows[0]?.id ?? null;
}
