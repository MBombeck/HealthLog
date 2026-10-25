/**
 * Restore a whole-database dump into an empty database.
 *
 *   docker compose run --rm db-restore list [directory]
 *   docker compose run --rm db-restore latest
 *   docker compose run --rm db-restore <file> [--ignore-key-mismatch]
 *
 * Runs in the app image with plain `node` (no `tsx`, no source checkout), as
 * the `db-restore` compose service, so a new server needs only the compose
 * file, the keys and the dump. `<file>` is a name in `DB_BACKUP_DIR` or a
 * path inside the container: a `.dump` written on a server, or a `.dump.enc`
 * downloaded from the off-host bucket (`database/` prefix), with its manifest
 * (`.manifest.json` or `.manifest.json.enc`) beside it.
 *
 * In this order, and it stops at the first thing that is wrong, before it
 * writes anything:
 *   1. an off-host copy is opened with BACKUP_ENCRYPTION_KEY (or a key in
 *      BACKUP_ENCRYPTION_PREVIOUS_KEYS) into a temporary file;
 *   2. the dump's SHA-256 and size must equal the manifest's;
 *   3. the keys in this environment are compared with the manifest's
 *      fingerprints; each one missing or different is named, and a mismatch
 *      of the active encryption key refuses (`--ignore-key-mismatch` restores
 *      anyway, for an operator who knows the key is lost);
 *   4. the target database must hold no table at all. This never overwrites.
 * Then `pg_restore` in one transaction, `ANALYZE`, and a count of every table
 * against the manifest. A count that differs empties the database again and
 * fails, so the app is never started on a restore that does not match.
 *
 * Exit 0 restored (or listed), 1 refused or failed, 2 usage.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compareKeyFingerprints,
  compareRowCounts,
  connect,
  countRows,
  decryptOffhostFile,
  emptyDatabase,
  hashFile,
  isGoodSet,
  isWritableDirectory,
  keyFingerprints,
  listDumpSets,
  listUserTables,
  offhostKeysFromEnv,
  offhostObjectKey,
  parseDumpFileName,
  parseManifest,
  resolveBackupDir,
  runTool,
  statOrNull,
  connectionFromUrl,
} from "../src/lib/database-backup/dump-core.mjs";
import { shippedMigrations } from "./pending-migrations.mjs";

const out = (line = "") => console.log(line);
const say = (line) => console.log(`db-restore: ${line}`);

class Refusal extends Error {}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Whether this image knows the dump's newest migration. A dump from a newer
 * release restored under an older image leaves the app with a schema its code
 * does not expect, so the restore says which image to run.
 */
function imageKnowsMigration(name) {
  if (!name) return true;
  try {
    return shippedMigrations(
      join(process.cwd(), "prisma", "migrations"),
    ).includes(name);
  } catch {
    return true;
  }
}

function listCommand(dir) {
  const sets = listDumpSets(dir);
  if (sets.length === 0) {
    say(`no dumps in ${dir}`);
    return 0;
  }
  out(`Dumps in ${dir}, newest first:`);
  for (const set of sets) {
    const state = isGoodSet(set)
      ? `${mb(set.dump.bytes)}`
      : set.encryptedDump
        ? "off-host copy (.enc)"
        : set.dump
          ? "no manifest, not restorable"
          : "incomplete";
    out(
      `  ${set.base}.dump${set.encryptedDump && !set.dump ? ".enc" : ""}  ${set.kind}  ${set.timestamp.toISOString()}  ${state}`,
    );
  }
  return 0;
}

/**
 * The dump and manifest to restore: a local pair, or an encrypted pair
 * opened into `scratch`.
 */
async function resolveInput(arg, dir, env) {
  if (arg === "latest") {
    const set = listDumpSets(dir).find(
      (s) =>
        isGoodSet(s) ||
        (s.encryptedDump !== null &&
          (s.encryptedManifest !== null || s.manifest !== null)),
    );
    if (!set) throw new Refusal(`no restorable dump in ${dir}`);
    arg = set.dump ? set.dump.path : set.encryptedDump;
  }
  const path = isAbsolute(arg) ? arg : join(dir, arg);
  if (!(await statOrNull(path))) throw new Refusal(`${path} does not exist`);
  const name = basename(path);
  const parsed = parseDumpFileName(name);
  if (!parsed || parsed.role !== "dump" || parsed.variant === "partial") {
    throw new Refusal(
      `${name} is not a HealthLog database dump (healthlog-<time>-<kind>.dump or .dump.enc)`,
    );
  }
  const folder = dirname(path);
  const plainManifest = join(folder, `${parsed.base}.manifest.json`);
  const encManifest = `${plainManifest}.enc`;

  if (parsed.variant === "final") {
    if (!(await statOrNull(plainManifest))) {
      throw new Refusal(
        `${basename(plainManifest)} is missing beside ${name}; a dump is restored only with its manifest`,
      );
    }
    return {
      dumpPath: path,
      manifest: parseManifest(
        JSON.parse(await readFile(plainManifest, "utf8")),
      ),
      scratch: null,
    };
  }

  // An off-host copy. Open it next to the backups if there is room to write
  // there, in the container's temp directory otherwise.
  const keys = offhostKeysFromEnv(env);
  if (keys.length === 0) {
    throw new Refusal(
      "this is an off-host copy and BACKUP_ENCRYPTION_KEY is not set; it cannot be opened without it",
    );
  }
  const scratch = await mkdtemp(
    join(isWritableDirectory(dir) ? dir : tmpdir(), ".restore-"),
  );
  try {
    let manifest;
    if (await statOrNull(encManifest)) {
      const opened = join(scratch, `${parsed.base}.manifest.json`);
      await decryptOffhostFile({
        inPath: encManifest,
        outPath: opened,
        objectKey: offhostObjectKey(basename(encManifest)),
        keys,
      });
      manifest = parseManifest(JSON.parse(await readFile(opened, "utf8")));
    } else if (await statOrNull(plainManifest)) {
      manifest = parseManifest(
        JSON.parse(await readFile(plainManifest, "utf8")),
      );
    } else {
      throw new Refusal(
        `${basename(encManifest)} is missing beside ${name}; download it from the bucket too`,
      );
    }
    say(`opening the off-host copy ${name}...`);
    const dumpPath = join(scratch, `${parsed.base}.dump`);
    await decryptOffhostFile({
      inPath: path,
      outPath: dumpPath,
      objectKey: offhostObjectKey(name),
      keys,
    });
    return { dumpPath, manifest, scratch };
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error instanceof Refusal ? error : new Refusal(error.message);
  }
}

