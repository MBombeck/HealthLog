/**
 * The key ids a backup's inner ciphertext needs, and the verdict against the
 * keys this host has.
 *
 * The values are produced by the real codecs under real keys, then the host's
 * key set is changed underneath them, which is exactly what an operator does
 * when a rotation is followed by dropping the old key.
 */
import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _resetCryptoCacheForTests, encrypt, encryptBytes } from "@/lib/crypto";
import {
  assessBackupKeys,
  BackupKeyIdCollector,
  createBackupKeyIdTextScanner,
  describeBackupKeyProblem,
  innerCiphertextKeyId,
} from "../backup-key-ids";

const K1 = "11".repeat(32);
const K2 = "22".repeat(32);
const K3 = "33".repeat(32);

function useKeys(keys: Record<string, string>, active: string) {
  delete process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEYS = JSON.stringify(keys);
  process.env.ENCRYPTION_ACTIVE_KEY_ID = active;
  _resetCryptoCacheForTests();
}

const saved = {
  key: process.env.ENCRYPTION_KEY,
  keys: process.env.ENCRYPTION_KEYS,
  active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
};

beforeEach(() => useKeys({ old: K1, cur: K2 }, "old"));
afterEach(() => {
  for (const [name, value] of [
    ["ENCRYPTION_KEY", saved.key],
    ["ENCRYPTION_KEYS", saved.keys],
    ["ENCRYPTION_ACTIVE_KEY_ID", saved.active],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetCryptoCacheForTests();
});

/** A Bytes column holding the string codec, as a DR payload carries it. */
const bytesString = (plain: string) =>
  Buffer.from(encrypt(plain), "utf8").toString("base64");
/** A Bytes column holding the binary codec, as a document's content. */
const binary = (plain: string) =>
  encryptBytes(Buffer.from(plain)).toString("base64");

describe("innerCiphertextKeyId", () => {
  it("reads the key id of each stored layout", () => {
    expect(innerCiphertextKeyId(encrypt("note"))).toEqual({
      keyId: "old",
      form: "string",
    });
    expect(innerCiphertextKeyId(bytesString("note"))).toEqual({
      keyId: "old",
      form: "bytes-string",
    });
    expect(innerCiphertextKeyId(binary("document"))).toEqual({
      keyId: "old",
      form: "binary",
    });
  });

  it("reads a value with no key id as the legacy v1 key", () => {
    const legacy = Buffer.from("A".repeat(40)).toString("base64");
    expect(innerCiphertextKeyId(legacy)?.keyId).toBe("v1");
  });

  it("ignores an empty value, a short one, and one that is not base64", () => {
    expect(innerCiphertextKeyId("")).toBeNull();
    expect(innerCiphertextKeyId("yes")).toBeNull();
    expect(
      innerCiphertextKeyId("not ciphertext at all, and long enough to count!"),
    ).toBeNull();
  });
});

describe("assessBackupKeys", () => {
  function fileWrittenUnderOld() {
    return {
      userId: "u1",
      moodEntries: [{ noteEncrypted: bytesString("a mood note") }],
      documents: [{ contentEncrypted: binary("%PDF-1.4 …") }],
      appSettings: { adminAiKeyEncrypted: encrypt("sk-something") },
    };
  }

  it("passes a file whose keys are all configured and open", () => {
    const collector = new BackupKeyIdCollector();
    collector.visit(fileWrittenUnderOld());
    collector.visit({ notesEncrypted: bytesString("x") }, "measurements");
    const verdict = assessBackupKeys(collector);
    expect(verdict).toEqual({
      keyIds: ["old"],
      missing: [],
      unreadable: [],
      affectedValues: 0,
    });
    expect(describeBackupKeyProblem(verdict)).toBeNull();
  });

  it("names a key the file needs and the host no longer has", () => {
    const file = fileWrittenUnderOld();
    useKeys({ cur: K2 }, "cur");
    const collector = new BackupKeyIdCollector();
    collector.visit(file);
    const verdict = assessBackupKeys(collector);
    expect(verdict.missing).toEqual(["old"]);
    expect(verdict.affectedValues).toBe(3);
    expect(describeBackupKeyProblem(verdict)).toContain("'old'");
  });

  it("leaves out sections the caller will not write", () => {
    useKeys({ old: K1, cur: K2 }, "cur");
    const file = {
      moodEntries: [{ noteEncrypted: bytesString("fine") }],
      appSettings: {
        adminAiKeyEncrypted: `gone.${Buffer.alloc(40).toString("base64")}`,
      },
    };
    const collector = new BackupKeyIdCollector();
    collector.visit(file);
    expect(assessBackupKeys(collector).missing).toEqual(["gone"]);
    expect(
      assessBackupKeys(collector, { ignoreSections: new Set(["appSettings"]) })
        .missing,
    ).toEqual([]);
  });

  it("leaves the cycle sections to the restore, which opens each value itself", () => {
    // A same-id impostor in a cycle note must neither refuse the file nor be
    // picked as the sample that proves the key for the sections that need it.
    const fine = encrypt("a measurement note under the real key");
    useKeys({ old: K3, cur: K2 }, "old");
    const impostor = encrypt("x");
    useKeys({ old: K1, cur: K2 }, "cur");
    const file = {
      measurements: [{ notesEncrypted: fine }],
      cycleDayLogs: [
        { notesEncrypted: impostor },
        { notesEncrypted: `gone.${Buffer.alloc(40).toString("base64")}` },
      ],
      customSymptoms: [
        { labelEncrypted: `gone.${Buffer.alloc(40).toString("base64")}` },
      ],
    };
    const collector = new BackupKeyIdCollector();
    collector.visit(file);
    const verdict = assessBackupKeys(collector);
    expect(verdict.missing).toEqual([]);
    expect(verdict.unreadable).toEqual([]);
  });

  it("catches an id that is configured with different key material", () => {
    const file = fileWrittenUnderOld();
    useKeys({ old: K3, cur: K2 }, "cur");
    const collector = new BackupKeyIdCollector();
    collector.visit(file);
    const verdict = assessBackupKeys(collector);
    expect(verdict.missing).toEqual([]);
    expect(verdict.unreadable).toEqual(["old"]);
  });
});

describe("createBackupKeyIdTextScanner", () => {
  it("finds every key id in JSON fed in arbitrary pieces", () => {
    const early = bytesString("written before the rotation");
    useKeys({ old: K1, cur: K2 }, "cur");
    const late = binary("written after it");
    const json = JSON.stringify({
      measurements: [{ id: "m1", notesEncrypted: early }],
      documents: [{ contentEncrypted: late, note: "plain" }],
      plain: "noteEncrypted",
    });
    for (const size of [1, 7, 33, 4096]) {
      const scanner = createBackupKeyIdTextScanner();
      for (let i = 0; i < json.length; i += size) {
        scanner.feed(Buffer.from(json.slice(i, i + size), "utf8"));
      }
      expect(scanner.keyIds()).toEqual(["cur", "old"]);
    }
  });

  it("reads pretty-printed JSON", () => {
    const scanner = createBackupKeyIdTextScanner();
    scanner.feed(
      JSON.stringify({ a: { noteEncrypted: bytesString("x") } }, null, 2),
    );
    expect(scanner.keyIds()).toEqual(["old"]);
  });
});
