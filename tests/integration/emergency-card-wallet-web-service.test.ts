/**
 * Apple Wallet's pass web service and the pushes that keep a pass current,
 * against real Postgres, driven through the shipped routes and job handlers
 * (v1.50), with the project's signing service on a fake relay:
 *
 * - registration 201 then 200, one bare 401 for every way a request is not
 *   about this pass, ten devices at most, unregister;
 * - the list of changed serial numbers with its tag, 204 when nothing
 *   changed; the pass fetched 200 then 304; the log counted, never kept;
 * - a card change rebuilds the pass and pushes every device once, a second
 *   run with no change pushes nothing; a withdrawal pushes unthrottled and
 *   the withdrawn version is served;
 * - a password change, a deletion request, a handover and a guardian whose
 *   grant is gone each withdraw the pass with their reason.
 */
import { unzipSync } from "fflate";
import type { Job } from "pg-boss";
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

import { destroyAllSessions } from "@/lib/auth/session";
import { walletAuthToken } from "@/lib/emergency-card/wallet-pass/link-token";
import { openWalletLinkToken } from "@/lib/emergency-card/wallet-pass/link-token";
import {
  handleWalletPassRefresh,
  handleWalletPassSweep,
  handleWalletPassVoidPush,
} from "@/lib/jobs/wallet-pass";
import { clearManagedProfileMarker } from "@/lib/managed-profiles/lifecycle";
import { requestAccountDeletion } from "@/lib/account-deletion/request";
import { WALLET_RELAY_CONSENT_TEXT_VERSION } from "@/lib/push-relay/config";
import { writeEmergencyProfile } from "@/lib/profile/emergency-profile";

import { anonymous, callRoute } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { cookieJar, headerJar } from "./mock-next-headers";
import { enableRelay } from "./push-relay-kit";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const HTTPS = { "x-forwarded-proto": "https", host: "health.example.test" };
const PTID = "pass.dev.healthlog.vector";
const REG =
  "/api/wallet/apple/v1/devices/{deviceId}/registrations/{passTypeId}/{serial}";
const SERIALS =
  "/api/wallet/apple/v1/devices/{deviceId}/registrations/{passTypeId}";
const LOG = "/api/wallet/apple/v1/log";

const routes = async () => ({
  wallet: await import("@/app/api/emergency-card/wallet/apple/route"),
  reg: await import("@/app/api/wallet/apple/v1/devices/[deviceId]/registrations/[passTypeId]/[serial]/route"),
  serials:
    await import("@/app/api/wallet/apple/v1/devices/[deviceId]/registrations/[passTypeId]/route"),
  pass: await import("@/app/api/wallet/apple/v1/passes/[passTypeId]/[serial]/route"),
  log: await import("@/app/api/wallet/apple/v1/log/route"),
});

const pause = () => new Promise((r) => setTimeout(r, 15));
const token = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const asJobs = <T>(data: T) => [{ data } as Job<T>];

async function relayWithWallet() {
  const fake = Object.assign(new FakeRelay(), {
    status: {
      wallet: {
        sign: true,
        notify: true,
        passTypeIdentifier: PTID,
        teamIdentifier: "VECTOR1234",
        certNotAfterDay: 24107,
      },
    },
  });
  relay.current = fake;
  await enableRelay();
  const { loadRegistration, relayCall } =
    await import("@/lib/push-relay/registration");
  const row = await loadRegistration();
  if (!row) throw new Error("the relay is not on");
  await relayCall(row, "GET", "/v1/status");
  return fake;
}

/** An owner with a card and a live pass; the pass's serial and auth token. */
async function ownerWithPass() {
  const owner = await makeUser();
  await prisma.user.update({
    where: { id: owner.id },
    data: { fullName: "Alex Example", timezone: "Europe/Berlin", locale: "en" },
  });
  await writeEmergencyProfile(owner.id, { bloodType: "O_NEG" });
  await prisma.allergy.create({
    data: { userId: owner.id, substance: "Penicillin", severity: "SEVERE" },
  });
  const session = await makeSession(owner);
  const { wallet } = await routes();
  const made = await callRoute<{ pass: { serialNumber: string } }>(
    wallet.POST,
    {
      method: "POST",
      route: "/api/emergency-card/wallet/apple",
      auth: session,
      headers: HTTPS,
      body: {
        fields: ["NAME", "BLOOD_TYPE", "ALLERGIES"],
        consentTextVersion: WALLET_RELAY_CONSENT_TEXT_VERSION,
      },
    },
  );
  expect(made.status).toBe(201);
  const serial = made.data.pass.serialNumber;
  const row = await prisma.walletPass.findUniqueOrThrow({
    where: { serialNumber: serial },
    select: { id: true, link: { select: { tokenEncrypted: true } } },
  });
  const raw = openWalletLinkToken(row.link.tokenEncrypted as string) as string;
  return {
    owner,
    session,
    serial,
    passId: row.id,
    auth: `ApplePass ${walletAuthToken(raw, serial)}`,
  };
}

