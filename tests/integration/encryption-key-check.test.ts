/**
 * The boot encryption key check and the "Back up your encryption key" step,
 * against real Postgres.
 *
 *   - a first boot writes a canary; a second boot with the same key opens it;
 *   - a boot with another key under the same id refuses: the state is set,
 *     every API route answers 503 `encryption.key_mismatch`, `/api/health`
 *     names the reason, and nothing is written;
 *   - a database written before the canary existed is probed: data that does
 *     not open under the configured key refuses rather than sealing the wrong
 *     key as the right one;
 *   - the confirmation binds to the active key id and fingerprint, refuses a
 *     stale one with 409, and is due again after a re-keyed install;
 *   - "Check my copy" answers a boolean, stores nothing, and is rate limited.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import {
  _resetCryptoCacheForTests,
  encrypt,
  encryptUnderKeyId,
  getKeyFingerprint,
} from "@/lib/crypto";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { runBootKeyCheck } from "@/lib/boot/key-check";
import {
  canaryPlaintext,
  checkEncryptionKeyCanaries,
  retireCanariesWithoutData,
  sqlColumnSampler,
  type CanaryClient,
} from "@/lib/crypto/canary";
import {
  getKeyMismatchWarning,
  isKeyMismatch,
  setKeyMismatchState,
  setKeyMismatchWarning,
} from "@/lib/boot/key-mismatch-state";

const KEY_A =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function useKey(hex: string) {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", hex);
  _resetCryptoCacheForTests();
}

async function seedAdmin(): Promise<string> {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: "key-admin",
      email: "key-admin@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin.id;
}

/** The GET handlers take no parameter; `apiHandler` still reads the request. */
type RouteFn = (request: NextRequest) => Promise<Response>;
const asRoute = (fn: unknown) => fn as RouteFn;

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.$executeRaw`DELETE FROM encryption_key_canaries`;
  await prisma.$executeRaw`DELETE FROM rate_limits WHERE key LIKE 'key-backup-verify:%'`;
  cookieJar.clear();
  headerJar.clear();
  useKey(KEY_A);
  setKeyMismatchState(null);
});

afterEach(() => {
  setKeyMismatchState(null);
  vi.unstubAllEnvs();
  _resetCryptoCacheForTests();
});

describe("boot encryption key check (real Postgres)", () => {
  it("writes a canary on first boot and opens it on the next", async () => {
    const prisma = getPrismaClient();
    expect(await runBootKeyCheck(prisma)).toBe(false);
    const rows = await prisma.encryptionKeyCanary.findMany();
    expect(rows.map((r) => r.keyId)).toEqual(["v1"]);
    expect(rows[0].ciphertext.startsWith("v1.")).toBe(true);

    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(isKeyMismatch()).toBe(false);
  });

  it("refuses to serve when the key changed under the same id", async () => {
    const prisma = getPrismaClient();
    await runBootKeyCheck(prisma);
    const before = await prisma.encryptionKeyCanary.findMany();

    useKey(KEY_B);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(true);
    expect(errors.mock.calls[0]?.[0]).toContain("encryption.key_mismatch");
    errors.mockRestore();
    expect(isKeyMismatch()).toBe(true);
    // Nothing re-sealed under the wrong key.
    expect(await prisma.encryptionKeyCanary.findMany()).toEqual(before);

    await seedAdmin();
    const { GET: keyBackupGet } =
      await import("@/app/api/admin/encryption/key-backup/route");
    const refused = await asRoute(keyBackupGet)(
      new NextRequest("http://localhost/api/admin/encryption/key-backup"),
    );
    expect(refused.status).toBe(503);
    const body = await refused.json();
    expect(body.meta).toEqual({ errorCode: "encryption.key_mismatch" });

    const { GET: healthGet } = await import("@/app/api/health/route");
    const health = await asRoute(healthGet)(
      new NextRequest("http://localhost/api/health"),
    );
    expect(health.status).toBe(503);
    const healthBody = await health.json();
    expect(healthBody.status).toBe("degraded");
    expect(healthBody.reason).toBe("encryption_key_mismatch");

    // Restoring the original key clears it on the next boot.
    useKey(KEY_A);
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(isKeyMismatch()).toBe(false);
  });

  it("refuses rather than sealing the wrong key over data that predates the canary", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        username: "existing",
        email: "existing@example.test",
        codexAccessTokenEncrypted: encrypt("a stored token"),
        codexRefreshTokenEncrypted: encrypt("another stored token"),
      },
    });

    useKey(KEY_B);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(true);
    errors.mockRestore();
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);

    // With the right key the same data lets the canary be written.
    useKey(KEY_A);
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(await prisma.encryptionKeyCanary.count()).toBe(1);
  });
});

