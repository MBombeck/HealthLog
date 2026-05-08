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

async function main() {
  const key = process.argv[2];
  const out = process.argv[3] ?? "./restored.json";
  if (!key) {
    console.error(
      "Usage: pnpm tsx scripts/restore-backup.ts <s3-key> [output-file]",
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
  writeFileSync(out, plaintext, "utf8");
  console.log(`Restored ${plaintext.length} bytes -> ${out}`);
}

main().catch((err) => {
  console.error("Restore failed:", err);
  process.exit(2);
});
