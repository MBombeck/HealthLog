/**
 * The emergency card's Apple Wallet pass against real Postgres, driven
 * through the shipped routes (v1.50):
 *
 * - made on the web only (cookie, fresh proof, the relay notice accepted),
 *   one live pass per record, its own link with the frozen items;
 * - downloaded by the browser and by the app's full-access token as a signed
 *   `.pkpass`, by the operator's own certificate or the project's signing
 *   service, which sees the manifest and nothing else;
 * - withdrawn and expired passes served in their own versions, the printed
 *   card's link and the pass's link independent of each other;
 * - another account reads nothing of it; a signer that cannot sign answers
 *   503 with `Retry-After`; `/api/auth/me` publishes the resolved state.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { unzipSync } from "fflate";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { FakeRelay, RELAY_PUBLIC_KEY, RELAY_URL } from "./push-relay-fake";

const relay = vi.hoisted(() => ({
  current: null as null | {
    handle: (url: string | URL, init?: RequestInit) => Promise<Response>;
  },
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (url: string | URL, init?: RequestInit) => {
      if (!relay.current) throw new Error("no fake relay");
      return relay.current.handle(url, init);
    },
  };
});

import {
  RELAY_SPEC_DIR,
  relayReference,
} from "@/lib/emergency-card/wallet-pass/__tests__/fixture";
import { walletAuthToken } from "@/lib/emergency-card/wallet-pass/link-token";
import { readEmergencyCardByToken } from "@/lib/emergency-card/serve";
import { WALLET_RELAY_CONSENT_TEXT_VERSION } from "@/lib/push-relay/config";
import { checkRateLimit } from "@/lib/rate-limit";
import { writeEmergencyProfile } from "@/lib/profile/emergency-profile";
import { sessionCookieName } from "@/lib/auth/session-cookie";

import { callRoute, type RouteAuth } from "../kit/call-route";
import {
  makeAdmin,
  makeSession,
  makeToken,
  makeUser,
  type BearerFixture,
  type SessionFixture,
} from "../kit/factories";
import { createManagedProfile } from "@/lib/managed-profiles/create";

import { cookieJar, headerJar } from "./mock-next-headers";
import { enableRelay } from "./push-relay-kit";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const HTTPS = { "x-forwarded-proto": "https", host: "health.example.test" };
const ROUTE = "/api/emergency-card/wallet/apple";
const PASS_ROUTE = "/api/emergency-card/wallet/apple/pass";

// The relay's public test chain (healthlog-push spec/vectors/wallet-v1.json):
// an operator certificate whose keys come from public seeds.
const vectors = JSON.parse(
  readFileSync(join(RELAY_SPEC_DIR, "wallet-v1.json"), "utf8"),
) as {
  seeds: { pass: string };
  certificates: { pass: string; intermediate: string };
  passTypeIdentifier: string;
  teamIdentifier: string;
};

async function localEnv() {
  const { deriveRSAKey } = await relayReference();
  const key = deriveRSAKey(Buffer.from(vectors.seeds.pass, "hex")).privateKey;
  const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64");
  vi.stubEnv("WALLET_APPLE_PASS_TYPE_ID", vectors.passTypeIdentifier);
  vi.stubEnv("WALLET_APPLE_TEAM_ID", vectors.teamIdentifier);
  vi.stubEnv(
    "WALLET_APPLE_CERT_B64",
    b64(Buffer.from(vectors.certificates.pass, "base64url")),
  );
  vi.stubEnv(
    "WALLET_APPLE_KEY_B64",
    b64(key.export({ type: "pkcs8", format: "pem" }) as string),
  );
  vi.stubEnv(
    "WALLET_APPLE_WWDR_B64",
    b64(Buffer.from(vectors.certificates.intermediate, "base64url")),
  );
}

const routes = async () => ({
  status: await import("@/app/api/emergency-card/wallet/apple/route"),
  pass: await import("@/app/api/emergency-card/wallet/apple/pass/route"),
  link: await import("@/app/api/emergency-card/link/route"),
  hint: await import("@/app/api/emergency-card/wallet/apple/relay-hint/route"),
  decision: await import("@/app/api/admin/push-relay/decision/route"),
  me: await import("@/app/api/auth/me/route"),
  digest: await import("@/app/api/daily/digest/route"),
  dismiss: await import("@/app/api/daily/digest/dismiss/route"),
});

/** The kinds the start page asks, as the digest serves them. */
async function askKinds(
  auth: RouteAuth,
  headers: Record<string, string> = HTTPS,
) {
  const { digest } = await routes();
  const res = await callRoute<{
    asks: Array<{ kind: string; actions: Array<{ intent: string }> }>;
  }>(digest.GET, { method: "GET", route: "/api/daily/digest", auth, headers });
  expect(res.status).toBe(200);
  return res.data.asks;
}

