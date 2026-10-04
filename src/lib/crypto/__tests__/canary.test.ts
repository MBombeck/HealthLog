import { beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  _resetCryptoCacheForTests,
  candidateMatchesKey,
  encrypt,
  encryptBytes,
  encryptUnderKeyId,
  extractKeyIdFromBytes,
  fingerprintKeyBytes,
  getKeyFingerprint,
} from "@/lib/crypto";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  ENCRYPTED_COLUMNS,
  WORKOUT_ROUTE_GEOMETRY_AAD,
  encryptedColumnKey,
} from "@/lib/crypto/encrypted-columns";
import {
  canaryPlaintext,
  checkEncryptionKeyCanaries,
  keyMismatchLogBlock,
  probeValueOpens,
  resolveColumnLocation,
  sqlColumnSampler,
  type CanaryClient,
  type ColumnSampler,
} from "../canary";

const KEY_A =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function configureKeys(keys: Record<string, string>, active: string) {
  vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify(keys));
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", active);
  vi.stubEnv("ENCRYPTION_KEY", "");
  _resetCryptoCacheForTests();
}

function configureKey(hex: string) {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", hex);
  _resetCryptoCacheForTests();
}

type Seeded =
  | string
  | Uint8Array
  | { value: string | Uint8Array | null; ts?: string; codec?: string };

/**
 * An in-memory stand-in for the raw statements, plus a sampler over seeded
 * values keyed by `Model.field`. A seeded value's `ts` orders it; values
 * without one keep their seeded order after every dated value, as the SQL
 * sampler orders them.
 */
function fakeClient(opts: {
  canaries?: Record<string, string>;
  probe?: Record<string, Seeded[]>;
  /** Make the sampler throw for these columns. */
  unreadable?: string[];
  /** Make the sampler throw for every column when asked for its newest values. */
  newestUnreadable?: boolean;
  /** Another process seals this id (with this ciphertext) just before us. */
  race?: { keyId: string; ciphertext: string };
}) {
  const canaries = new Map(Object.entries(opts.canaries ?? {}));
  const inserts: string[] = [];
  let raced = false;
  const client = {
    async $queryRaw(_q: TemplateStringsArray, ...values: unknown[]) {
      const [arg] = values;
      if (typeof arg === "string") {
        const c = canaries.get(arg);
        return c ? [{ ciphertext: c }] : [];
      }
      return [...canaries.entries()].map(([key_id, ciphertext]) => ({
        key_id,
        ciphertext,
      }));
    },
    async $executeRaw(_q: TemplateStringsArray, ...values: unknown[]) {
      const [keyId, ciphertext] = values as [string, string];
      if (opts.race && !raced && opts.race.keyId === keyId) {
        raced = true;
        canaries.set(keyId, opts.race.ciphertext);
      }
      inserts.push(keyId);
      if (canaries.has(keyId)) return 0;
      canaries.set(keyId, ciphertext);
      return 1;
    },
  } as unknown as CanaryClient;
  const sampler: ColumnSampler = async (column, keyId, limit, order) => {
    const key = `${column.model}.${column.field}`;
    if (opts.unreadable?.includes(key)) throw new Error("relation missing");
    if (opts.newestUnreadable && order === "newest") {
      throw new Error("canceling statement due to statement timeout");
    }
    const rows = (opts.probe?.[key] ?? []).map((v) =>
      typeof v === "string" || v instanceof Uint8Array
        ? { value: v, ts: null as Date | null, codec: null }
        : {
            value: v.value,
            ts: v.ts ? new Date(v.ts) : null,
            codec: v.codec ?? null,
          },
    );
    const under = rows.filter((r) => {
      if (r.value === null) return true;
      if (typeof r.value === "string") return r.value.startsWith(`${keyId}.`);
      const b = Buffer.from(r.value);
      return (
        b.toString("latin1").startsWith(`${keyId}.`) ||
        extractKeyIdFromBytes(b) === keyId
      );
    });
    const oldestFirst = under
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const ta = a.r.ts?.getTime() ?? Infinity;
        const tb = b.r.ts?.getTime() ?? Infinity;
        return ta === tb ? a.i - b.i : ta - tb;
      });
    if (order === "newest") oldestFirst.reverse();
    return oldestFirst.slice(0, limit).map(({ r }) => r);
  };
  const check = (budget?: number) =>
    checkEncryptionKeyCanaries(client, { sampler, probeBudgetMs: budget });
  return { client, sampler, canaries, inserts, check };
}