async function register(
  deviceId: string,
  serial: string,
  auth: string,
  pushToken = token(1),
  passTypeId = PTID,
) {
  const { reg } = await routes();
  return callRoute(reg.POST, {
    method: "POST",
    route: REG,
    params: { deviceId, passTypeId, serial },
    auth: anonymous,
    headers: { authorization: auth },
    body: { pushToken },
  });
}

async function serials(deviceId: string, since?: string) {
  const { serials: route } = await routes();
  return callRoute<never>(route.GET, {
    method: "GET",
    route: SERIALS,
    params: { deviceId, passTypeId: PTID },
    query: since ? { passesUpdatedSince: since } : undefined,
    auth: anonymous,
  });
}

/** Wallet's fetch of the pass, read as bytes. */
async function fetchPass(
  serial: string,
  auth: string,
  extra: Record<string, string> = {},
) {
  const { pass } = await routes();
  const headers = new Headers({ ...HTTPS, authorization: auth, ...extra });
  cookieJar.clear();
  headerJar.clear();
  headers.forEach((value, name) => headerJar.set(name, value));
  try {
    const response = await pass.GET(
      new NextRequest(
        `https://health.example.test/api/wallet/apple/v1/passes/${PTID}/${serial}`,
        { headers },
      ),
      { params: Promise.resolve({ passTypeId: PTID, serial }) },
    );
    return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
  } finally {
    headerJar.clear();
  }
}