const CREATE = {
  fields: ["NAME", "BLOOD_TYPE", "ALLERGIES", "CONTACTS"],
  consentTextVersion: WALLET_RELAY_CONSENT_TEXT_VERSION,
};

async function create(
  auth: RouteAuth,
  body: unknown = CREATE,
  headers: Record<string, string> = HTTPS,
) {
  const { status } = await routes();
  return callRoute<{
    pass: { serialNumber: string; state: string; fields: string[] };
    downloadPath: string;
  }>(status.POST, { method: "POST", route: ROUTE, auth, body, headers });
}

async function walletStatus(auth: RouteAuth, headers = HTTPS) {
  const { status } = await routes();
  return callRoute<{
    apple: {
      available: boolean;
      reason: string;
      state: string;
      relayAction: string | null;
      relayHintDismissed: boolean;
      signer: string | null;
      canCreate: boolean;
      pass: null | { state: string; serialNumber: string };
    };
  }>(status.GET, { method: "GET", route: ROUTE, auth, headers });
}

async function revoke(auth: RouteAuth) {
  const { status } = await routes();
  return callRoute(status.DELETE, { method: "DELETE", route: ROUTE, auth });
}

/** The download, read as bytes (the kit reads bodies as text). */
async function download(auth: SessionFixture | BearerFixture) {
  const { pass } = await routes();
  const headers = new Headers(HTTPS);
  cookieJar.clear();
  headerJar.clear();
  if (auth.kind === "bearer") {
    headers.set("authorization", `Bearer ${auth.token}`);
  } else {
    cookieJar.set(sessionCookieName(), auth.cookie);
  }
  headers.forEach((value, name) => headerJar.set(name, value));
  try {
    const response = await pass.GET(
      new NextRequest(`https://health.example.test${PASS_ROUTE}`, { headers }),
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { response, bytes };
  } finally {
    cookieJar.clear();
    headerJar.clear();
  }
}

function passJson(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  return {
    files,
    json: JSON.parse(new TextDecoder().decode(files["pass.json"])) as {
      serialNumber: string;
      authenticationToken: string;
      voided: boolean;
      passTypeIdentifier: string;
      barcodes?: Array<{ message: string }>;
      posterGeneric: { primaryFields: Array<{ value: string }> };
    },
  };
}

async function seedCard(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { fullName: "Alex Example", timezone: "Europe/Berlin", locale: "en" },
  });
  await writeEmergencyProfile(userId, {
    bloodType: "O_NEG",
    contacts: "Sam Example +49 170 0000000",
    note: "never on the pass",
  });
  await prisma.allergy.create({
    data: { userId, substance: "Penicillin", severity: "SEVERE" },
  });
}