const ok = (fields: {
  written?: string[];
  verified?: string[];
  inconclusive?: Array<{ keyId: string; reason: string }>;
}) => ({
  state: "ok",
  written: fields.written ?? [],
  verified: fields.verified ?? [],
  inconclusive: fields.inconclusive ?? [],
});

describe("encryption key canary", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    configureKey(KEY_A);
  });

  it("writes a canary for a configured key when no column holds a value under its id", async () => {
    const { canaries, inserts, check } = fakeClient({});
    expect(await check()).toEqual(ok({ written: ["v1"] }));
    expect(inserts).toEqual(["v1"]);
    expect(canaries.get("v1")?.startsWith("v1.")).toBe(true);
  });

  it("verifies a canary written under the same key", async () => {
    const { inserts, check } = fakeClient({
      canaries: { v1: encryptUnderKeyId(canaryPlaintext("v1"), "v1") },
    });
    expect(await check()).toEqual(ok({ verified: ["v1"] }));
    expect(inserts).toEqual([]);
  });

  it("reports a mismatch when the key changed under the same id", async () => {
    const sealedUnderA = encryptUnderKeyId(canaryPlaintext("v1"), "v1");
    configureKey(KEY_B);
    const { inserts, check } = fakeClient({ canaries: { v1: sealedUnderA } });
    expect(await check()).toEqual({ state: "mismatch", keyIds: ["v1"] });
    expect(inserts).toEqual([]);
  });

  it("reports a mismatch for a canary that opens to the wrong value", async () => {
    // A row from another key id copied over: opens, but says the wrong thing.
    const { check } = fakeClient({
      canaries: { v1: encryptUnderKeyId(canaryPlaintext("v2"), "v1") },
    });
    expect((await check()).state).toBe("mismatch");
  });

  it("refuses to seal a wrong key when existing data predates the canary", async () => {
    const existing = [encrypt("a stored token"), encrypt("another token")];
    configureKey(KEY_B);
    const { inserts, check } = fakeClient({
      probe: {
        "User.codexAccessTokenEncrypted": [existing[0]],
        "User.codexRefreshTokenEncrypted": [existing[1]],
      },
    });
    expect(await check()).toEqual({ state: "mismatch", keyIds: ["v1"] });
    expect(inserts).toEqual([]);
  });

  it("writes the canary when existing data opens under the key", async () => {
    const { inserts, check } = fakeClient({
      probe: { "User.codexAccessTokenEncrypted": [encrypt("a stored token")] },
    });
    expect((await check()).state).toBe("ok");
    expect(inserts).toEqual(["v1"]);
  });

  it("one damaged row among good ones does not take the server down", async () => {
    // A row that claims key id v1 but does not open (damaged, or sealed by
    // something else), found FIRST, then values that open.
    const damaged = "v1." + Buffer.alloc(40, 7).toString("base64");
    const { inserts, check } = fakeClient({
      probe: {
        "User.codexAccessTokenEncrypted": [damaged],
        "User.codexRefreshTokenEncrypted": [encrypt("a stored token")],
      },
    });
    expect((await check()).state).toBe("ok");
    expect(inserts).toEqual(["v1"]);
  });

  it("several values in one column count, so a wrong key with one busy column still refuses", async () => {
    const values = [encrypt("one"), encrypt("two"), encrypt("three")];
    configureKey(KEY_B);
    const { inserts, check } = fakeClient({
      probe: { "User.codexAccessTokenEncrypted": values },
    });
    expect(await check()).toEqual({ state: "mismatch", keyIds: ["v1"] });
    expect(inserts).toEqual([]);
  });

  it("a single value that does not open is inconclusive: no mismatch, no canary", async () => {
    const existing = encrypt("the only stored token");
    configureKey(KEY_B);
    const { inserts, check } = fakeClient({
      probe: { "User.codexAccessTokenEncrypted": [existing] },
    });
    expect(await check()).toEqual(
      ok({ inconclusive: [{ keyId: "v1", reason: "single-value" }] }),
    );
    expect(inserts).toEqual([]);
  });

  describe("Bytes columns", () => {
    it("a wrong key over Bytes-only ciphertext refuses instead of sealing", async () => {
      const notes = [encryptToBytes("note one"), encryptToBytes("note two")];
      configureKey(KEY_B);
      const { inserts, check } = fakeClient({
        probe: {
          "MoodEntry.noteEncrypted": [notes[0]],
          "Measurement.notesEncrypted": [notes[1]],
        },
      });
      expect(await check()).toEqual({ state: "mismatch", keyIds: ["v1"] });
      expect(inserts).toEqual([]);
    });

    it("opens the binary layout with its label, and the UTF-8 layout", async () => {
      const route = encryptBytes(Buffer.from("{}"), WORKOUT_ROUTE_GEOMETRY_AAD);
      const { inserts, check } = fakeClient({
        probe: {
          "WorkoutRoute.geometryEncrypted": [
            { value: route, ts: "2024-01-01" },
          ],
          "MoodEntry.noteEncrypted": [
            { value: encryptToBytes("a note"), ts: "2024-01-02" },
          ],
        },
      });
      expect(await check()).toEqual(ok({ written: ["v1"] }));
      expect(inserts).toEqual(["v1"]);
    });

    it("a binary value under the wrong label does not count as opening", () => {
      const sealed = encryptBytes(Buffer.from("x"), "some/other/label");
      const column = ENCRYPTED_COLUMNS.find((c) => c.model === "WorkoutRoute")!;
      expect(probeValueOpens(column, { value: sealed, ts: null }, "v1")).toBe(
        false,
      );
    });

    it("dispatches a codec column by the row's codec", () => {
      const column = ENCRYPTED_COLUMNS.find(
        (c) => c.model === "InboundDocument" && c.field === "contentEncrypted",
      )!;
      const binary = encryptBytes(Buffer.from("%PDF"));
      const text = encryptToBytes("JVBERg==");
      expect(
        probeValueOpens(
          column,
          { value: binary, codec: "binary2", ts: null },
          "v1",
        ),
      ).toBe(true);
      expect(
        probeValueOpens(
          column,
          { value: text, codec: "base64v1", ts: null },
          "v1",
        ),
      ).toBe(true);
    });
  });

  describe("oldest values decide", () => {
    function seedOldAThenNewB() {
      const old = [
        encrypt("old 1"),
        encrypt("old 2"),
        encryptToBytes("old note 1"),
        encryptToBytes("old note 2"),
      ];
      configureKey(KEY_B);
      const recent = [
        encrypt("new 1"),
        encrypt("new 2"),
        encryptToBytes("new note 1"),
        encryptToBytes("new note 2"),
      ];
      configureKey(KEY_A);
      return fakeClient({
        probe: {
          "User.codexAccessTokenEncrypted": [
            { value: recent[0], ts: "2026-09-01" },
            { value: old[0], ts: "2024-01-01" },
          ],
          "User.codexRefreshTokenEncrypted": [
            { value: old[1], ts: "2024-01-02" },
            { value: recent[1], ts: "2026-09-02" },
          ],
          "MoodEntry.noteEncrypted": [
            { value: recent[2], ts: "2026-09-03" },
            { value: old[2], ts: "2024-01-03" },
          ],
          "Measurement.notesEncrypted": [
            { value: old[3], ts: "2024-01-04" },
            { value: recent[3], ts: "2026-09-04" },
          ],
        },
      });
    }

    it("the key that wrote only the newer rows is never sealed", async () => {
      const fake = seedOldAThenNewB();
      configureKey(KEY_B);
      const outcome = await fake.check();
      expect(outcome.state).not.toBe("error");
      if (outcome.state === "ok") expect(outcome.written).toEqual([]);
      expect(fake.canaries.size).toBe(0);
    });

    it("the key that wrote the oldest rows is sealed, newer unreadable rows notwithstanding", async () => {
      const fake = seedOldAThenNewB();
      expect(await fake.check()).toEqual(ok({ written: ["v1"] }));
    });

    it("two oldest values that fail before one that opens are mixed: inconclusive", async () => {
      const opens = encrypt("opens");
      configureKey(KEY_B);
      const foreign = [encrypt("x"), encrypt("y")];
      configureKey(KEY_A);
      const { inserts, check } = fakeClient({
        probe: {
          "User.codexAccessTokenEncrypted": [
            { value: foreign[0], ts: "2024-01-01" },
          ],
          "User.codexRefreshTokenEncrypted": [
            { value: foreign[1], ts: "2024-01-02" },
          ],
          "MoodEntry.noteEncrypted": [{ value: opens, ts: "2025-01-01" }],
        },
      });
      expect(await check()).toEqual(
        ok({ inconclusive: [{ keyId: "v1", reason: "mixed" }] }),
      );
      expect(inserts).toEqual([]);
    });
  });

  describe("the newest values are asked before a refusal", () => {
    /**
     * Eight old values (two in each of four columns, so the oldest-first
     * pool holds nothing else) sealed under `oldKey`, and two newer values
     * per column sealed under `newKey`. Returns the fake, configured with
     * KEY_B.
     */
    function seedOldThenNew(oldKey: string, newKey: string) {
      configureKey(oldKey);
      const old = [
        encrypt("old 1"),
        encrypt("old 2"),
        encrypt("old 3"),
        encrypt("old 4"),
        encryptToBytes("old note 1"),
        encryptToBytes("old note 2"),
        encryptToBytes("old note 3"),
        encryptToBytes("old note 4"),
      ];
      configureKey(newKey);
      const recent = [
        encrypt("new 1"),
        encrypt("new 2"),
        encrypt("new 3"),
        encrypt("new 4"),
        encryptToBytes("new note 1"),
        encryptToBytes("new note 2"),
        encryptToBytes("new note 3"),
        encryptToBytes("new note 4"),
      ];
      configureKey(KEY_B);
      const columns = [
        "User.codexAccessTokenEncrypted",
        "User.codexRefreshTokenEncrypted",
        "MoodEntry.noteEncrypted",
        "Measurement.notesEncrypted",
      ];
      const probe: Record<string, Seeded[]> = {};
      columns.forEach((key, i) => {
        probe[key] = [
          { value: recent[2 * i], ts: `2026-09-0${i + 1}` },
          { value: old[2 * i], ts: `2023-0${i + 1}-01` },
          { value: recent[2 * i + 1], ts: `2026-09-1${i + 1}` },
          { value: old[2 * i + 1], ts: `2023-0${i + 1}-02` },
        ];
      });
      return probe;
    }

    it("old rows under a lost key and current data under the configured key: mixed, not a mismatch", async () => {
      // A database reinstalled under a fresh key long ago: the old rows are
      // sealed under a key nobody has any more, and everything written since
      // opens under the configured one. Refusing would take a working
      // install down on upgrade.
      const { inserts, canaries, check } = fakeClient({
        probe: seedOldThenNew(KEY_A, KEY_B),
      });
      expect(await check()).toEqual(
        ok({ inconclusive: [{ keyId: "v1", reason: "mixed" }] }),
      );
      // A newest-only open never seals.
      expect(inserts).toEqual([]);
      expect(canaries.size).toBe(0);
    });

    it("old rows under A and newer rows under B, configured B, is never sealed or verified", async () => {
      const { inserts, check } = fakeClient({
        probe: seedOldThenNew(KEY_A, KEY_B),
      });
      const outcome = await check();
      expect(outcome.state).toBe("ok");
      if (outcome.state !== "ok") return;
      expect(outcome.written).toEqual([]);
      expect(outcome.verified).toEqual([]);
      expect(inserts).toEqual([]);
    });

    it("old AND newest values that all fail are a mismatch", async () => {
      const { inserts, check } = fakeClient({
        probe: seedOldThenNew(KEY_A, KEY_A),
      });
      expect(await check()).toEqual({ state: "mismatch", keyIds: ["v1"] });
      expect(inserts).toEqual([]);
    });

    it("the newest values that cannot be read are inconclusive, never a mismatch", async () => {
      const { inserts, check } = fakeClient({
        probe: seedOldThenNew(KEY_A, KEY_A),
        newestUnreadable: true,
      });
      expect(await check()).toEqual(
        ok({ inconclusive: [{ keyId: "v1", reason: "incomplete" }] }),
      );
      expect(inserts).toEqual([]);
    });
  });

  describe("nothing unproven seals", () => {
    it("a probe out of time is inconclusive, even over data that opens", async () => {
      const { inserts, check } = fakeClient({
        probe: { "User.codexAccessTokenEncrypted": [encrypt("opens")] },
      });
      expect(await check(-1)).toEqual(
        ok({ inconclusive: [{ keyId: "v1", reason: "incomplete" }] }),
      );
      expect(inserts).toEqual([]);
    });

    it("a column that cannot be read is inconclusive, never a fresh install", async () => {
      const { inserts, check } = fakeClient({
        unreadable: ["MoodEntry.noteEncrypted"],
      });
      expect(await check()).toEqual(
        ok({ inconclusive: [{ keyId: "v1", reason: "incomplete" }] }),
      );
      expect(inserts).toEqual([]);
    });

    it("values too large to fetch are present: inconclusive, not fresh", async () => {
      const { inserts, check } = fakeClient({
        probe: { "InboundDocument.contentEncrypted": [{ value: null }] },
      });
      expect(await check()).toEqual(
        ok({ inconclusive: [{ keyId: "v1", reason: "unsampled" }] }),
      );
      expect(inserts).toEqual([]);
    });
  });

  describe("ENCRYPTION_KEY_CHECK=warn", () => {
    it("records nothing for any key id while one is inconclusive", async () => {
      configureKeys({ v1: KEY_A, v2: KEY_B }, "v2");
      const lone = encryptUnderKeyId("only value", "v1");
      configureKeys({ v1: KEY_B, v2: KEY_A }, "v2");
      const fake = fakeClient({
        probe: { "User.codexAccessTokenEncrypted": [lone] },
      });
      // Enforce records the proven id beside the inconclusive one.
      expect(await fake.check()).toEqual(
        ok({
          written: ["v2"],
          inconclusive: [{ keyId: "v1", reason: "single-value" }],
        }),
      );
      const warn = fakeClient({
        probe: { "User.codexAccessTokenEncrypted": [lone] },
      });
      expect(
        await checkEncryptionKeyCanaries(warn.client, {
          sampler: warn.sampler,
          mode: "warn",
        }),
      ).toEqual(
        ok({ inconclusive: [{ keyId: "v1", reason: "single-value" }] }),
      );
      expect(warn.inserts).toEqual([]);
    });

    it("records a key that passes for every id, as enforce does", async () => {
      const warn = fakeClient({
        probe: { "User.codexAccessTokenEncrypted": [encrypt("opens")] },
      });
      expect(
        await checkEncryptionKeyCanaries(warn.client, {
          sampler: warn.sampler,
          mode: "warn",
        }),
      ).toEqual(ok({ written: ["v1"] }));
    });
  });

  describe("the first-seal race", () => {
    it("losing it to a process with another key is a mismatch", async () => {
      configureKey(KEY_B);
      const otherCanary = encryptUnderKeyId(canaryPlaintext("v1"), "v1");
      configureKey(KEY_A);
      const { check } = fakeClient({
        race: { keyId: "v1", ciphertext: otherCanary },
      });
      expect(await check()).toEqual({ state: "mismatch", keyIds: ["v1"] });
    });

    it("losing it to a process with the same key verifies", async () => {
      const { check } = fakeClient({
        race: {
          keyId: "v1",
          ciphertext: encryptUnderKeyId(canaryPlaintext("v1"), "v1"),
        },
      });
      expect(await check()).toEqual(ok({ verified: ["v1"] }));
    });
  });

  it("reports an error, not a mismatch, when the table cannot be read", async () => {
    const client = {
      $queryRaw: async () => {
        throw new Error('relation "encryption_key_canaries" does not exist');
      },
      $executeRaw: async () => 0,
    } as unknown as CanaryClient;
    const outcome = await checkEncryptionKeyCanaries(client);
    expect(outcome.state).toBe("error");
  });

  it("reports an error when no key is configured", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    const outcome = await fakeClient({}).check();
    expect(outcome.state).toBe("error");
  });

  it("names the key ids, the reset statement, and never a key in the log block", () => {
    const block = keyMismatchLogBlock(["v1"]);
    expect(block).toContain("'v1'");
    expect(block).toContain("encryption.key_mismatch");
    expect(block).toContain(
      "DELETE FROM encryption_key_canaries WHERE key_id = 'v1';",
    );
    expect(block).not.toContain(KEY_A);
  });
});