async function restoreCommand(arg, flags, env) {
  const dir = resolveBackupDir(env);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Refusal("DATABASE_URL is not set");

  const { dumpPath, manifest, scratch } = await resolveInput(arg, dir, env);
  try {
    say(
      `dump ${manifest.file}: taken ${manifest.createdAt} by HealthLog ${manifest.appVersion ?? "(unknown version)"}, ` +
        `newest migration ${manifest.latestMigration ?? "(none)"}, Postgres ${manifest.postgres.serverVersion}, ` +
        `${Object.keys(manifest.rowCounts).length} tables`,
    );
    if (!imageKnowsMigration(manifest.latestMigration)) {
      say(
        `warning: this image does not know the dump's newest migration ${manifest.latestMigration}; ` +
          `start the app with HealthLog ${manifest.appVersion ?? "the version that wrote it"} or newer (HEALTHLOG_IMAGE_REF), not this image`,
      );
    }
    if (basename(dumpPath) !== manifest.file) {
      throw new Refusal(
        `the manifest describes ${manifest.file}, not ${basename(dumpPath)}`,
      );
    }

    // 2. The file is the one the manifest describes.
    const { sha256, bytes } = await hashFile(dumpPath);
    if (sha256 !== manifest.dump.sha256 || bytes !== manifest.dump.bytes) {
      throw new Refusal(
        `the dump does not match its manifest (SHA-256 ${sha256.slice(0, 12)}…, ${bytes} bytes; ` +
          `the manifest says ${manifest.dump.sha256.slice(0, 12)}…, ${manifest.dump.bytes} bytes). It is damaged or not this dump.`,
      );
    }
    say(`checksum matches the manifest (${mb(bytes)})`);

    // 3. The keys.
    const keys = compareKeyFingerprints(manifest.keys, keyFingerprints(env));
    if (keys.findings.length === 0) {
      say("every key the dump was written with is configured here");
    }
    for (const finding of keys.findings) {
      say(
        `${finding.severity === "refuse" ? "KEY MISMATCH" : "warning"}: ${finding.key}: ${finding.detail}`,
      );
    }
    if (keys.refuse && !flags.has("--ignore-key-mismatch")) {
      throw new Refusal(
        "refusing to restore: set the encryption keys this dump was written with (see above). " +
          "Only if that key is lost for good, run again with --ignore-key-mismatch; everything encrypted will stay unreadable.",
      );
    }

    // 4. Never over existing data.
    const client = await connect(databaseUrl);
    try {
      const tables = await listUserTables(client);
      if (tables.length > 0) {
        throw new Refusal(
          `the target database already holds ${tables.length} ${tables.length === 1 ? "table" : "tables"} (${tables.slice(0, 3).join(", ")}${tables.length > 3 ? ", …" : ""}). ` +
            "A restore goes only into an empty database: start it on a new, empty database volume, and do not start the app before the restore.",
        );
      }

      say("restoring (one transaction)...");
      const started = Date.now();
      await runTool(
        "pg_restore",
        [
          "--no-owner",
          "--no-privileges",
          "--single-transaction",
          "--exit-on-error",
          "--no-password",
          `--dbname=${connectionFromUrl(databaseUrl).pgEnv.PGDATABASE}`,
          dumpPath,
        ],
        { env: connectionFromUrl(databaseUrl).pgEnv },
      );
      say(`restored in ${Math.round((Date.now() - started) / 1000)} s`);

      await client.query("ANALYZE");
      say("planner statistics gathered");

      const problems = compareRowCounts(
        manifest.rowCounts,
        await countRows(client),
      );
      if (problems.length > 0) {
        for (const line of problems.slice(0, 20)) say(`row count: ${line}`);
        await emptyDatabase(client);
        throw new Refusal(
          `${problems.length} table(s) do not match the manifest; the database was emptied again. Do not start the app on it.`,
        );
      }
      say(
        `all ${Object.keys(manifest.rowCounts).length} tables hold the row counts the manifest names`,
      );
    } finally {
      await client.end().catch(() => {});
    }
    out();
    out(
      `Restored ${manifest.file}. Start the app with the image this dump came from or a newer one ` +
        `(HealthLog ${manifest.appVersion ?? "?"}, newest migration ${manifest.latestMigration ?? "none"}): docker compose up -d`,
    );
    return 0;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [command] = argv.filter((a) => !a.startsWith("--"));
  if (!command) {
    console.error(
      "db-restore: usage: db-restore list [directory] | latest | <file> [--ignore-key-mismatch]",
    );
    return 2;
  }
  try {
    if (command === "list") {
      const [, other] = argv.filter((a) => !a.startsWith("--"));
      return listCommand(other ?? resolveBackupDir(env));
    }
    return await restoreCommand(command, flags, env);
  } catch (error) {
    console.error(
      `db-restore: ${error instanceof Refusal ? "" : "failed: "}${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await main());
}