beforeEach(async () => {
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  await truncateAllTables(prisma);
  relay.current = new FakeRelay();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("with the operator's own Pass Type ID", () => {
  beforeEach(localEnv);

  it("offers the card for Wallet on the start page once, until Later or a pass", async () => {
    const owner = await makeUser();
    const session = await makeSession(owner);
    // A card with nothing but the name is not offered.
    expect((await askKinds(session)).map((a) => a.kind)).not.toContain(
      "emergency_wallet",
    );
    await seedCard(owner.id);
    // Not over plain http: no pass can be made there.
    expect(
      (await askKinds(session, { host: "health.example.test" })).map(
        (a) => a.kind,
      ),
    ).not.toContain("emergency_wallet");
    const asks = await askKinds(session);
    const offer = asks.find((a) => a.kind === "emergency_wallet");
    expect(offer?.actions.map((a) => a.intent)).toEqual([
      "emergency_wallet.add",
      "ask.later:emergency_wallet:offer",
    ]);

    // Later puts it away for good, through the dismiss ledger.
    const { dismiss } = await routes();
    const later = await callRoute(dismiss.POST, {
      method: "POST",
      route: "/api/daily/digest/dismiss",
      auth: session,
      body: { itemKey: "emergency_wallet:offer" },
    });
    expect(later.status).toBeLessThan(300);
    expect((await askKinds(session)).map((a) => a.kind)).not.toContain(
      "emergency_wallet",
    );

    // Making a pass writes the same key, so a second person who never said
    // Later loses the offer too, and keeps it lost once the pass is gone.
    const other = await makeUser();
    await seedCard(other.id);
    const otherSession = await makeSession(other);
    expect((await askKinds(otherSession)).map((a) => a.kind)).toContain(
      "emergency_wallet",
    );
    expect((await create(otherSession)).status).toBe(201);
    expect(
      await prisma.dismissedPriorityItem.count({
        where: { userId: other.id, itemKey: "emergency_wallet:offer" },
      }),
    ).toBe(1);
    expect((await revoke(otherSession)).status).toBe(200);
    await prisma.walletPass.deleteMany({ where: { userId: other.id } });
    expect((await askKinds(otherSession)).map((a) => a.kind)).not.toContain(
      "emergency_wallet",
    );
  });

  it("makes one pass, serves it signed, and withdraws it", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);

    const status = await walletStatus(session);
    expect(status.status).toBe(200);
    expect(status.data.apple).toMatchObject({
      available: true,
      reason: "ok",
      signer: "local",
      canCreate: true,
      pass: null,
    });

    const made = await create(session);
    expect(made.status).toBe(201);
    expect(made.data.downloadPath).toBe(PASS_ROUTE);
    expect(made.data.pass).toMatchObject({
      state: "live",
      fields: ["NAME", "BLOOD_TYPE", "ALLERGIES", "CONTACTS"],
    });
    // No credential in the answer.
    expect(JSON.stringify(made.body)).not.toMatch(/hlm_|\/e\//);

    expect((await create(session)).meta?.errorCode).toBe(
      "emergency-card.wallet.exists",
    );

    const { response, bytes } = await download(session);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/vnd.apple.pkpass",
    );
    expect(response.headers.get("hl-wallet-state")).toBe("live");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("last-modified")).toBeTruthy();
    const { files, json } = passJson(bytes);
    expect(files["manifest.json"]).toBeDefined();
    expect(files.signature?.[0]).toBe(0x30);
    expect(json.passTypeIdentifier).toBe(vectors.passTypeIdentifier);
    expect(json.serialNumber).toBe(made.data.pass.serialNumber);
    expect(json.posterGeneric.primaryFields[0].value).toBe("Alex Example");
    const everything = Object.values(files)
      .map((f) => new TextDecoder().decode(f))
      .join("\n");
    expect(everything).not.toContain("never on the pass");

    // The QR code is the pass's own link, frozen to its items, and its
    // authentication token is derived from it.
    const raw = json.barcodes?.[0].message.split("/e/")[1] as string;
    expect(raw).toMatch(/^hlm_[0-9a-f]{48}$/);
    expect(json.authenticationToken).toBe(
      walletAuthToken(raw, json.serialNumber),
    );
    const read = await readEmergencyCardByToken(
      new Request("https://health.example.test/e"),
      raw,
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.view.fields).toEqual(made.data.pass.fields);
    const opened = await prisma.auditLog.findFirst({
      where: {
        userId: owner.id,
        action: { startsWith: "emergency-card.link" },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(opened?.details)).toContain("WALLET");
    const row = await prisma.walletPass.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(row.lastFetchedAt).not.toBeNull();
    expect(row.signer).toBe("LOCAL");

    expect((await revoke(session)).status).toBe(200);
    expect(
      (
        await readEmergencyCardByToken(
          new Request("https://health.example.test/e"),
          raw,
        )
      ).ok,
    ).toBe(false);
    expect((await walletStatus(session)).data.apple.pass?.state).toBe("voided");
    const voided = await download(session);
    expect(voided.response.status).toBe(200);
    expect(voided.response.headers.get("hl-wallet-state")).toBe("voided");
    const v = passJson(voided.bytes);
    expect(v.json.voided).toBe(true);
    expect(v.json.barcodes).toBeUndefined();
    const voidedText = Object.values(v.files)
      .map((f) => new TextDecoder().decode(f))
      .join("\n");
    for (const secret of ["Alex Example", "Penicillin", "hlm_", "O neg"]) {
      expect(voidedText).not.toContain(secret);
    }
    expect((await revoke(session)).meta?.errorCode).toBe(
      "emergency-card.wallet.none",
    );
    // A withdrawn pass leaves room for a new one.
    expect((await create(session)).status).toBe(201);
    const audits = await prisma.auditLog.findMany({
      where: {
        userId: owner.id,
        action: { startsWith: "emergency-card.wallet" },
      },
      select: { action: true },
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      "emergency-card.wallet.create",
      "emergency-card.wallet.create",
      "emergency-card.wallet.revoke",
    ]);
  });

  it("is made on the web only, with a fresh proof; the app downloads it", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const token = await makeToken(owner);
    const narrow = await makeToken(owner, { permissions: ["fhir:read"] });

    const byToken = await create(token);
    expect(byToken.status).toBe(403);
    expect(byToken.meta?.errorCode).toBe("emergency-card.cookie_only");
    expect((await walletStatus(token)).data.apple.canCreate).toBe(false);

    const stale = await makeSession(owner);
    await prisma.session.update({
      where: { id: stale.sessionId },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) },
    });
    const refused = await create(stale);
    expect(refused.status).toBe(401);
    expect(refused.meta?.errorCode).toBe("auth.reproof.required");

    const session = await makeSession(owner);
    expect((await create(session)).status).toBe(201);

    const app = await download(token);
    expect(app.response.status).toBe(200);
    expect(app.response.headers.get("content-type")).toBe(
      "application/vnd.apple.pkpass",
    );
    const scoped = await download(narrow);
    expect(scoped.response.status).toBe(403);
    expect((await revoke(token)).meta?.errorCode).toBe(
      "emergency-card.cookie_only",
    );
  });

  it("shows another account nothing of it", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    await seedCard(owner.id);
    const ownerSession = await makeSession(owner);
    expect((await create(ownerSession)).status).toBe(201);

    const otherSession = await makeSession(other);
    const otherToken = await makeToken(other);
    const theirs = await download(otherSession);
    expect(theirs.response.status).toBe(404);
    expect(
      JSON.parse(new TextDecoder().decode(theirs.bytes)).meta.errorCode,
    ).toBe("emergency-card.wallet.none");
    expect((await download(otherToken)).response.status).toBe(404);
    expect((await walletStatus(otherSession)).data.apple.pass).toBeNull();
    expect((await revoke(otherSession)).status).toBe(404);
    expect((await walletStatus(ownerSession)).data.apple.pass?.state).toBe(
      "live",
    );
  });

  it("keeps the printed card's link and the pass's link apart", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    const { link } = await routes();
    const card = await callRoute(link.POST, {
      method: "POST",
      route: "/api/emergency-card/link",
      auth: session,
      body: { fields: ["BLOOD_TYPE"] },
    });
    expect(card.status).toBe(201);
    expect((await create(session)).status).toBe(201);

    const linkOff = await callRoute(link.DELETE, {
      method: "DELETE",
      route: "/api/emergency-card/link",
      auth: session,
    });
    expect(linkOff.status).toBe(200);
    expect((await walletStatus(session)).data.apple.pass?.state).toBe("live");

    const card2 = await callRoute(link.POST, {
      method: "POST",
      route: "/api/emergency-card/link",
      auth: session,
      body: { fields: ["BLOOD_TYPE"] },
    });
    expect(card2.status).toBe(201);
    expect((await revoke(session)).status).toBe(200);
    const status = await callRoute<{ link: unknown }>(link.GET, {
      method: "GET",
      route: "/api/emergency-card/link",
      auth: session,
    });
    expect(status.data.link).not.toBeNull();
  });

  it("serves an expired pass as expired", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    expect(
      (await create(session, { ...CREATE, expiresInDays: 30 })).status,
    ).toBe(201);
    await prisma.emergencyCardLink.updateMany({
      where: { userId: owner.id, purpose: "WALLET" },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect((await walletStatus(session)).data.apple.pass?.state).toBe(
      "expired",
    );
    const { response } = await download(session);
    expect(response.status).toBe(200);
    expect(response.headers.get("hl-wallet-state")).toBe("expired");
  });

  it("replaces an expired pass, and the old serial is withdrawn for good", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    const first = await create(session, { ...CREATE, expiresInDays: 30 });
    expect(first.status).toBe(201);
    await prisma.emergencyCardLink.updateMany({
      where: { userId: owner.id, purpose: "WALLET" },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect((await walletStatus(session)).data.apple.pass?.state).toBe(
      "expired",
    );

    // The card offers "make a new one" for an expired pass: it works.
    const second = await create(session);
    expect(second.status).toBe(201);
    expect(second.data.pass.state).toBe("live");
    expect(second.data.pass.serialNumber).not.toBe(
      first.data.pass.serialNumber,
    );
    expect((await walletStatus(session)).data.apple.pass).toMatchObject({
      state: "live",
      serialNumber: second.data.pass.serialNumber,
    });

    // The old serial is stamped, its link ended, and it builds empty.
    const old = await prisma.walletPass.findUniqueOrThrow({
      where: { serialNumber: first.data.pass.serialNumber },
      select: { id: true, voidedAt: true, voidReason: true, linkId: true },
    });
    expect(old.voidedAt).not.toBeNull();
    expect(old.voidReason).toBe("OWNER");
    const oldLink = await prisma.emergencyCardLink.findUniqueOrThrow({
      where: { id: old.linkId },
      select: { revokedAt: true },
    });
    expect(oldLink.revokedAt).not.toBeNull();
    const { latestWalletPassById, syncWalletPassContent } =
      await import("@/lib/emergency-card/wallet-pass/service");
    const synced = await syncWalletPassContent(
      (await latestWalletPassById(old.id))!,
    );
    const oldJson = new TextDecoder().decode(synced.files.get("pass.json"));
    expect(JSON.parse(oldJson).voided).toBe(true);
    expect(oldJson).not.toContain("Alex Example");

    // A live pass still refuses a second one.
    expect((await create(session)).meta?.errorCode).toBe(
      "emergency-card.wallet.exists",
    );
  });

  it("answers 503 with Retry-After when the pass's signer is gone", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    expect((await create(session)).status).toBe(201);
    // The operator's set no longer holds together: nothing signs.
    vi.stubEnv("WALLET_APPLE_TEAM_ID", "OTHER12345");
    const { response, bytes } = await download(session);
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(JSON.parse(new TextDecoder().decode(bytes)).meta.errorCode).toBe(
      "emergency-card.wallet.signer_unavailable",
    );
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: false,
      reason: "signer_off",
    });
  });

  it("refuses without https, with the API switch off, and past the limits", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);

    const plain = await create(session, CREATE, {});
    expect(plain.status).toBe(409);
    expect(plain.meta).toMatchObject({
      errorCode: "emergency-card.wallet.unavailable",
      reason: "no_https_origin",
    });

    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", apiGlobal: false },
      update: { apiGlobal: false },
    });
    const off = await create(session);
    expect(off.status).toBe(403);
    expect(off.meta?.errorCode).toBe("emergency-card.api_disabled");
    expect((await walletStatus(session)).data.apple.reason).toBe(
      "api_disabled",
    );
    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: { apiGlobal: true },
    });

    expect((await create(session)).status).toBe(201);
    const row = await prisma.walletPass.findFirstOrThrow({
      where: { userId: owner.id },
    });
    for (let i = 0; i < 30; i++) {
      await checkRateLimit(
        `emergency-card:wallet-fetch:${row.id}`,
        30,
        60 * 60 * 1000,
      );
    }
    expect((await download(session)).response.status).toBe(429);

    for (let i = 0; i < 10; i++) {
      await checkRateLimit(
        `emergency-card:wallet-mint:${owner.id}`,
        10,
        60 * 60 * 1000,
      );
    }
    const many = await create(session);
    expect(many.status).toBe(429);
    expect(many.meta?.errorCode).toBe("emergency-card.rateLimited");
  });

  it("replays a retried creation under the same Idempotency-Key", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    const headers = { ...HTTPS, "idempotency-key": "wallet-create-1" };
    const first = await create(session, CREATE, headers);
    const second = await create(session, CREATE, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.data.pass.serialNumber).toBe(first.data.pass.serialNumber);
    expect(await prisma.walletPass.count({ where: { userId: owner.id } })).toBe(
      1,
    );
  });
});

