/**
 * scripts/rotate-encryption-key.ts <new-key-id>
 *
 * Re-encrypts every encrypted column in the database with the currently
 * active key (`ENCRYPTION_ACTIVE_KEY_ID`). Idempotent: rows whose ciphertext
 * already carries the active key id prefix are skipped.
 *
 * Usage:
 *   ENCRYPTION_KEYS='{"v1":"<old>","v2":"<new>"}' \
 *   ENCRYPTION_ACTIVE_KEY_ID=v2 \
 *   pnpm tsx scripts/rotate-encryption-key.ts v2
 */
import "dotenv/config";
import { Buffer } from "node:buffer";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decrypt, encrypt, extractKeyId, getActiveKeyId } from "@/lib/crypto";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const targetKeyId = process.argv[2] ?? getActiveKeyId();
if (targetKeyId !== getActiveKeyId()) {
  console.error(
    `Refusing to rotate: argv key id '${targetKeyId}' does not match the ` +
      `currently active id '${getActiveKeyId()}'. Set ENCRYPTION_ACTIVE_KEY_ID first.`,
  );
  process.exit(2);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

interface RotationResult {
  table: string;
  field: string;
  scanned: number;
  rotated: number;
  errors: number;
}

function shouldRotate(value: string | null): boolean {
  if (!value) return false;
  const id = extractKeyId(value);
  // null = legacy/unversioned (rotate); else rotate if not already on active.
  return id !== getActiveKeyId();
}

async function rotateField<T extends { id: string }>(
  table: string,
  field: string,
  rows: T[],
  fieldGetter: (row: T) => string | null,
  updater: (id: string, ciphertext: string) => Promise<void>,
): Promise<RotationResult> {
  const result: RotationResult = {
    table,
    field,
    scanned: rows.length,
    rotated: 0,
    errors: 0,
  };
  for (const row of rows) {
    const v = fieldGetter(row);
    if (!shouldRotate(v)) continue;
    try {
      const re = encrypt(decrypt(v as string));
      await updater(row.id, re);
      result.rotated++;
    } catch (err) {
      result.errors++;
      console.error(
        `[${table}.${field}] row ${row.id}: ${(err as Error).message}`,
      );
    }
  }
  return result;
}

async function main() {
  console.log(`Rotating encrypted rows to active key id: ${targetKeyId}`);
  const results: RotationResult[] = [];

  // ───── User table ─────
  const users = await prisma.user.findMany({
    select: {
      id: true,
      codexAccessTokenEncrypted: true,
      codexRefreshTokenEncrypted: true,
      aiAnthropicKeyEncrypted: true,
      aiLocalKeyEncrypted: true,
      aiOpenaiKeyEncrypted: true,
      moodLogWebhookSecret: true,
      telegramBotToken: true,
      moodLogUrlEncrypted: true,
      moodLogApiKeyEncrypted: true,
      withingsClientIdEncrypted: true,
      withingsClientSecretEncrypted: true,
    },
  });

  const userFields: Array<keyof (typeof users)[number]> = [
    "codexAccessTokenEncrypted",
    "codexRefreshTokenEncrypted",
    "aiAnthropicKeyEncrypted",
    "aiLocalKeyEncrypted",
    "aiOpenaiKeyEncrypted",
    "moodLogWebhookSecret",
    "telegramBotToken",
    "moodLogUrlEncrypted",
    "moodLogApiKeyEncrypted",
    "withingsClientIdEncrypted",
    "withingsClientSecretEncrypted",
  ];
  for (const field of userFields) {
    const r = await rotateField(
      "User",
      field as string,
      users,
      (u) => (u as Record<string, unknown>)[field as string] as string | null,
      async (id, ciphertext) => {
        await prisma.user.update({
          where: { id },
          data: { [field]: ciphertext } as Record<string, string>,
        });
      },
    );
    results.push(r);
  }

  // ───── WithingsConnection table (accessToken / refreshToken) ─────
  const withings = await prisma.withingsConnection.findMany({
    select: { id: true, accessToken: true, refreshToken: true },
  });
  for (const field of ["accessToken", "refreshToken"] as const) {
    const r = await rotateField(
      "WithingsConnection",
      field,
      withings,
      (w) => w[field],
      async (id, ciphertext) => {
        await prisma.withingsConnection.update({
          where: { id },
          data: { [field]: ciphertext } as Record<string, string>,
        });
      },
    );
    results.push(r);
  }

  // ───── AppSettings table (singleton typically) ─────
  const settings = await prisma.appSettings.findMany({
    select: {
      id: true,
      adminAiKeyEncrypted: true,
      webPushVapidPrivateKeyEncrypted: true,
      githubIssueTokenEncrypted: true,
    },
  });
  const appFields = [
    "adminAiKeyEncrypted",
    "webPushVapidPrivateKeyEncrypted",
    "githubIssueTokenEncrypted",
  ] as const;
  for (const field of appFields) {
    const r = await rotateField(
      "AppSettings",
      field,
      settings,
      (s) => s[field],
      async (id, ciphertext) => {
        await prisma.appSettings.update({
          where: { id },
          data: { [field]: ciphertext } as Record<string, string>,
        });
      },
    );
    results.push(r);
  }

  // ───── NotificationChannel.config ─────
  // Channel config (Telegram chat id, ntfy topic, etc.) is encrypted JSON.
  // Skipping these on rotation would leave channels permanently undecryptable
  // once the operator drops `v1` from the key map.
  const channels = await prisma.notificationChannel.findMany({
    select: { id: true, config: true },
  });
  results.push(
    await rotateField(
      "NotificationChannel",
      "config",
      channels,
      (c) => c.config,
      async (id, ciphertext) => {
        await prisma.notificationChannel.update({
          where: { id },
          data: { config: ciphertext },
        });
      },
    ),
  );

  // ───── PushSubscription.{p256dh, auth} ─────
  // Web-push routing secrets — without these, the push endpoint is reachable
  // but the browser ignores the message (auth tag mismatch).
  const subs = await prisma.pushSubscription.findMany({
    select: { id: true, p256dh: true, auth: true },
  });
  for (const field of ["p256dh", "auth"] as const) {
    results.push(
      await rotateField(
        "PushSubscription",
        field,
        subs,
        (s) => s[field],
        async (id, ciphertext) => {
          await prisma.pushSubscription.update({
            where: { id },
            data: { [field]: ciphertext } as Record<string, string>,
          });
        },
      ),
    );
  }

  // ───── IntegrationStatus.lastError ─────
  // Per `prisma/schema.prisma:1441` — AES-256-GCM ciphertext of an
  // upstream error payload. Skipped historically; drop the legacy
  // key while a row still lives here and the admin status view 500s.
  const statuses = await prisma.integrationStatus.findMany({
    select: { id: true, lastError: true },
  });
  results.push(
    await rotateField(
      "IntegrationStatus",
      "lastError",
      statuses,
      (s) => s.lastError,
      async (id, ciphertext) => {
        await prisma.integrationStatus.update({
          where: { id },
          data: { lastError: ciphertext },
        });
      },
    ),
  );

  // ───── CoachMessage.encryptedContent ─────
  // Per `prisma/schema.prisma:1983` — `Bytes` column carrying the
  // UTF-8 ciphertext of every persisted Coach message. The encrypt /
  // decrypt helpers operate on strings, so we go through a Buffer
  // round-trip identical to `src/lib/ai/coach/persistence.ts:60-71`.
  const coachMessages = await prisma.coachMessage.findMany({
    select: { id: true, encryptedContent: true },
  });
  const coachResult: RotationResult = {
    table: "CoachMessage",
    field: "encryptedContent",
    scanned: coachMessages.length,
    rotated: 0,
    errors: 0,
  };
  for (const row of coachMessages) {
    const buf = row.encryptedContent;
    if (!buf || buf.byteLength === 0) continue;
    const asString = Buffer.from(buf).toString("utf8");
    if (!shouldRotate(asString)) continue;
    try {
      const rotated = encrypt(decrypt(asString));
      const encoded = Buffer.from(rotated, "utf8");
      const next = new Uint8Array(new ArrayBuffer(encoded.byteLength));
      next.set(encoded);
      await prisma.coachMessage.update({
        where: { id: row.id },
        data: { encryptedContent: next },
      });
      coachResult.rotated++;
    } catch (err) {
      coachResult.errors++;
      console.error(
        `[CoachMessage.encryptedContent] row ${row.id}: ${(err as Error).message}`,
      );
    }
  }
  results.push(coachResult);

  console.log("\n=== Rotation summary ===");
  let totalRotated = 0;
  let totalErrors = 0;
  for (const r of results) {
    console.log(
      `${r.table}.${r.field}: scanned=${r.scanned} rotated=${r.rotated} errors=${r.errors}`,
    );
    totalRotated += r.rotated;
    totalErrors += r.errors;
  }
  console.log(`\nTOTAL rotated=${totalRotated} errors=${totalErrors}`);
  await prisma.$disconnect();
  process.exit(totalErrors > 0 ? 3 : 0);
}

main().catch(async (err) => {
  console.error("Rotation failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
