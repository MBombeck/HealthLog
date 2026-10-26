/**
 * The recovery kit: every key a restore of this instance needs, by id and
 * fingerprint, and the admin's confirmation that a copy of each is kept
 * outside the server.
 *
 * It replaced a step that confirmed one key, the active application key. An
 * operator could do everything that step asked and still be unable to read a
 * single backup: the off-host copies are sealed under `BACKUP_ENCRYPTION_KEY`,
 * a copy written before a rotation needs the retired application key it was
 * written under, and every session, token and share link hangs off
 * `API_TOKEN_HMAC_KEY`. The kit lists all of them:
 *
 *   - `application`: every id in `ENCRYPTION_KEYS` this server holds, plus
 *     every retired id a stored copy or an off-host object inside the
 *     bucket's retention still lists (`backup-key-needs.ts`);
 *   - `backup`: `BACKUP_ENCRYPTION_KEY` and each key in
 *     `BACKUP_ENCRYPTION_PREVIOUS_KEYS`, when set;
 *   - `token`: `API_TOKEN_HMAC_KEY`.
 *
 * The confirmation records the set the admin was shown. The kit is due again
 * as soon as a key it needs is not in that set: a rotation, a new backup key,
 * a re-keyed install. A key that drops out of the kit (a retired key whose
 * last copy expired) does not make it due, because nothing is missing.
 *
 * Fingerprints only, never key material: the first twelve hex characters of
 * SHA-256 over the key, the same rule each key's own surface already uses (the
 * application key's boot check, the off-host object header). The token key is
 * hashed as the text the operator set, so `printf %s "$API_TOKEN_HMAC_KEY" |
 * sha256sum` reproduces it.
 */
import { z } from "zod/v4";

import { envValue } from "@/lib/env";
import { decodeBackupKey, offhostKeyId } from "@/lib/jobs/offhost-key";
import type { BackupKeyNeeds } from "@/lib/recovery/backup-key-needs";
import { fingerprintSecretText } from "@/lib/database-backup/dump-core.mjs";

/** Where the operator sets the keys; picks the tab the kit opens on. */
export const KIT_PLATFORMS = [
  "compose",
  "truenas",
  "coolify",
  "unraid",
  "portainer",
] as const;
export type KitPlatform = (typeof KIT_PLATFORMS)[number];

/** Wire code for a confirmation of a kit that has changed since it was shown. */
export const RECOVERY_KIT_STALE_CODE = "recovery.kit.stale";

export const KIT_KEY_KINDS = ["application", "backup", "token"] as const;
export type KitKeyKind = (typeof KIT_KEY_KINDS)[number];

/** The variable each kind of key is set in. */
export const KIT_KEY_SOURCES = {
  application: "ENCRYPTION_KEYS",
  backup: "BACKUP_ENCRYPTION_KEY",
  backupPrevious: "BACKUP_ENCRYPTION_PREVIOUS_KEYS",
  token: "API_TOKEN_HMAC_KEY",
} as const;
export type KitKeySource =
  (typeof KIT_KEY_SOURCES)[keyof typeof KIT_KEY_SOURCES];

/** One key as a confirmation stores it. */
export interface KitEntry {
  kind: KitKeyKind;
  id: string;
  /** Null for a key this server does not hold but a copy still needs. */
  fingerprint: string | null;
}

/** Why the kit lists a key. */
export interface KitKeyNeed {
  /** The key new data is written under. */
  active: boolean;
  /** This server holds the key. */
  configured: boolean;
  /** Stored copies in this database whose content needs it. */
  storedCopies: number;
  /**
   * Off-host objects need it until this instant; `"unknown"` when the bucket's
   * retention cannot be read, so they may need it indefinitely.
   */
  offhostUntil: string | null;
  /** Database dumps on this server written under it. */
  localDumps: number;
  /** Off-host database dumps need it until this instant, or `"unknown"`. */
  offhostDumpsUntil: string | null;
}

/** One key the kit lists, with its verdict. */
export interface KitKey extends KitEntry {
  source: KitKeySource;
  need: KitKeyNeed;
  /** The confirmation covers this key. */
  confirmed: boolean;
  /**
   * `not_configured`: a copy needs it and this server does not hold it, so
   * only a copy kept elsewhere can read those backups. `unreadable`: the
   * variable is set but does not decode as a key.
   */
  problem: "not_configured" | "unreadable" | null;
}