function passJson(bytes: Uint8Array) {
  return JSON.parse(
    new TextDecoder().decode(unzipSync(bytes)["pass.json"]),
  ) as {
    voided: boolean;
    barcodes?: unknown[];
  };
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

describe("Apple's pass web service", () => {
  it("registers a device, refuses every stranger the same way, lists and serves", async () => {
    await relayWithWallet();
    const { serial, auth } = await ownerWithPass();

    expect((await register("DEVICE1", serial, auth)).status).toBe(201);
    expect((await register("DEVICE1", serial, auth, token(2))).status).toBe(
      200,
    );
    expect(await prisma.walletPassRegistration.count()).toBe(1);

    // A wrong token, an unknown serial and a foreign Pass Type ID: one
    // answer, no body.
    const wrong = await register(
      "DEVICE2",
      serial,
      `ApplePass ${"0".repeat(64)}`,
    );
    const unknown = await register(
      "DEVICE2",
      "6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b",
      auth,
    );
    const foreign = await register(
      "DEVICE2",
      serial,
      auth,
      token(3),
      "pass.org.example.other",
    );
    for (const r of [wrong, unknown, foreign]) {
      expect(r.status).toBe(401);
      expect(r.body).toBe("");
    }
    expect((await register("bad id!", serial, auth)).status).toBe(401);

    const first = await serials("DEVICE1");
    expect(first.status).toBe(200);
    const listed = first.body as {
      serialNumbers: string[];
      lastUpdated: string;
    };
    expect(listed.serialNumbers).toEqual([serial]);
    expect(listed.lastUpdated).toMatch(/^\d+$/);
    expect((await serials("DEVICE1", listed.lastUpdated)).status).toBe(204);
    expect((await serials("NOBODY")).status).toBe(204);

    const fetched = await fetchPass(serial, auth);
    expect(fetched.response.status).toBe(200);
    expect(fetched.response.headers.get("content-type")).toBe(
      "application/vnd.apple.pkpass",
    );
    const modified = fetched.response.headers.get("last-modified") as string;
    expect(modified).toBeTruthy();
    expect(passJson(fetched.bytes).voided).toBe(false);
    const again = await fetchPass(serial, auth, {
      "if-modified-since": modified,
    });
    expect(again.response.status).toBe(304);
    expect(
      (await fetchPass(serial, `ApplePass ${"1".repeat(64)}`)).response.status,
    ).toBe(401);

    const { reg } = await routes();
    const gone = await callRoute(reg.DELETE, {
      method: "DELETE",
      route: REG,
      params: { deviceId: "DEVICE1", passTypeId: PTID, serial },
      auth: anonymous,
      headers: { authorization: auth },
    });
    expect(gone.status).toBe(200);
    expect(await prisma.walletPassRegistration.count()).toBe(0);
  });

  it("keeps ten devices per pass; the eleventh replaces the oldest", async () => {
    await relayWithWallet();
    const { serial, auth, passId } = await ownerWithPass();
    for (let i = 1; i <= 11; i += 1) {
      expect(
        (await register(`DEVICE${i}`, serial, auth, token(i))).status,
      ).toBe(201);
      await pause();
    }
    const regs = await prisma.walletPassRegistration.findMany({
      where: { walletPassId: passId },
    });
    expect(regs).toHaveLength(10);
    const { hashToken } = await import("@/lib/auth/hmac");
    expect(regs.map((r) => r.deviceLibraryIdHash)).not.toContain(
      hashToken("DEVICE1"),
    );
    // Stored sealed and hashed: neither the push token nor the device id.
    const stored = JSON.stringify(regs);
    expect(stored).not.toContain(token(2));
    expect(stored).not.toContain("DEVICE2");
  });

  it("counts the log and refuses one over 16 KiB", async () => {
    const { log } = await routes();
    const ok = await callRoute(log.POST, {
      method: "POST",
      route: LOG,
      auth: anonymous,
      body: { logs: ["one", "two"] },
    });
    expect(ok.status).toBe(200);
    const big = await callRoute(log.POST, {
      method: "POST",
      route: LOG,
      auth: anonymous,
      body: { logs: ["x".repeat(17 * 1024)] },
    });
    expect(big.status).toBe(413);
  });
});

describe("keeping the pass current", () => {
  it("pushes every device once after a card change, and not again without one", async () => {
    const fake = await relayWithWallet();
    const { owner, serial, auth, passId } = await ownerWithPass();
    await register("DEVICEA", serial, auth, token(10));
    await register("DEVICEB", serial, auth, token(11));
    await pause();

    const before = await prisma.walletPass.findUniqueOrThrow({
      where: { id: passId },
    });
    await prisma.allergy.updateMany({
      where: { userId: owner.id },
      data: { substance: "Latex" },
    });
    await handleWalletPassRefresh(asJobs({ walletPassId: passId }));
    const after = await prisma.walletPass.findUniqueOrThrow({
      where: { id: passId },
    });
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.contentChangedAt.getTime()).toBeGreaterThan(
      before.contentChangedAt.getTime(),
    );
    expect(fake.walletPushes.map((p) => p.token).sort()).toEqual(
      [token(10), token(11)].sort(),
    );

    await handleWalletPassRefresh(asJobs({ walletPassId: passId }));
    await handleWalletPassSweep([]);
    expect(fake.walletPushes).toHaveLength(2);

    // Wallet's list now names the pass for a device that last asked before.
    const listed = (
      await serials("DEVICEA", String(before.contentChangedAt.getTime()))
    ).body as { serialNumbers: string[] };
    expect(listed.serialNumbers).toEqual([serial]);
  });

  it("keeps a registration Apple refused for the certificate, drops one whose token is dead", async () => {
    const fake = await relayWithWallet();
    const { owner, serial, auth, passId } = await ownerWithPass();
    await register("DEVICEA", serial, auth, token(30));
    await register("DEVICEB", serial, auth, token(31));
    await pause();
    fake.walletAnswer.set(token(30), "rejected");
    fake.walletAnswer.set(token(31), "unregistered");
    await prisma.allergy.updateMany({
      where: { userId: owner.id },
      data: { substance: "Latex" },
    });

    const outcome = await handleWalletPassRefresh(
      asJobs({ walletPassId: passId }),
    );

    // The refusal fails the job (the queue retries it, the worker report
    // shows it); only the dead token's registration went.
    expect(outcome.ok).toBe(false);
    const left = await prisma.walletPassRegistration.findMany({
      where: { walletPassId: passId },
      select: { lastPushAt: true },
    });
    expect(left).toHaveLength(1);
    expect(left[0].lastPushAt).toBeNull();

    // Once Apple takes it again, the owed push goes out and the job is green.
    fake.walletAnswer.clear();
    const retried = await handleWalletPassRefresh(
      asJobs({ walletPassId: passId }),
    );
    expect(retried.ok).toBe(true);
    expect(fake.walletPushes.filter((p) => p.token === token(30))).toHaveLength(
      2,
    );
  });

  it("pushes a withdrawal at once and serves the withdrawn version", async () => {
    const fake = await relayWithWallet();
    const { session, serial, auth } = await ownerWithPass();
    await register("DEVICEA", serial, auth, token(20));
    await pause();
    const { wallet } = await routes();
    const revoked = await callRoute(wallet.DELETE, {
      method: "DELETE",
      route: "/api/emergency-card/wallet/apple",
      auth: session,
    });
    expect(revoked.status).toBe(200);
    await handleWalletPassVoidPush([]);
    expect(fake.walletPushes.map((p) => p.token)).toEqual([token(20)]);
    // Told once: the next run finds nothing owed.
    await handleWalletPassVoidPush([]);
    expect(fake.walletPushes).toHaveLength(1);

    const fetched = await fetchPass(serial, auth);
    expect(fetched.response.status).toBe(200);
    const json = passJson(fetched.bytes);
    expect(json.voided).toBe(true);
    expect(json.barcodes).toBeUndefined();
  });

  it("serves an expired link's pass as the withdrawn version, with no record in it", async () => {
    await relayWithWallet();
    const { serial, auth, passId } = await ownerWithPass();
    const everyText = (bytes: Uint8Array) =>
      Object.values(unzipSync(bytes))
        .map((file) => new TextDecoder().decode(file))
        .join("\n");

    // Control: the live pass carries the record.
    const live = await fetchPass(serial, auth);
    expect(live.response.status).toBe(200);
    expect(passJson(live.bytes).voided).toBe(false);
    expect(everyText(live.bytes)).toContain("Penicillin");

    // An hour on: Wallet last saw the pass then, and the link has since run
    // out. (Last-Modified has whole seconds; moving the stamp back keeps the
    // conditional fetch below from landing in the same second.)
    const lastSeen = new Date(Date.now() - 3_600_000);
    const { linkId } = await prisma.walletPass.update({
      where: { id: passId },
      data: { contentChangedAt: lastSeen },
      select: { linkId: true },
    });
    const modified = lastSeen.toUTCString();
    await prisma.emergencyCardLink.update({
      where: { id: linkId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    // Wallet's conditional fetch is answered with the new version, not 304.
    const fetched = await fetchPass(serial, auth, {
      "if-modified-since": modified,
    });
    expect(fetched.response.status).toBe(200);
    const json = passJson(fetched.bytes);
    expect(json.voided).toBe(true);
    expect(json.barcodes).toBeUndefined();
    const text = everyText(fetched.bytes);
    expect(text).not.toContain("Penicillin");
    expect(text).not.toContain("Alex Example");
    // The record behind it is untouched: only the pass stopped reading it.
    expect(
      await prisma.allergy.count({ where: { substance: "Penicillin" } }),
    ).toBe(1);
  });

  it("withdraws the pass on a password change", async () => {
    const fake = await relayWithWallet();
    const { owner, serial, auth, passId } = await ownerWithPass();
    await register("DEVICEA", serial, auth, token(30));
    await pause();
    await destroyAllSessions(owner.id);
    const row = await prisma.walletPass.findUniqueOrThrow({
      where: { id: passId },
      select: { voidReason: true, link: { select: { revokedAt: true } } },
    });
    expect(row.voidReason).toBe("CREDENTIAL_RESET");
    expect(row.link.revokedAt).not.toBeNull();
    await handleWalletPassVoidPush([]);
    expect(fake.walletPushes.map((p) => p.token)).toEqual([token(30)]);
  });

  it("withdraws the pass when the account asks to be deleted", async () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "7");
    const fake = await relayWithWallet();
    const { owner, serial, auth, passId } = await ownerWithPass();
    await register("DEVICEA", serial, auth, token(40));
    await pause();
    await requestAccountDeletion({
      userId: owner.id,
      targetIsAdmin: false,
      requestedById: owner.id,
      inTransaction: async () => {},
    });
    const row = await prisma.walletPass.findUniqueOrThrow({
      where: { id: passId },
    });
    expect(row.voidReason).toBe("ACCOUNT_DELETION");
    // No new device during the window; the withdrawn version is served.
    expect((await register("DEVICEB", serial, auth, token(41))).status).toBe(
      401,
    );
    await handleWalletPassVoidPush([]);
    expect(fake.walletPushes.map((p) => p.token)).toEqual([token(40)]);
    const fetched = await fetchPass(serial, auth);
    expect(passJson(fetched.bytes).voided).toBe(true);
  });

  it("withdraws a guardian's pass on handover and when the grant is gone", async () => {
    await relayWithWallet();
    const guardian = await makeUser();

    const handed = await ownerWithPass();
    await prisma.user.update({
      where: { id: handed.owner.id },
      data: { managedProfileAt: new Date() },
    });
    await prisma.walletPass.update({
      where: { id: handed.passId },
      data: { createdById: guardian.id },
    });
    await clearManagedProfileMarker({ profileId: handed.owner.id });
    expect(
      (
        await prisma.walletPass.findUniqueOrThrow({
          where: { id: handed.passId },
        })
      ).voidReason,
    ).toBe("HANDOVER");

    // A guardian's pass on a record that is not a managed profile (or whose
    // grant is gone) rests on nothing: the sweep withdraws it.
    const lost = await ownerWithPass();
    await prisma.walletPass.update({
      where: { id: lost.passId },
      data: { createdById: guardian.id },
    });
    await handleWalletPassSweep([]);
    expect(
      (
        await prisma.walletPass.findUniqueOrThrow({
          where: { id: lost.passId },
        })
      ).voidReason,
    ).toBe("GUARDIAN_LOST");
  });
});
