/**
 * A value made safe for a Prisma `contains` / `startsWith` / `equals` filter
 * with `mode: "insensitive"`.
 *
 * On Postgres that filter compiles to `ILIKE`, and Prisma passes the value
 * through as the pattern: `_` matches any one character and `%` any run, so a
 * search for `a_b` also found `axb`, and an `equals` was not an equality.
 * Escaping `\`, `%` and `_` with a backslash (the default `LIKE` escape) makes
 * every character of the value stand for itself.
 *
 * Search over a person's own records uses this. An account lookup by name or
 * e-mail does not use `ILIKE` at all: it goes through
 * `@/lib/auth/identity-lookup`.
 */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