describe("the SQL sampler's column map", () => {
  it("resolves every registered column to a table, a column and an order", () => {
    // A throwaway client: never connects, only exposes the data model the
    // probe reads table and column names from.
    const client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgres://x:y@127.0.0.1:1/x",
      }),
    });
    for (const column of ENCRYPTED_COLUMNS) {
      const loc = resolveColumnLocation(client, column);
      expect(loc.table, encryptedColumnKey(column)).toMatch(/^[a-z_0-9]+$/);
      expect(loc.column, encryptedColumnKey(column)).toMatch(/^[a-z_0-9]+$/);
      if (column.codecField) expect(loc.codec).not.toBeNull();
    }
    const backupPieces = ENCRYPTED_COLUMNS.find(
      (c) => c.model === "DataBackupChunk",
    )!;
    expect(resolveColumnLocation(client, backupPieces).ts).toBeNull();
    const user = ENCRYPTED_COLUMNS.find((c) => c.model === "User")!;
    expect(resolveColumnLocation(client, user).ts).toBe("updated_at");
  });
});

describe("the SQL sampler's bounds", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    configureKey(KEY_A);
  });

  /** A client whose probe queries the server cancels at the timeout. */
  function timingOutClient() {
    const model = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgres://x:y@127.0.0.1:1/x",
      }),
    }) as unknown as { _runtimeDataModel: unknown };
    const settings: unknown[][] = [];
    const statements: string[] = [];
    const transactionOptions: unknown[] = [];
    const tx = {
      async $executeRaw(_q: TemplateStringsArray, ...values: unknown[]) {
        settings.push(values);
        return 1;
      },
      async $queryRawUnsafe(sql: string) {
        statements.push(sql);
        throw new Error("canceling statement due to statement timeout");
      },
    };
    const client = {
      _runtimeDataModel: model._runtimeDataModel,
      $queryRaw: async () => [],
      $executeRaw: async () => {
        throw new Error("nothing may be sealed");
      },
      $queryRawUnsafe: async () => [],
      async $transaction(
        fn: (t: typeof tx) => Promise<unknown>,
        options: unknown,
      ) {
        transactionOptions.push(options);
        return fn(tx);
      },
    } as unknown as CanaryClient;
    return { client, settings, statements, transactionOptions };
  }

  it("a probe query cancelled at its statement timeout is inconclusive, not a hang or a mismatch", async () => {
    const fake = timingOutClient();
    expect(await checkEncryptionKeyCanaries(fake.client)).toEqual(
      ok({ inconclusive: [{ keyId: "v1", reason: "incomplete" }] }),
    );
    // Every probe query runs under a transaction-local statement timeout.
    expect(fake.settings).toEqual([["2000"]]);
    expect(fake.statements).toHaveLength(1);
    expect(fake.transactionOptions[0]).toMatchObject({ timeout: 7_000 });
  });

  it("reads the newest values in the exact mirror of the oldest order", async () => {
    const fake = timingOutClient();
    const sampler = sqlColumnSampler(fake.client, { statementTimeoutMs: 50 });
    const user = ENCRYPTED_COLUMNS.find((c) => c.model === "User")!;
    await expect(sampler(user, "v1", 2, "oldest")).rejects.toThrow();
    await expect(sampler(user, "v1", 2, "newest")).rejects.toThrow();
    expect(fake.settings).toEqual([["50"], ["50"]]);
    expect(fake.statements[0]).toContain(
      'ORDER BY "updated_at" ASC NULLS LAST, "id" ASC LIMIT',
    );
    expect(fake.statements[1]).toContain(
      'ORDER BY "updated_at" DESC NULLS FIRST, "id" DESC LIMIT',
    );
  });

  it("refuses to run without transactions rather than run unbounded", () => {
    const client = {
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      $queryRawUnsafe: async () => [],
    } as unknown as CanaryClient;
    expect(() => sqlColumnSampler(client)).toThrow();
  });
});