export interface RecoveryKit {
  keys: KitKey[];
  /** A key the kit lists is not covered by the confirmation. */
  due: boolean;
  /** Keys the confirmation does not cover, by kind and id. */
  unconfirmed: Array<Pick<KitEntry, "kind" | "id">>;
  confirmedAt: string | null;
  /** The confirming admin, while that account exists. */
  confirmedBy: { id: string; email: string | null } | null;
  platformHint: KitPlatform;
}

/**
 * `HEALTHLOG_PLATFORM`, when it names a known platform; `compose` otherwise.
 * Catalog templates set it so the kit opens on the right instructions.
 */
export function resolvePlatformHint(
  raw: string | undefined = envValue("HEALTHLOG_PLATFORM"),
): KitPlatform {
  const value = raw?.trim().toLowerCase();
  return (KIT_PLATFORMS as readonly string[]).includes(value ?? "")
    ? (value as KitPlatform)
    : "compose";
}

/**
 * The fingerprint rule for a key that is text rather than decoded bytes: the
 * slow one the dump manifest uses (`fingerprintSecretText`), so a phrase
 * cannot be guessed from what the kit shows.
 */
export function fingerprintText(value: string): string {
  return fingerprintSecretText(value);
}

const kitEntrySchema = z.object({
  kind: z.enum(KIT_KEY_KINDS),
  id: z.string().min(1).max(64),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .nullable(),
});

/** The request body of a confirmation: the kit as the admin saw it. */
export const kitConfirmationSchema = z
  .object({ entries: z.array(kitEntrySchema).min(1).max(64) })
  .strict();

/**
 * The stored entries, validated. A row that does not parse confirms nothing,
 * which leaves the kit due rather than trusting a shape it cannot read.
 */