describe("with the project's signing service", () => {
  async function relayWithWallet(sign = true) {
    relay.current = Object.assign(new FakeRelay(), {
      status: {
        wallet: {
          sign,
          notify: sign,
          passTypeIdentifier: "pass.dev.healthlog.vector",
          teamIdentifier: "VECTOR1234",
          certNotAfterDay: 24107,
        },
      },
    });
    await enableRelay();
    // The hourly status check, which is where the Wallet block arrives.
    const { loadRegistration, relayCall } =
      await import("@/lib/push-relay/registration");
    const row = await loadRegistration();
    if (!row) throw new Error("the relay is not on");
    await relayCall(row, "GET", "/v1/status");
    return relay.current as FakeRelay;
  }

  it("needs the current notice, and sends the manifest only", async () => {
    const fake = await relayWithWallet();
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: true,
      signer: "relay",
    });

    const wrong = await create(session, {
      ...CREATE,
      consentTextVersion: "2020-01-01",
    });
    expect(wrong.status).toBe(422);
    expect(wrong.meta?.errorCode).toBe("emergency-card.wallet.consent");

    expect((await create(session)).status).toBe(201);
    const { response, bytes } = await download(session);
    expect(response.status).toBe(200);
    const { files } = passJson(bytes);
    expect(fake.walletManifests).toHaveLength(1);
    const sent = fake.walletManifests[0];
    expect(Buffer.from(files["manifest.json"]).equals(sent)).toBe(true);
    const listed = JSON.parse(sent.toString("utf8")) as Record<string, string>;
    expect(Object.values(listed).every((h) => /^[0-9a-f]{40}$/.test(h))).toBe(
      true,
    );
    // Nothing but names and hashes left the server.
    expect(sent.toString("utf8")).not.toMatch(/Alex|Penicillin|hlm_/);
    const row = await prisma.walletPass.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(row.consentTextVersion).toBe(WALLET_RELAY_CONSENT_TEXT_VERSION);
    expect(sent.toString("utf8")).not.toContain(row.serialNumber);
  });

  it("answers 503 with Retry-After while the service is away", async () => {
    const fake = await relayWithWallet();
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    expect((await create(session)).status).toBe(201);
    fake.retryAfter = 120;
    fake.refuse.set("/v1/wallet/apple/sign", {
      status: 503,
      error: "wallet_unavailable",
    });
    const { response } = await download(session);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("120");
    // A Wallet outage does not touch the push path.
    const reg = await prisma.pushRelayRegistration.findFirstOrThrow();
    expect(reg.circuitOpenedAt).toBeNull();
    expect(reg.pausedUntil).toBeNull();
  });

  it("stays available while the relay paused pushes", async () => {
    await relayWithWallet();
    const owner = await makeUser();
    const session = await makeSession(owner);
    // A 429 with Retry-After on the push path: degraded and paused. The
    // signer still signs, so Wallet says what the signer does.
    await prisma.pushRelayRegistration.updateMany({
      data: {
        state: "degraded",
        stateReason: "rate_limited",
        pausedUntil: new Date(Date.now() + 10 * 60_000),
      },
    });
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: true,
      reason: "ok",
      signer: "relay",
    });
  });

  it("is not offered while the relay does not sign passes", async () => {
    await relayWithWallet(false);
    const owner = await makeUser();
    const session = await makeSession(owner);
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: false,
      reason: "relay_not_ready",
      signer: "relay",
    });
    const made = await create(session);
    expect(made.status).toBe(409);
    expect(made.meta?.reason).toBe("relay_not_ready");
  });

  it("publishes the same resolution on /api/auth/me", async () => {
    await relayWithWallet();
    const owner = await makeUser();
    await seedCard(owner.id);
    const session = await makeSession(owner);
    expect((await create(session)).status).toBe(201);
    const { me } = await routes();
    const res = await callRoute<{
      emergencyCard: { wallet: { apple: Record<string, unknown> } };
    }>(me.GET as never, {
      method: "GET",
      route: "/api/auth/me",
      auth: session,
      headers: HTTPS,
    });
    expect(res.status).toBe(200);
    const apple = res.data.emergencyCard.wallet.apple;
    expect(apple).toEqual((await walletStatus(session)).data.apple);
    expect(apple).toMatchObject({
      available: true,
      reason: "ok",
      signer: "relay",
      consentTextVersion: WALLET_RELAY_CONSENT_TEXT_VERSION,
      createPath: "/emergency-card#wallet",
      pass: { state: "live", downloadPath: PASS_ROUTE },
    });
  });
});

