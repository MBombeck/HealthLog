/**
 * The schema a file finds is the schema it leaves.
 *
 * Every file in a worker runs against the same clone of the migrated template
 * (`worker-database.ts`), and `truncateAllTables` resets rows, not structure.
 * A file that replays an old migration, or builds the index an old release
 * had, and does not put the head schema back hands that schema to whichever
 * file the worker runs next. The failure then lands on the next file, which
 * did nothing wrong, and only in the orders that put the two together: the
 * replay of 0515 in `dose-slot-merge` re-created the device index 0538 drops,
 * and `index-hygiene` failed on it whenever a shuffled run put it later in
 * the same worker.
 *
 * The integration setup lists the public schema's indexes, constraints,
 * columns and triggers before a file and after it, and fails the file that
 * changed them, naming what it left behind.
 *
 * Imports nothing from the application, like the rest of the setup.
 */
import { Client } from "pg";

const SCHEMA_SQL = `
  SELECT entry FROM (
    SELECT 'index ' || tablename || ': ' || indexdef AS entry
      FROM pg_indexes WHERE schemaname = 'public'
    UNION ALL
    SELECT 'constraint ' || conrelid::regclass::text || '.' || conname || ': '
           || pg_get_constraintdef(oid)
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'column ' || table_name || '.' || column_name || ': ' || data_type
           || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE '' END
           || COALESCE(' default ' || column_default, '')
      FROM information_schema.columns WHERE table_schema = 'public'
    UNION ALL
    SELECT 'trigger ' || tgrelid::regclass::text || '.' || tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND c.relnamespace = 'public'::regnamespace
  ) s
  ORDER BY entry`;

/** Every structural entry of the public schema, sorted. */
export async function readSchemaEntries(url: string): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ entry: string }>(SCHEMA_SQL);
    return rows.map((r) => r.entry);
  } finally {
    await client.end();
  }
}

/** What `after` has that `before` lacks, and the other way round. */
export function schemaDrift(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: after.filter((e) => !was.has(e)),
    removed: before.filter((e) => !now.has(e)),
  };
}
