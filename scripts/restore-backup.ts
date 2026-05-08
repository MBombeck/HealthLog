/**
 * scripts/restore-backup.ts <s3-key> [output-file]
 *
 * Downloads a single off-host backup object, decrypts it with
 * `BACKUP_ENCRYPTION_KEY`, and writes the JSON dump to disk.
 *
 * Wire format (binary):
 *   magic(4)="HLBK" || version(1)=0x01 || iv(12) || tag(16) || ciphertext
 *
 * Usage:
 *   BACKUP_S3_ENDPOINT=...        \
 *   BACKUP_S3_BUCKET=...          \
 *   BACKUP_S3_ACCESS_KEY=...      \
 *   BACKUP_S3_SECRET_KEY=...      \
 *   BACKUP_S3_REGION=auto         \
 *   BACKUP_ENCRYPTION_KEY=<hex64> \
 *   pnpm tsx scripts/restore-backup.ts 2026-05-08/user-clx123.json.enc /tmp/restored.json
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import {
  loadOffhostConfig,
  getS3Client,
  decryptBackup,
  OffhostBackupNotConfiguredError,
} from "@/lib/jobs/offhost-backup";

/**
 * Schema-validate the decrypted JSON before writing it to disk. The wire
 * format from `runOffhostBackup` always carries `userId` and the four data
 * arrays — anything else means the operator may be looking at a tampered or
 * mis-targeted object. We reject rather than silently writing a body that a
 * later import script would trust.
 */
function validateBackupShape(payload: unknown): {
  exportedAt: string;
  userId: string;
  measurements: unknown[];
  medications: unknown[];
  intakeEvents: unknown[];
  moodEntries: unknown[];
} {
  if (!payload || typeof payload !== "object") {
    throw new Error("backup payload is not a JSON object");
  }
  const p = payload as Record<string, unknown>;
  const required = [
    "exportedAt",
    "userId",
    "measurements",
    "medications",
    "intakeEvents",
    "moodEntries",
  ] as const;
  for (const k of required) {
    if (!(k in p)) throw new Error(`backup is missing required field: ${k}`);
  }
  if (typeof p.exportedAt !== "string")
    throw new Error("backup.exportedAt must be string");
  if (typeof p.userId !== "string" || p.userId.length === 0)
    throw new Error("backup.userId must be a non-empty string");
  for (const k of [
    "measurements",
    "medications",
    "intakeEvents",
    "moodEntries",
  ] as const) {
    if (!Array.isArray(p[k])) throw new Error(`backup.${k} must be an array`);
  }
  return p as ReturnType<typeof validateBackupShape>;
}

async function main() {
  const key = process.argv[2];
  const out = process.argv[3] ?? "./restored.json";
  // Optional positional arg: --user-id=<id> requires the dump's `userId`
  // field to match. Defends against an operator pointing the script at the
  // wrong S3 key (e.g. another tenant's dump under a similar path) and
  // silently importing the wrong user's data downstream.
  const expectedUserId = process.argv
    .find((a) => a.startsWith("--user-id="))
    ?.slice("--user-id=".length);
  if (!key) {
    console.error(
      "Usage: pnpm tsx scripts/restore-backup.ts <s3-key> [output-file] [--user-id=<id>]",
    );
    process.exit(1);
  }

  const cfg = loadOffhostConfig();
  if (!cfg) {
    throw new OffhostBackupNotConfiguredError(
      "Off-host backup is not configured. Set BACKUP_* env vars.",
    );
  }

  const s3 = await getS3Client(cfg);
  console.log(
    `Downloading s3://${cfg.bucket}/${key} from ${cfg.endpoint} (region=${cfg.region})`,
  );
  const ciphertext = await s3.getObject(key);
  const plaintext = decryptBackup(ciphertext, cfg.encryptionKey);

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new Error(
      `Decrypted payload is not valid JSON: ${(err as Error).message}`,
    );
  }
  const body = validateBackupShape(parsed);
  if (expectedUserId && body.userId !== expectedUserId) {
    throw new Error(
      `Refusing to write: backup.userId='${body.userId}' does not match --user-id='${expectedUserId}'`,
    );
  }

  writeFileSync(out, plaintext, "utf8");
  console.log(
    `Restored userId=${body.userId} (${plaintext.length} bytes) -> ${out}`,
  );
}

main().catch((err) => {
  console.error("Restore failed:", err);
  process.exit(2);
});