describe("boot key check probe over existing data (real Postgres)", () => {
  it("one damaged row among good ones still lets the right key through", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        username: "damaged",
        email: "damaged@example.test",
        codexAccessTokenEncrypted:
          "v1." + Buffer.alloc(40, 7).toString("base64"),
        codexRefreshTokenEncrypted: encrypt("a good token"),
      },
    });
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(isKeyMismatch()).toBe(false);
    expect(await prisma.encryptionKeyCanary.count()).toBe(1);
  });

  it("a single value that does not open neither refuses nor writes a canary", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        username: "single",
        email: "single@example.test",
        codexAccessTokenEncrypted: encrypt("the only token"),
      },
    });
    useKey(KEY_B);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(warn.mock.calls[0]?.[0]).toContain("inconclusive");
    warn.mockRestore();
    expect(isKeyMismatch()).toBe(false);
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);
  });
});

/** Two users, one oldest, with ciphertext in string AND Bytes columns. */
async function seedUser(
  name: string,
  writtenAt: Date,
  seal: () => { text: string; bytes: Uint8Array<ArrayBuffer> },
) {
  const prisma = getPrismaClient();
  const a = seal();
  const b = seal();
  const user = await prisma.user.create({
    data: {
      username: name,
      email: `${name}@example.test`,
      codexAccessTokenEncrypted: a.text,
      codexRefreshTokenEncrypted: b.text,
      createdAt: writtenAt,
      updatedAt: writtenAt,
    },
  });
  await prisma.userHealthProfile.create({
    data: {
      userId: user.id,
      aboutMeEncrypted: a.bytes,
      conditionsEncrypted: b.bytes,
      createdAt: writtenAt,
      updatedAt: writtenAt,
    },
  });
  return user.id;
}

const sealNow = () => ({
  text: encrypt("a stored value"),
  bytes: encryptToBytes("a stored note"),
});

