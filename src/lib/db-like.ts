/**
 * Case-insensitive text filters for Prisma, with the value taken literally.
 *
 * On Postgres `mode: "insensitive"` compiles to `ILIKE`, and Prisma passes the
 * value through as the pattern: `_` matches any one character and `%` any
 * run, so a search for `a_b` also found `axb`, and an `equals` was no
 * equality. These filters escape `\`, `%` and `_` with a backslash (the
 * default `LIKE` escape), so every character of the value stands for itself.
 * They are the only place under `src/` that writes `mode: "insensitive"`
 * (`identity-lookup-guard.test.ts`).
 *
 * Search over a person's own records uses them. An account lookup by name or
 * e-mail does not use `ILIKE` at all: it goes through
 * `@/lib/auth/identity-lookup`.
 */

/** `value` with the `LIKE` wildcards and the escape character escaped. */
export function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The column contains `value`, ignoring case. */
export function textContains(value: string) {
  return { contains: likeLiteral(value), mode: "insensitive" as const };
}

/** The column equals `value`, ignoring case. */
export function textEquals(value: string) {
  return { equals: likeLiteral(value), mode: "insensitive" as const };
}
