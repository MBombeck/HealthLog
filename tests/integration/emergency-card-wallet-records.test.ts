/**
 * The records behind an Apple Wallet pass of the emergency card, against real
 * Postgres (v1.50): the pass's own WALLET link next to the printed card's
 * CARD link, the sealed raw token, the name item, and the key rotation.
 *
 *   - one live link per record and purpose, so a pass and a printed card
 *     coexist, and revoking one leaves the other;
 *   - the CHECK holds the sealed token to WALLET links only;
 *   - `/e/<wallet token>` serves the frozen items and audits the purpose;
 *   - a credential remediation ends both;
 *   - the printed card's PDF never accepts the pass's token;
 *   - the sealed token and a device's push token rotate under a new key and
 *     open once the old one is gone;
 *   - the name is read from the record, only when ticked.
 */
import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-emergency-wallet-integration-32-bytes-min-123456789";
process.env.ENCRYPTION_KEYS = JSON.stringify({
  v1: "1".repeat(64),
  v2: "2".repeat(64),
});
process.env.ENCRYPTION_ACTIVE_KEY_ID = "v1";
delete process.env.ENCRYPTION_KEY;

import { credentialRevocations } from "@/lib/auth/credential-revocations";
import { _resetCryptoCacheForTests, encrypt, extractKeyId } from "@/lib/crypto";
import { ENCRYPTED_COLUMNS } from "@/lib/crypto/encrypted-columns";
import {
  rotateColumn,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { loadEmergencyCard } from "@/lib/emergency-card/card-data";
import { readEmergencyCardByToken } from "@/lib/emergency-card/serve";
import { mintCardToken } from "@/lib/emergency-card/token";
import { openWalletLinkToken } from "@/lib/emergency-card/wallet-pass/link-token";
import { createWalletPass } from "@/lib/emergency-card/wallet-pass/store";
import { isP2002 } from "@/lib/prisma-errors";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const db = () => getPrismaClient();
let counter = 0;

function activate(keyId: string) {
  process.env.ENCRYPTION_ACTIVE_KEY_ID = keyId;
  _resetCryptoCacheForTests();
}

async function makeUser(
  over: { fullName?: string; displayName?: string } = {},
) {
  const suffix = `${counter++}`;
  return db().user.create({
    data: {
      username: `wallet-${suffix}`,
      email: `wallet-${suffix}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      fullName: over.fullName ?? null,
      displayName: over.displayName ?? null,
    },
  });
}

async function signIn(userId: string) {
  cookieJar.clear();
  headerJar.clear();
  const session = await db().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function call(
  path: "link" | "wallet",
  method: "POST" | "DELETE",
  body?: unknown,
) {
  const route =
    path === "link"
      ? await import("@/app/api/emergency-card/link/route")
      : await import("@/app/api/emergency-card/wallet/route");
  const handler = (route as Record<string, unknown>)[method] as Handler;
  return handler(
    new NextRequest(`http://localhost/api/emergency-card/${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({}) },
  );
}

const anon = () =>
  new Request("http://localhost/e", { headers: new Headers() });

async function mintPass(userId: string) {
  const token = mintCardToken();
  const ids = await db().$transaction((tx) =>
    createWalletPass(tx, {
      userId,
      createdById: userId,
      token,
      serialNumber: randomUUID(),
      fields: ["NAME", "BLOOD_TYPE"],
      expiresAt: null,
      signer: "RELAY",
      passTypeIdentifier: "pass.dev.healthlog.emergency",
      teamIdentifier: "ABCDE12345",
      webServiceOrigin: "https://health.example.org",
      contentHash: "0".repeat(64),
      contentChangedAt: new Date(),
      consentTextVersion: "1",
    }),
  );
  return { token, ...ids };
}

beforeEach(async () => {
  process.env.ENCRYPTION_KEYS = JSON.stringify({
    v1: "1".repeat(64),
    v2: "2".repeat(64),
  });
  activate("v1");
  await truncateAllTables(db());
});

describe("wallet pass records", () => {
  it("keeps the pass's link apart from the printed card's", async () => {
    const owner = await makeUser({ fullName: "Alex Example" });
    await signIn(owner.id);
    const card = (
      await (await call("link", "POST", { fields: ["BLOOD_TYPE"] })).json()
    ).data.url as string;
    const pass = await mintPass(owner.id);

    // A second live pass is refused by the per-purpose index.
    await expect(mintPass(owner.id)).rejects.toSatisfy(isP2002);

    // The sealed token opens to the raw token; the hash is the usual one.
    const link = await db().emergencyCardLink.findUniqueOrThrow({
      where: { id: pass.linkId },
    });
    expect(link.purpose).toBe("WALLET");
    expect(link.tokenEncrypted).not.toContain(pass.token.raw);
    expect(openWalletLinkToken(link.tokenEncrypted!)).toBe(pass.token.raw);

    // The pass's QR link serves its frozen items and says what it is.
    const read = await readEmergencyCardByToken(anon(), pass.token.raw);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.view.fields).toEqual(["NAME", "BLOOD_TYPE"]);
      expect(read.view.name).toBe("Alex Example");
    }
    const audit = await db().auditLog.findFirstOrThrow({
      where: { userId: owner.id, action: "emergency-card.link.access" },
    });
    const details =
      typeof audit.details === "string"
        ? JSON.parse(audit.details)
        : audit.details;
    expect(details).toMatchObject({ purpose: "WALLET" });

    // Revoking the printed card's link leaves the pass's link alive.
    expect((await call("link", "DELETE")).status).toBe(200);
    expect((await readEmergencyCardByToken(anon(), pass.token.raw)).ok).toBe(
      true,
    );
    expect(
      (await readEmergencyCardByToken(anon(), card.split("/e/")[1])).ok,
    ).toBe(false);

    // The printed card's PDF does not take the pass's token.
    const pdf = await call("wallet", "POST", { token: pass.token.raw });
    expect(pdf.status).toBe(422);

    // A new printed-card link is allowed while the pass lives.
    expect(
      (await call("link", "POST", { fields: ["BLOOD_TYPE"] })).status,
    ).toBe(201);
  });

  it("holds the sealed token to WALLET links", async () => {
    const owner = await makeUser();
    const base = {
      userId: owner.id,
      createdById: owner.id,
      fields: ["BLOOD_TYPE" as const],
    };
    const t1 = mintCardToken();
    await expect(
      db().emergencyCardLink.create({
        data: {
          ...base,
          tokenHash: t1.hash,
          tokenPrefix: t1.prefix,
          purpose: "CARD",
          tokenEncrypted: encrypt(t1.raw),
        },
      }),
    ).rejects.toThrow(/wallet_token_check|check constraint/i);
    const t2 = mintCardToken();
    await expect(
      db().emergencyCardLink.create({
        data: {
          ...base,
          tokenHash: t2.hash,
          tokenPrefix: t2.prefix,
          purpose: "WALLET",
        },
      }),
    ).rejects.toThrow(/wallet_token_check|check constraint/i);
  });

  it("ends the pass's link and the card's with a credential remediation", async () => {
    const owner = await makeUser();
    const pass = await mintPass(owner.id);
    await db().$transaction(credentialRevocations(db(), owner.id));
    expect((await readEmergencyCardByToken(anon(), pass.token.raw)).ok).toBe(
      false,
    );
  });

  it("re-seals the link token and the push token under a new key", async () => {
    const owner = await makeUser();
    const pass = await mintPass(owner.id);
    await db().walletPassRegistration.create({
      data: {
        walletPassId: pass.walletPassId,
        deviceLibraryIdHash: "h".repeat(64),
        pushTokenEncrypted: encrypt("ab".repeat(32)),
      },
    });

    activate("v2");
    const client = {
      emergencyCardLink: db().emergencyCardLink,
      walletPassRegistration: db().walletPassRegistration,
    } as unknown as CorpusClient;
    for (const [model, field] of [
      ["EmergencyCardLink", "tokenEncrypted"],
      ["WalletPassRegistration", "pushTokenEncrypted"],
    ] as const) {
      const col = ENCRYPTED_COLUMNS.find(
        (c) => c.model === model && c.field === field,
      );
      expect(col, `${model}.${field}`).toBeDefined();
      const result = await rotateColumn(client, col!);
      expect(result).toMatchObject({ rotated: 1, errors: 0 });
    }

    process.env.ENCRYPTION_KEYS = JSON.stringify({ v2: "2".repeat(64) });
    _resetCryptoCacheForTests();
    const link = await db().emergencyCardLink.findUniqueOrThrow({
      where: { id: pass.linkId },
    });
    expect(extractKeyId(link.tokenEncrypted!)).toBe("v2");
    expect(openWalletLinkToken(link.tokenEncrypted!)).toBe(pass.token.raw);
  });

  it("goes with the link, and the link goes with the record", async () => {
    const owner = await makeUser();
    const pass = await mintPass(owner.id);
    await db().emergencyCardLink.delete({ where: { id: pass.linkId } });
    expect(await db().walletPass.count()).toBe(0);
    const again = await mintPass(owner.id);
    await db().user.delete({ where: { id: owner.id } });
    expect(
      await db().walletPass.count({ where: { id: again.walletPassId } }),
    ).toBe(0);
  });
});

describe("the name item", () => {
  it("reads the full name, else the display name, only when ticked", async () => {
    const full = await makeUser({
      fullName: "Alex Example",
      displayName: "Al",
    });
    const display = await makeUser({ displayName: "  Sam  " });
    const none = await makeUser();
    const day = "2026-11-24";
    expect((await loadEmergencyCard(full.id, day)).name).toBe("Alex Example");
    expect((await loadEmergencyCard(display.id, day)).name).toBe("Sam");
    expect((await loadEmergencyCard(none.id, day)).name).toBeNull();
    expect(
      (await loadEmergencyCard(full.id, day, ["BLOOD_TYPE"])).name,
    ).toBeNull();
  });
});