describe("boot key check: what decides, and what may seal (real Postgres)", () => {
  it("probes Bytes columns: an install whose ciphertext is only Bytes does not seal a wrong key", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "bytes-only", email: "bytes-only@example.test" },
    });
    await prisma.userHealthProfile.create({
      data: {
        userId: user.id,
        aboutMeEncrypted: encryptToBytes("about me"),
        conditionsEncrypted: encryptToBytes("conditions"),
        allergiesEncrypted: encryptToBytes("allergies"),
      },
    });

    useKey(KEY_B);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(true);
    errors.mockRestore();
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);

    useKey(KEY_A);
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(await prisma.encryptionKeyCanary.count()).toBe(1);
  });

  it("a probe that runs out of time seals nothing and keeps serving", async () => {
    const prisma = getPrismaClient();
    await seedUser("slow", new Date("2024-01-01T00:00:00Z"), sealNow);
    const outcome = await checkEncryptionKeyCanaries(prisma, {
      probeBudgetMs: -1,
    });
    expect(outcome.state).toBe("ok");
    if (outcome.state !== "ok") return;
    expect(outcome.written).toEqual([]);
    expect(outcome.inconclusive.map((i) => i.keyId)).toEqual(["v1"]);
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);
  });

  it("a fresh database with no ciphertext under the key id seals it", async () => {
    const prisma = getPrismaClient();
    // Ciphertext exists, but under another key id: not evidence about v1.
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_A, v2: KEY_B }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v2");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    await seedUser("v2-only", new Date("2024-01-01T00:00:00Z"), sealNow);
    expect(await runBootKeyCheck(prisma)).toBe(false);
    const ids = (await prisma.encryptionKeyCanary.findMany())
      .map((r) => r.keyId)
      .sort();
    expect(ids).toEqual(["v1", "v2"]);
  });

  it("rows a wrong key wrote recently never decide: old rows under A, newer under B", async () => {
    const prisma = getPrismaClient();
    // The original data, under A.
    await seedUser("original", new Date("2024-01-01T00:00:00Z"), sealNow);
    await seedUser("original-2", new Date("2024-02-01T00:00:00Z"), sealNow);
    // A process holding B served for a while (no canary yet) and wrote more.
    useKey(KEY_B);
    for (let i = 0; i < 6; i++) {
      await seedUser(
        `recent-${i}`,
        new Date(Date.UTC(2026, 8, 1 + i)),
        sealNow,
      );
    }

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await runBootKeyCheck(prisma);
    warn.mockRestore();
    errors.mockRestore();
    // B is not sealed as the right key, whatever else the verdict is.
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);
    const outcome = await checkEncryptionKeyCanaries(prisma);
    expect(
      outcome.state === "mismatch" ||
        (outcome.state === "ok" && outcome.written.length === 0),
    ).toBe(true);

    // The key the oldest data was written with is the right one.
    useKey(KEY_A);
    setKeyMismatchState(null);
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(isKeyMismatch()).toBe(false);
    expect(await prisma.encryptionKeyCanary.count()).toBe(1);
  });

  it("old rows under a lost key, newer rows under the configured key: serves, warns, seals nothing", async () => {
    const prisma = getPrismaClient();
    // Sealed under a key that is gone: the eight oldest values the probe
    // reads first (two per column, four columns).
    await seedUser("lost-1", new Date("2023-01-01T00:00:00Z"), sealNow);
    await seedUser("lost-2", new Date("2023-02-01T00:00:00Z"), sealNow);
    // Everything since, under the key the install runs with today.
    useKey(KEY_B);
    for (let i = 0; i < 4; i++) {
      await seedUser(
        `current-${i}`,
        new Date(Date.UTC(2025, 0, 1 + i)),
        sealNow,
      );
    }

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(isKeyMismatch()).toBe(false);
    expect(errors).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain("inconclusive");
    warn.mockRestore();
    errors.mockRestore();
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);
    expect(await checkEncryptionKeyCanaries(prisma)).toEqual({
      state: "ok",
      written: [],
      verified: [],
      inconclusive: [{ keyId: "v1", reason: "mixed" }],
    });
  });

  it("old AND newest values that do not open still refuse", async () => {
    const prisma = getPrismaClient();
    await seedUser("a-1", new Date("2023-01-01T00:00:00Z"), sealNow);
    await seedUser("a-2", new Date("2023-02-01T00:00:00Z"), sealNow);
    for (let i = 0; i < 4; i++) {
      await seedUser(`a-new-${i}`, new Date(Date.UTC(2025, 0, 1 + i)), sealNow);
    }
    useKey(KEY_B);
    expect(await checkEncryptionKeyCanaries(prisma)).toEqual({
      state: "mismatch",
      keyIds: ["v1"],
    });
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);
  });

  it("a probe query held up by a lock gives up at its statement timeout: inconclusive, not a hang", async () => {
    const prisma = getPrismaClient();
    await seedUser("locked", new Date("2024-01-01T00:00:00Z"), sealNow);
    const outcome = await prisma.$transaction(
      async (tx) => {
        // Another session holds the table: every read of it waits.
        await tx.$executeRaw`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`;
        const started = Date.now();
        const result = await checkEncryptionKeyCanaries(prisma, {
          sampler: sqlColumnSampler(prisma, { statementTimeoutMs: 200 }),
        });
        return { result, elapsed: Date.now() - started };
      },
      { timeout: 20_000 },
    );
    expect(outcome.result).toEqual({
      state: "ok",
      written: [],
      verified: [],
      inconclusive: [{ keyId: "v1", reason: "incomplete" }],
    });
    expect(outcome.elapsed).toBeLessThan(5_000);
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);
  });

  it("losing the first-seal race to another key is a mismatch, not ok", async () => {
    const prisma = getPrismaClient();
    // The other process, holding A, wins the insert between our probe and
    // our write.
    const sealedUnderA = encryptUnderKeyId(canaryPlaintext("v1"), "v1");
    useKey(KEY_B);
    let raced = false;
    const racing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "$executeRaw") {
          return async (q: TemplateStringsArray, ...values: unknown[]) => {
            if (!raced) {
              raced = true;
              await target.$executeRaw`INSERT INTO encryption_key_canaries (key_id, ciphertext) VALUES ('v1', ${sealedUnderA})`;
            }
            return target.$executeRaw(q, ...values);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as CanaryClient;
    const outcome = await checkEncryptionKeyCanaries(racing);
    expect(raced).toBe(true);
    expect(outcome).toEqual({ state: "mismatch", keyIds: ["v1"] });

    // The same race lost to a process holding the SAME key is fine.
    await prisma.$executeRaw`DELETE FROM encryption_key_canaries`;
    raced = false;
    useKey(KEY_A);
    const same = await checkEncryptionKeyCanaries(racing);
    expect(same.state).toBe("ok");
  });
});