describe("key fingerprint and copy check", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    configureKey(KEY_A);
  });

  it("is the first 12 hex of SHA-256 over the raw key bytes", () => {
    expect(getKeyFingerprint("v1")).toBe(
      fingerprintKeyBytes(Buffer.from(KEY_A, "hex")),
    );
    expect(getKeyFingerprint("v1")).toMatch(/^[0-9a-f]{12}$/);
    expect(getKeyFingerprint("v1")).not.toBe(
      fingerprintKeyBytes(Buffer.from(KEY_B, "hex")),
    );
    expect(getKeyFingerprint("nope")).toBeNull();
  });

  it("matches the configured key in hex, base64 and with whitespace", () => {
    expect(candidateMatchesKey(KEY_A, "v1")).toBe(true);
    expect(candidateMatchesKey(`  ${KEY_A.toUpperCase()}\n`, "v1")).toBe(true);
    expect(
      candidateMatchesKey(Buffer.from(KEY_A, "hex").toString("base64"), "v1"),
    ).toBe(true);
  });

  it("does not match another key, garbage, or an unknown id", () => {
    expect(candidateMatchesKey(KEY_B, "v1")).toBe(false);
    expect(candidateMatchesKey("not a key", "v1")).toBe(false);
    expect(candidateMatchesKey(KEY_A, "v9")).toBe(false);
  });
});