describe("without any signer", () => {
  it("says so and makes nothing", async () => {
    vi.stubEnv("PUSH_RELAY_MODE", "off");
    const owner = await makeUser();
    const session = await makeSession(owner);
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: false,
      reason: "signer_off",
      state: "not_configured",
      relayAction: null,
      signer: null,
    });
    const made = await create(session);
    expect(made.status).toBe(409);
    expect(made.meta?.reason).toBe("signer_off");
  });
});

describe("while the relay that would sign is off", () => {
  async function dismiss(auth: RouteAuth) {
    const { hint } = await routes();
    return callRoute<{ dismissed: boolean }>(hint.POST, {
      method: "POST",
      route: `${ROUTE}/relay-hint`,
      auth,
    });
  }

  it("lets an admin switch it on in place and then makes the pass", async () => {
    relay.current = Object.assign(new FakeRelay(), {
      status: {
        wallet: {
          sign: true,
          notify: true,
          passTypeIdentifier: "pass.dev.healthlog.vector",
          teamIdentifier: "VECTOR1234",
          certNotAfterDay: 24107,
        },
      },
    });
    const admin = await makeAdmin();
    await seedCard(admin.id);
    const session = await makeSession(admin);
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: false,
      state: "relay_off",
      relayAction: "enable",
      relayHintDismissed: false,
    });

    // The relay question's own answer, with its confirmations and audit.
    const { decision } = await routes();
    const yes = await callRoute<{ operatorDecision: string }>(decision.POST, {
      method: "POST",
      route: "/api/admin/push-relay/decision",
      auth: session,
      body: { enabled: true, acceptTerms: true, householdOnly: true },
    });
    expect(yes.status).toBe(200);
    expect(yes.data.operatorDecision).toBe("on");
    expect(
      await prisma.auditLog.count({
        where: { userId: admin.id, action: "admin.push_relay.enabled" },
      }),
    ).toBe(1);
    // Registered; signing arrives with the next status check.
    expect((await walletStatus(session)).data.apple.state).toBe(
      "relay_not_ready",
    );
    const { loadRegistration, relayCall } =
      await import("@/lib/push-relay/registration");
    const row = await loadRegistration();
    if (!row) throw new Error("the relay is not on");
    await relayCall(row, "GET", "/v1/status");
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: true,
      state: "available",
      relayAction: null,
    });
    expect((await create(session)).status).toBe(201);
  });

  it("tells anybody else to ask the admin, and remembers their no", async () => {
    const owner = await makeUser();
    const admin = await makeAdmin();
    const session = await makeSession(owner);
    const adminSession = await makeSession(admin);
    expect((await walletStatus(session)).data.apple).toMatchObject({
      state: "relay_off",
      relayAction: "ask_admin",
      relayHintDismissed: false,
    });
    expect((await create(session)).status).toBe(409);

    const first = await dismiss(session);
    expect(first.status).toBe(200);
    expect((await dismiss(session)).status).toBe(200);
    const { me } = await routes();
    const res = await callRoute<{
      emergencyCard: { wallet: { apple: Record<string, unknown> } };
    }>(me.GET as never, {
      method: "GET",
      route: "/api/auth/me",
      auth: session,
      headers: HTTPS,
    });
    // Still the same action, just no longer prompted.
    expect(res.data.emergencyCard.wallet.apple).toMatchObject({
      state: "relay_off",
      relayAction: "ask_admin",
      relayHintDismissed: true,
    });
    // Per person: the admin is still asked.
    expect((await walletStatus(adminSession)).data.apple).toMatchObject({
      relayAction: "enable",
      relayHintDismissed: false,
    });
  });

  it("answers a guardian on a ward's record by the guardian's own role", async () => {
    const guardian = await makeAdmin();
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const session = await makeSession(guardian);
    await switchSessionTo(session.sessionId, profile.id);
    expect((await walletStatus(session)).data.apple).toMatchObject({
      state: "relay_off",
      relayAction: "enable",
    });
    expect((await dismiss(session)).status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: guardian.id },
      select: { walletRelayHintDismissed: true },
    });
    expect(row.walletRelayHintDismissed).toBe(true);
  });

  it("needs no relay with the operator's own signer", async () => {
    await localEnv();
    const admin = await makeAdmin();
    const session = await makeSession(admin);
    expect((await walletStatus(session)).data.apple).toMatchObject({
      available: true,
      state: "available",
      signer: "local",
      relayAction: null,
    });
  });
});