describe("ENCRYPTION_KEY_CHECK (real Postgres)", () => {
  afterEach(() => setKeyMismatchWarning(null));

  it("warn: a mismatch is logged and reported, never refused, never recorded", async () => {
    const prisma = getPrismaClient();
    await seedUser("warned", new Date("2024-01-01T00:00:00Z"), sealNow);
    useKey(KEY_B);
    vi.stubEnv("ENCRYPTION_KEY_CHECK", "warn");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(false);
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    errors.mockRestore();
    expect(logged).toContain("encryption.key_mismatch");
    expect(logged).toContain("ENCRYPTION_KEY_CHECK=warn");
    expect(isKeyMismatch()).toBe(false);
    expect(getKeyMismatchWarning()?.keyIds).toEqual(["v1"]);
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);

    // Requests are served, through apiHandler and outside it.
    await seedAdmin();
    const { GET: keyBackupGet } =
      await import("@/app/api/admin/encryption/key-backup/route");
    const served = await asRoute(keyBackupGet)(
      new NextRequest("http://localhost/api/admin/encryption/key-backup"),
    );
    expect(served.status).toBe(200);
    const { POST: mcp } = await import("@/app/mcp/route");
    const mcpRes = await mcp(
      new Request("http://localhost/mcp", { method: "POST", body: "{}" }),
    );
    expect(mcpRes.status).not.toBe(503);

    const { GET: healthGet } = await import("@/app/api/health/route");
    const healthBody = await (
      await asRoute(healthGet)(new NextRequest("http://localhost/api/health"))
    ).json();
    expect(healthBody.warning).toBe("encryption_key_mismatch");
    expect(healthBody.reason).toBeUndefined();
  });

  it("warn: nothing is recorded while any key id is inconclusive", async () => {
    const prisma = getPrismaClient();
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_A, v2: KEY_B }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v1");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    await prisma.user.create({
      data: {
        username: "lone",
        email: "lone@example.test",
        codexAccessTokenEncrypted: encrypt("the only value"),
      },
    });
    // v1 now holds a different key: its one value does not open. v2 has no
    // data, which on its own would be recorded.
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_B, v2: KEY_A }));
    _resetCryptoCacheForTests();
    vi.stubEnv("ENCRYPTION_KEY_CHECK", "warn");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(false);
    warn.mockRestore();
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);

    // Enforce records the proven id, as before.
    vi.stubEnv("ENCRYPTION_KEY_CHECK", "enforce");
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runBootKeyCheck(prisma)).toBe(false);
    warn2.mockRestore();
    const ids = (await prisma.encryptionKeyCanary.findMany()).map(
      (r) => r.keyId,
    );
    expect(ids).toEqual(["v2"]);
  });

  it("enforce, set explicitly or by any other value, refuses as before", async () => {
    const prisma = getPrismaClient();
    await seedUser("enforced", new Date("2024-01-01T00:00:00Z"), sealNow);
    useKey(KEY_B);
    for (const value of ["enforce", "", "off"]) {
      vi.stubEnv("ENCRYPTION_KEY_CHECK", value);
      setKeyMismatchState(null);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await runBootKeyCheck(prisma)).toBe(true);
      errors.mockRestore();
      expect(isKeyMismatch()).toBe(true);
      expect(getKeyMismatchWarning()).toBeNull();
    }
    expect(await prisma.encryptionKeyCanary.count()).toBe(0);
  });
});

