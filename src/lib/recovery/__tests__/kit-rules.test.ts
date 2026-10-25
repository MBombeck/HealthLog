/**
 * The recovery kit rules: which keys the kit lists, what a confirmation
 * covers, and when the kit is due again.
 *
 * Mutation check: compare fingerprints out of the covered test (id only) and
 * the re-keyed-install case goes red; drop the backup needs from the
 * application list and the retired-key case goes red.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { offhostKeyId } from "@/lib/jobs/offhost-key";
import type { BackupKeyNeeds } from "@/lib/recovery/backup-key-needs";
import {
  applicationKitKeys,
  assessRecoveryKit,
  backupKitKeys,
  fingerprintText,
  neededKeyIds,
  parseKitEntries,
  resolvePlatformHint,
  sameKit,
  tokenKitKeys,
  type KitEntry,
} from "@/lib/recovery/kit-rules";

const NOW = new Date("2026-10-25T12:00:00Z");
const DAY = 86_400_000;

const NO_NEEDS: BackupKeyNeeds = {
  stored: [],
  unrecorded: { copies: 0, oldestAt: null },
  offhost: [],
  offhostExpirationDays: null,
  retiredKeysStillNeeded: [],
};

const FINGERPRINTS: Record<string, string> = {
  v1: "111111111111",
  v2: "222222222222",
};

function appKeys(configured: string[], active: string, needs = NO_NEEDS) {
  return applicationKitKeys({
    activeKeyId: active,
    configuredKeyIds: configured,
    fingerprintOf: (id) => (configured.includes(id) ? FINGERPRINTS[id] : null),
    needs,
    now: NOW,
  });
}

const BACKUP_HEX = "ab".repeat(32);
const BACKUP_OLD_HEX = "cd".repeat(32);

describe("which keys the kit lists", () => {
  it("lists every configured application key, the active one marked", () => {
    const keys = appKeys(["v1", "v2"], "v2");
    expect(keys.map((k) => [k.id, k.need.active, k.fingerprint])).toEqual([
      ["v1", false, "111111111111"],
      ["v2", true, "222222222222"],
    ]);
  });

  it("keeps a retired key a stored copy lists, even once the server dropped it", () => {
    const needs: BackupKeyNeeds = {
      ...NO_NEEDS,
      stored: [{ keyId: "v1", copies: 3, oldestAt: NOW.toISOString() }],
    };
    const [v1] = appKeys(["v2"], "v2", needs);
    expect(v1).toMatchObject({
      id: "v1",
      fingerprint: null,
      problem: "not_configured",
      need: { configured: false, storedCopies: 3 },
    });
  });

  it("keeps an off-host key while objects inside the retention need it", () => {
    const row = (neededUntil: string | null) => ({
      ...NO_NEEDS,
      offhost: [
        {
          keyId: "v1",
          firstWrittenAt: NOW.toISOString(),
          lastWrittenAt: NOW.toISOString(),
          neededUntil,
        },
      ],
    });
    const until = new Date(NOW.getTime() + 10 * DAY).toISOString();
    expect(appKeys(["v2"], "v2", row(until))[0].need.offhostUntil).toBe(until);
    expect(appKeys(["v2"], "v2", row(null))[0].need.offhostUntil).toBe(
      "unknown",
    );
    // Past the retention the objects are gone, so the key drops out.
    const past = new Date(NOW.getTime() - DAY).toISOString();
    expect(appKeys(["v2"], "v2", row(past)).map((k) => k.id)).toEqual(["v2"]);
    expect([...neededKeyIds(row(past), NOW)]).toEqual([]);
  });

  it("names the off-host keys by the id their objects record", () => {
    const keys = backupKitKeys(BACKUP_HEX, ` ${BACKUP_OLD_HEX} ,`);
    expect(keys.map((k) => [k.id, k.need.active, k.source])).toEqual([
      [
        offhostKeyId(Buffer.from(BACKUP_HEX, "hex")),
        true,
        "BACKUP_ENCRYPTION_KEY",
      ],
      [
        offhostKeyId(Buffer.from(BACKUP_OLD_HEX, "hex")),
        false,
        "BACKUP_ENCRYPTION_PREVIOUS_KEYS",
      ],
    ]);
    expect(keys.every((k) => k.fingerprint === k.id)).toBe(true);
    expect(backupKitKeys(undefined, undefined)).toEqual([]);
  });

  it("flags an off-host key that does not decode instead of hiding it", () => {
    const [bad] = backupKitKeys("not-a-key", undefined);
    expect(bad).toMatchObject({ fingerprint: null, problem: "unreadable" });
  });

  it("fingerprints the token key as the text the operator set", () => {
    const value = "x".repeat(40);
    const [token] = tokenKitKeys(value);
    expect(token.fingerprint).toBe(
      createHash("sha256").update(value).digest("hex").slice(0, 12),
    );
    expect(token.fingerprint).toBe(fingerprintText(value));
    expect(JSON.stringify(token)).not.toContain(value);
  });
});

describe("what a confirmation covers", () => {
  const listed = [...appKeys(["v1"], "v1"), ...tokenKitKeys("t".repeat(40))];
  const entries = (keys: typeof listed): KitEntry[] =>
    keys.map(({ kind, id, fingerprint }) => ({ kind, id, fingerprint }));

  it("is due without any confirmation, and done for the exact set", () => {
    expect(assessRecoveryKit(listed, null).due).toBe(true);
    expect(assessRecoveryKit(listed, entries(listed)).due).toBe(false);
  });

  it("keeps a confirmation of the active key only, from the old step, for that key", () => {
    const legacy: KitEntry[] = [
      { kind: "application", id: "v1", fingerprint: "111111111111" },
    ];
    const verdict = assessRecoveryKit(listed, legacy);
    expect(verdict.due).toBe(true);
    expect(verdict.keys.find((k) => k.id === "v1")?.confirmed).toBe(true);
    expect(verdict.unconfirmed.map((k) => k.id)).toEqual([
      "API_TOKEN_HMAC_KEY",
    ]);
  });

  it("is due again after a rotation, a re-keyed install or a new backup key", () => {
    const confirmed = entries(listed);
    // Rotation: a new active id.
    const rotated = [
      ...appKeys(["v1", "v2"], "v2"),
      ...tokenKitKeys("t".repeat(40)),
    ];
    expect(
      assessRecoveryKit(rotated, confirmed).unconfirmed.map((k) => k.id),
    ).toEqual(["v2"]);
    // Same id, other key.
    const rekeyed = listed.map((k) =>
      k.id === "v1" ? { ...k, fingerprint: "999999999999" } : k,
    );
    expect(assessRecoveryKit(rekeyed, confirmed).due).toBe(true);
    // A backup key appears.
    const withBackup = [...listed, ...backupKitKeys(BACKUP_HEX, undefined)];
    expect(assessRecoveryKit(withBackup, confirmed).unconfirmed).toHaveLength(
      1,
    );
  });

  it("is not due when a key merely drops out of the kit", () => {
    const wider = [
      ...appKeys(["v1", "v2"], "v2"),
      ...tokenKitKeys("t".repeat(40)),
    ];
    const narrower = [
      ...appKeys(["v2"], "v2"),
      ...tokenKitKeys("t".repeat(40)),
    ];
    expect(assessRecoveryKit(narrower, entries(wider)).due).toBe(false);
  });

  it("covers a key this server does not hold by its id", () => {
    const needs: BackupKeyNeeds = {
      ...NO_NEEDS,
      stored: [{ keyId: "v0", copies: 1, oldestAt: NOW.toISOString() }],
    };
    const kit = appKeys(["v1"], "v1", needs);
    const confirmed = entries(kit);
    expect(confirmed.find((e) => e.id === "v0")?.fingerprint).toBeNull();
    expect(assessRecoveryKit(kit, confirmed).due).toBe(false);
  });

  it("matches the shown kit against the current one as a set", () => {
    const a = entries(listed);
    expect(sameKit([...a].reverse(), a)).toBe(true);
    expect(sameKit(a.slice(1), a)).toBe(false);
    expect(
      sameKit(
        a.map((e) =>
          e.id === "v1" ? { ...e, fingerprint: "000000000000" } : e,
        ),
        a,
      ),
    ).toBe(false);
  });

  it("reads a stored confirmation it cannot parse as none", () => {
    expect(parseKitEntries({ not: "a list" })).toEqual([]);
    expect(
      parseKitEntries([{ kind: "nope", id: "v1", fingerprint: null }]),
    ).toEqual([]);
  });
});

describe("platform hint", () => {
  it("opens on a known platform and falls back to compose", () => {
    expect(resolvePlatformHint("TrueNAS")).toBe("truenas");
    expect(resolvePlatformHint("kubernetes")).toBe("compose");
    expect(resolvePlatformHint(undefined)).toBe("compose");
  });
});
