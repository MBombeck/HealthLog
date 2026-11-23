/**
 * Resolving a wipe model name to the Prisma delegate that deletes its rows,
 * for one account or for all of them. The plan of which models a wipe covers
 * lives in `wipe-plan.ts`; this file only turns a name into a delete.
 */
import {
  WIPE_KEPT_ROWS,
  WIPE_OWNER_FIELDS,
  wipeDelegateKey,
  wipeWhere,
} from "./wipe-plan";

/** The narrow slice of a Prisma delegate the wipe loop uses. */
export interface UserScopedDeleteDelegate {
  deleteMany(args: { where: { userId: string } }): Promise<{ count: number }>;
}

/** The same slice for the admin wipe, which selects no account at all. */
export interface UnscopedDeleteDelegate {
  deleteMany(args: Record<string, never>): Promise<{ count: number }>;
}

interface RawDeleteDelegate {
  deleteMany(args: { where?: object }): Promise<{ count: number }>;
}

/**
 * The Prisma delegate for a model name, or a thrown error naming the model.
 *
 * One documented cast: {@link WIPE_MODELS} is a literal list of model names
 * checked against `schema.prisma` by the completeness test, and every entry
 * indexes a delegate that exposes `deleteMany`. The test also asserts every
 * entry resolves, so an unresolvable name fails the build rather than the
 * request.
 */
function rawDelegate(client: object, model: string): RawDeleteDelegate {
  const delegate = (client as Record<string, RawDeleteDelegate>)[
    wipeDelegateKey(model)
  ];
  if (!delegate || typeof delegate.deleteMany !== "function") {
    throw new Error(`No Prisma delegate for wipe model "${model}"`);
  }
  return delegate;
}

/**
 * Resolve a model name to its delegate on a client or transaction handle.
 *
 * A model listed in {@link WIPE_OWNER_FIELDS} gets a wrapper that rewrites the
 * caller's `{ userId }` into that model's own ownership predicate. The caller
 * still says "this account's rows" and still gets a count back; only the
 * translation moved, and it moved to the file that declares the columns rather
 * than to the loop that does not know about them.
 */
export function resolveWipeDelegate(
  client: object,
  model: string,
): UserScopedDeleteDelegate {
  const delegate = rawDelegate(client, model);
  if (!WIPE_OWNER_FIELDS[model] && !WIPE_KEPT_ROWS[model]) {
    return delegate as UserScopedDeleteDelegate;
  }
  return {
    deleteMany: ({ where }) =>
      delegate.deleteMany({ where: wipeWhere(model, where.userId) }),
  };
}

/**
 * Resolve a model name to a delegate that deletes every row of it.
 *
 * The admin wipe asks a different question from the per-account one — "every
 * row of this model" rather than "this account's rows" — so it gets its own
 * resolver instead of a `where` the caller has to remember to leave out.
 * {@link WIPE_OWNER_FIELDS} is irrelevant here by construction: with no
 * account to select, a row that belongs to two of them is deleted once.
 */
export function resolveGlobalWipeDelegate(
  client: object,
  model: string,
): UnscopedDeleteDelegate {
  const delegate = rawDelegate(client, model);
  return { deleteMany: () => delegate.deleteMany({}) };
}