describe("retiring a key id after rotation (real Postgres)", () => {
  it("removes the canary of a key id only once no ciphertext remains under it", async () => {
    const prisma = getPrismaClient();
    vi.stubEnv("ENCRYPTION_KEYS", JSON.stringify({ v1: KEY_A, v2: KEY_B }));
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v1");
    vi.stubEnv("ENCRYPTION_KEY", "");
    _resetCryptoCacheForTests();
    const userId = await seedUser(
      "rotating",
      new Date("2024-01-01T00:00:00Z"),
      sealNow,
    );
    expect(await runBootKeyCheck(prisma)).toBe(false);
    expect(await prisma.encryptionKeyCanary.count()).toBe(2);

    // Rotation to v2 has not finished: one Bytes value still under v1.
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "v2");
    _resetCryptoCacheForTests();
    await prisma.user.update({
      where: { id: userId },
      data: {
        codexAccessTokenEncrypted: encrypt("rotated"),
        codexRefreshTokenEncrypted: encrypt("rotated"),
      },
    });
    await prisma.userHealthProfile.update({
      where: { userId },
      data: { aboutMeEncrypted: encryptToBytes("rotated") },
    });
    const partial = await retireCanariesWithoutData(prisma);
    expect(partial.removed).toEqual([]);
    expect(partial.remaining).toEqual({
      v1: ["UserHealthProfile.conditionsEncrypted"],
    });
    expect(await prisma.encryptionKeyCanary.count()).toBe(2);

    await prisma.userHealthProfile.update({
      where: { userId },
      data: { conditionsEncrypted: encryptToBytes("rotated") },
    });
    const done = await retireCanariesWithoutData(prisma);
    expect(done.removed).toEqual(["v1"]);
    const left = await prisma.encryptionKeyCanary.findMany();
    expect(left.map((r) => r.keyId)).toEqual(["v2"]);
  });
});

describe("routes outside apiHandler refuse while the key does not match", () => {
  beforeEach(() => {
    setKeyMismatchState({ keyIds: ["v1"], detectedAt: "2026-10-03T00:00:00Z" });
  });

  it("/mcp answers 503 encryption.key_mismatch before auth", async () => {
    const { POST } = await import("@/app/mcp/route");
    const res = await POST(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer hlk_whatever",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).meta).toEqual({
      errorCode: "encryption.key_mismatch",
    });
  });

  it("the MCP OAuth endpoints refuse in their RFC shape", async () => {
    const { POST: token } = await import("@/app/api/mcp/oauth/token/route");
    const { POST: register } =
      await import("@/app/api/mcp/oauth/register/route");
    const { GET: authorizeGet, POST: authorizePost } =
      await import("@/app/api/mcp/oauth/authorize/route");
    const responses = [
      await token(
        new NextRequest("http://localhost/api/mcp/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "grant_type=authorization_code&code=x",
        }),
      ),
      await register(
        post("/api/mcp/oauth/register", {
          redirect_uris: ["https://client.example/cb"],
        }),
      ),
      await authorizeGet(
        new NextRequest(
          "http://localhost/api/mcp/oauth/authorize?response_type=code",
        ),
      ),
      await authorizePost(
        new NextRequest("http://localhost/api/mcp/oauth/authorize", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "decision=approve",
        }),
      ),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe("temporarily_unavailable");
      expect(body.error_description).toContain("encryption key");
    }
  });
});

