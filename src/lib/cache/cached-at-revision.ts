/**
 * A read-through cache cell for a document that carries its own lock token.
 *
 * A guarded settings GET caches the document together with the token the
 * client echoes on its next save. If anything changes the document without
 * invalidating the cell (a restore, the data wipe, another surface writing
 * the same column), a plain cache would keep handing out the old token, and
 * every save built on it would answer 409 until the cell expired. So the
 * caller reads the document's current revision first (one primary-key read)
 * and the cell is served only while it carries that revision; otherwise it
 * is dropped and rebuilt.
 */
import { cached, type ServerCache } from "@/lib/cache/server-cache";

export async function cachedAtRevision<T extends { updatedAt?: string }>(
  cache: ServerCache<T>,
  key: string,
  revision: string | undefined,
  builder: () => Promise<T>,
  annotateFn?: (fields: { meta: Record<string, unknown> }) => void,
): Promise<T> {
  const value = await cached(cache, key, builder, annotateFn);
  if (value.updatedAt === revision) return value;
  cache.delete(key);
  return cached(cache, key, builder, annotateFn);
}