export function parseKitEntries(raw: unknown): KitEntry[] {
  const parsed = z.array(kitEntrySchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

const entryKey = (e: Pick<KitEntry, "kind" | "id">) => `${e.kind}:${e.id}`;

/**
 * Pure rule: which listed keys a confirmation covers.
 *
 * A key this server holds is covered by an entry with the same kind, id and
 * fingerprint, so a re-keyed install under the same id is due again. A key it
 * does not hold has no fingerprint to compare, so an entry with its kind and id
 * covers it: the admin said a copy of that id is kept.
 */
export function assessRecoveryKit(
  listed: ReadonlyArray<Omit<KitKey, "confirmed">>,
  confirmation: readonly KitEntry[] | null,
): { keys: KitKey[]; due: boolean; unconfirmed: KitEntry[] } {
  const exact = new Set(
    (confirmation ?? []).map((e) => `${entryKey(e)}:${e.fingerprint ?? ""}`),
  );
  const byId = new Set((confirmation ?? []).map(entryKey));
  const keys = listed.map((key) => ({
    ...key,
    confirmed:
      key.fingerprint === null
        ? byId.has(entryKey(key))
        : exact.has(`${entryKey(key)}:${key.fingerprint}`),
  }));
  const unconfirmed = keys
    .filter((key) => !key.confirmed)
    .map(({ kind, id, fingerprint }) => ({ kind, id, fingerprint }));
  return { keys, due: unconfirmed.length > 0, unconfirmed };
}

/** Pure rule: does what the admin was shown match what the kit lists now? */
export function sameKit(
  shown: readonly KitEntry[],
  listed: readonly KitEntry[],
): boolean {
  const canon = (entries: readonly KitEntry[]) =>
    [
      ...new Set(entries.map((e) => `${entryKey(e)}:${e.fingerprint ?? ""}`)),
    ].sort();
  const a = canon(shown);
  const b = canon(listed);
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Every key id a stored copy lists, and every key id an off-host object still
 * inside the bucket's retention needs. An off-host key whose expiry cannot be
 * read stays needed: without the lifecycle rule nothing proves the objects are
 * gone.
 */
export function neededKeyIds(needs: BackupKeyNeeds, now: Date): Set<string> {
  const needed = new Set<string>();
  const stillThere = (until: string | null) =>
    until === null || Date.parse(until) > +now;
  for (const row of needs.stored) needed.add(row.keyId);
  for (const row of needs.offhost) {
    if (stillThere(row.neededUntil)) needed.add(row.keyId);
  }
  // A database dump needs the key its rows were written under while it
  // exists: on this server until retention removes it, in the bucket until
  // the rule for `database/` expires it.
  for (const row of needs.dumps) {
    if (row.local > 0) needed.add(row.keyId);
    else if (row.offhost && stillThere(row.offhost.neededUntil)) {
      needed.add(row.keyId);
    }
  }
  return needed;
}

/**
 * Pure: the application keys the kit lists, from the ids this server holds
 * and what the backups still need.
 */
export function applicationKitKeys(args: {
  activeKeyId: string;
  configuredKeyIds: readonly string[];
  fingerprintOf: (id: string) => string | null;
  needs: BackupKeyNeeds;
  now: Date;
}): Array<Omit<KitKey, "confirmed">> {
  const needed = neededKeyIds(args.needs, args.now);
  const ids = new Set([...args.configuredKeyIds, ...needed]);
  return [...ids].sort().map((id) => {
    const fingerprint = args.fingerprintOf(id);
    const offhost = args.needs.offhost.find((row) => row.keyId === id);
    const dump = args.needs.dumps.find((row) => row.keyId === id);
    return {
      kind: "application" as const,
      id,
      fingerprint,
      source: KIT_KEY_SOURCES.application,
      need: {
        active: id === args.activeKeyId,
        configured: fingerprint !== null,
        storedCopies:
          args.needs.stored.find((row) => row.keyId === id)?.copies ?? 0,
        offhostUntil:
          offhost && needed.has(id) ? (offhost.neededUntil ?? "unknown") : null,
        localDumps: dump?.local ?? 0,
        offhostDumpsUntil:
          dump?.offhost &&
          (dump.offhost.neededUntil === null ||
            Date.parse(dump.offhost.neededUntil) > +args.now)
            ? (dump.offhost.neededUntil ?? "unknown")
            : null,
      },
      problem: fingerprint === null ? ("not_configured" as const) : null,
    };
  });
}

function noNeed(active: boolean): KitKeyNeed {
  return {
    active,
    configured: true,
    storedCopies: 0,
    offhostUntil: null,
    localDumps: 0,
    offhostDumpsUntil: null,
  };
}

/** Pure: the off-host keys, from the two variables as the operator set them. */
export function backupKitKeys(
  activeRaw: string | undefined,
  previousRaw: string | undefined,
): Array<Omit<KitKey, "confirmed">> {
  const out: Array<Omit<KitKey, "confirmed">> = [];
  const add = (raw: string, source: KitKeySource, active: boolean) => {
    let fingerprint: string | null = null;
    try {
      fingerprint = offhostKeyId(decodeBackupKey(raw));
    } catch {
      fingerprint = null;
    }
    out.push({
      kind: "backup",
      // The fingerprint is the id off-host objects record for their key, so
      // the operator matches a kit entry to an object header directly. A key
      // that does not decode has neither; it is named by where it is set.
      id: fingerprint ?? `${source}#${out.length + 1}`,
      fingerprint,
      source,
      need: noNeed(active),
      problem: fingerprint === null ? "unreadable" : null,
    });
  };
  const active = activeRaw?.trim();
  if (active) add(active, KIT_KEY_SOURCES.backup, true);
  for (const raw of (previousRaw ?? "").split(",")) {
    if (raw.trim()) add(raw.trim(), KIT_KEY_SOURCES.backupPrevious, false);
  }
  return out;
}

/** Pure: the token key, which the app cannot run without. */
export function tokenKitKeys(
  raw: string | undefined,
): Array<Omit<KitKey, "confirmed">> {
  const value = raw ?? "";
  return [
    {
      kind: "token",
      id: KIT_KEY_SOURCES.token,
      fingerprint: value ? fingerprintText(value) : null,
      source: KIT_KEY_SOURCES.token,
      need: { ...noNeed(true), configured: value.length > 0 },
      problem: value ? null : "not_configured",
    },
  ];
}