describe("encryption key backup step (real Postgres)", () => {
  it("is due, refuses a stale confirmation, records the right one, and is due again after a re-key", async () => {
    const prisma = getPrismaClient();
    const adminId = await seedAdmin();
    const { GET } = await import("@/app/api/admin/encryption/key-backup/route");
    const { POST: confirm } =
      await import("@/app/api/admin/encryption/key-backup/confirm/route");
    const status = async () =>
      (
        await (
          await asRoute(GET)(
            new NextRequest("http://localhost/api/admin/encryption/key-backup"),
          )
        ).json()
      ).data;

    const first = await status();
    expect(first.due).toBe(true);
    expect(first.activeKeyId).toBe("v1");
    expect(first.fingerprint).toBe(getKeyFingerprint("v1"));
    expect(first.platformHint).toBe("compose");
    expect(JSON.stringify(first)).not.toContain(KEY_A);

    const stale = await confirm(
      post("/api/admin/encryption/key-backup/confirm", {
        keyId: "v1",
        fingerprint: "000000000000",
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).meta.errorCode).toBe(
      "encryption.keyBackup.stale",
    );
    expect(
      (await prisma.appSettings.findUnique({ where: { id: "singleton" } }))
        ?.encryptionKeyBackupConfirmedAt ?? null,
    ).toBeNull();

    const ok = await confirm(
      post("/api/admin/encryption/key-backup/confirm", {
        keyId: "v1",
        fingerprint: first.fingerprint,
      }),
    );
    expect(ok.status).toBe(200);
    const confirmed = (await ok.json()).data;
    expect(confirmed.due).toBe(false);
    expect(confirmed.confirmedBy).toEqual({
      id: adminId,
      email: "key-admin@example.test",
    });
    const audit = await prisma.auditLog.findFirst({
      where: { action: "encryption.keyBackup.confirmed" },
    });
    expect(audit).not.toBeNull();

    vi.stubEnv("HEALTHLOG_PLATFORM", "truenas");
    useKey(KEY_B);
    const after = await status();
    expect(after.due).toBe(true);
    expect(after.confirmedKeyId).toBe("v1");
    expect(after.platformHint).toBe("truenas");
  });

  it("checks a copy without storing it, and limits the checks", async () => {
    const prisma = getPrismaClient();
    await seedAdmin();
    const { POST: verify } =
      await import("@/app/api/admin/encryption/key-backup/verify/route");
    const check = (encryptionKey: string) =>
      verify(
        post("/api/admin/encryption/key-backup/verify", { encryptionKey }),
      );

    const good = await check(`${KEY_A}\n`);
    expect(good.status).toBe(200);
    expect((await good.json()).data).toEqual({ matches: true, keyId: "v1" });

    const bad = await check(KEY_B);
    expect((await bad.json()).data.matches).toBe(false);

    const invalid = await verify(
      post("/api/admin/encryption/key-backup/verify", { encryptionKey: "" }),
    );
    expect(invalid.status).toBe(422);
    expect(JSON.stringify(await invalid.json())).not.toContain("issues");

    // Nothing of the candidate is stored anywhere a row could hold it.
    const audits = await prisma.auditLog.findMany();
    expect(JSON.stringify(audits)).not.toContain(KEY_A);
    expect(JSON.stringify(audits)).not.toContain(KEY_B);
    expect(
      (await prisma.appSettings.findUnique({ where: { id: "singleton" } }))
        ?.encryptionKeyBackupConfirmedAt ?? null,
    ).toBeNull();

    await check(KEY_B);
    await check(KEY_B);
    const limited = await check(KEY_A);
    expect(limited.status).toBe(429);
  });
});
