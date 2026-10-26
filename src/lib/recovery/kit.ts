/**
 * The recovery kit on this server: which keys it lists right now, what the
 * stored confirmation covers, recording a confirmation, and "Check my copy".
 * The rules themselves are pure and live in `kit-rules.ts`.
 */
import { timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/db";
import { envValue } from "@/lib/env";
import {
  candidateMatchesKey,
  getActiveKeyId,
  getConfiguredKeyIds,
  getKeyFingerprint,
} from "@/lib/crypto";
import { decodeBackupKey, offhostKeyId } from "@/lib/jobs/offhost-key";
import { readBackupKeyNeeds } from "@/lib/recovery/backup-key-needs";
import {
  applicationKitKeys,
  assessRecoveryKit,
  backupKitKeys,
  KIT_KEY_SOURCES,
  parseKitEntries,
  resolvePlatformHint,
  sameKit,
  tokenKitKeys,
  type KitEntry,
  type KitKey,
  type KitKeyKind,
  type RecoveryKit,
} from "@/lib/recovery/kit-rules";
import { fingerprintSecretText } from "@/lib/database-backup/dump-core.mjs";

/** Every key the kit lists on this server right now, without a verdict. */
export async function listKitKeys(
  now: Date = new Date(),
): Promise<Array<Omit<KitKey, "confirmed">>> {
  const activeKeyId = getActiveKeyId();
  const needs = await readBackupKeyNeeds(activeKeyId, now);
  return [
    ...applicationKitKeys({
      activeKeyId,
      configuredKeyIds: getConfiguredKeyIds(),
      fingerprintOf: getKeyFingerprint,
      needs,
      now,
    }),
    ...backupKitKeys(
      envValue("BACKUP_ENCRYPTION_KEY"),
      envValue("BACKUP_ENCRYPTION_PREVIOUS_KEYS"),
    ),
    ...tokenKitKeys(envValue("API_TOKEN_HMAC_KEY")),
  ];
}

export async function readRecoveryKit(
  now: Date = new Date(),
): Promise<RecoveryKit> {
  const [listed, row] = await Promise.all([
    listKitKeys(now),
    prisma.recoveryKitConfirmation.findUnique({
      where: { id: "singleton" },
    }),
  ]);
  const verdict = assessRecoveryKit(
    listed,
    row ? parseKitEntries(row.entries) : null,
  );
  const confirmedBy = row?.confirmedByUserId
    ? await prisma.user.findUnique({
        where: { id: row.confirmedByUserId },
        select: { id: true, email: true },
      })
    : null;
  return {
    keys: verdict.keys,
    due: verdict.due,
    unconfirmed: verdict.unconfirmed.map(({ kind, id }) => ({ kind, id })),
    confirmedAt: row?.confirmedAt.toISOString() ?? null,
    confirmedBy: confirmedBy ?? null,
    platformHint: resolvePlatformHint(),
  };
}

export type ConfirmRecoveryKitResult =
  { ok: true; kit: RecoveryKit } | { ok: false; kit: RecoveryKit };

/**
 * Record the confirmation, but only for the kit the admin was shown: a page
 * opened before a rotation or a new backup key must not confirm a key the
 * admin never saw.
 */
export async function confirmRecoveryKit(input: {
  shown: readonly KitEntry[];
  userId: string;
  now?: Date;
}): Promise<ConfirmRecoveryKitResult> {
  const now = input.now ?? new Date();
  const listed = await listKitKeys(now);
  const entries: KitEntry[] = listed.map(({ kind, id, fingerprint }) => ({
    kind,
    id,
    fingerprint,
  }));
  if (!sameKit(input.shown, entries)) {
    return { ok: false, kit: await readRecoveryKit(now) };
  }
  const data = {
    confirmedAt: now,
    confirmedByUserId: input.userId,
    entries: entries.map(({ kind, id, fingerprint }) => ({
      kind,
      id,
      fingerprint,
    })),
  };
  await prisma.recoveryKitConfirmation.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
  });
  return { ok: true, kit: await readRecoveryKit(now) };
}

/**
 * "Check my copy": does `value` decode to the key the kit lists as
 * `kind`/`id` on this server? Constant time on the compared bytes; a value
 * that does not decode is simply not a match.
 */
export function verifyKitKey(input: {
  kind: KitKeyKind;
  id: string;
  value: string;
}): boolean {
  const value = input.value.trim();
  switch (input.kind) {
    case "application":
      return candidateMatchesKey(value, input.id);
    case "backup": {
      let candidate: Buffer;
      try {
        candidate = decodeBackupKey(value);
      } catch {
        return false;
      }
      const configured = [
        envValue("BACKUP_ENCRYPTION_KEY"),
        ...(envValue("BACKUP_ENCRYPTION_PREVIOUS_KEYS") ?? "").split(","),
      ]
        .map((raw) => raw?.trim() ?? "")
        .filter((raw) => raw.length > 0)
        .flatMap((raw) => {
          try {
            return [decodeBackupKey(raw)];
          } catch {
            return [];
          }
        })
        .find((key) => offhostKeyId(key) === input.id);
      return (
        configured !== undefined &&
        configured.length === candidate.length &&
        timingSafeEqual(configured, candidate)
      );
    }
    case "token": {
      const configured = envValue("API_TOKEN_HMAC_KEY");
      if (!configured || input.id !== KIT_KEY_SOURCES.token) return false;
      // The slow fingerprint the kit shows, compared in constant time: equal
      // lengths whatever was pasted, and no fast digest of the secret.
      const digest = (s: string) =>
        Buffer.from(fingerprintSecretText(s), "utf8");
      return timingSafeEqual(digest(value), digest(configured));
    }
  }
}
