/**
 * Account deletion and the record wipe over Bearer, for an account with a
 * second factor — against a real Postgres, the real mint, and the real gate.
 *
 * App Store guideline 5.1.1(v) requires that an account created in the app can
 * be deleted from the app. Until now an MFA-enrolled account could not: both
 * erasure routes demanded a cookie-side fresh factor and a Bearer transport had
 * no way to present one. The cases below pin that a native client CAN now
 * clear the gate, and only by re-proving a second factor through
 * `POST /api/auth/step-up` — a token alone, a password proof, another token's
 * elevation, and a narrow-scope token all still fail closed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-erasure-step-up-32-bytes-minimum-1234567890";

const { hashToken } = await import("@/lib/auth/hmac");
const { hashPassword } = await import("@/lib/auth/password");

const USER_ID = "user-erasure-step-up";
const PASSWORD = "correct horse battery staple 42";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "erasure",
      email: "erasure@example.test",
      timezone: "UTC",
      passwordHash: await hashPassword(PASSWORD),
    },
  });
});

async function mintToken(
  label: string,
  permissions: string[] = ["*"],
): Promise<{ raw: string; id: string }> {
  const raw = `hlk_${label}${"0".repeat(64 - label.length)}`;
  const row = await getPrismaClient().apiToken.create({
    data: {
      userId: USER_ID,
      name: label,
      tokenHash: hashToken(raw),
      permissions,
    },
    select: { id: true },
  });
  return { raw, id: row.id };
}

function useToken(raw: string): void {
  headerJar.set("authorization", `Bearer ${raw}`);
}

function useElevation(raw: string | null): void {
  if (raw === null) headerJar.delete("x-step-up");
  else headerJar.set("x-step-up", raw);
}

function req(path: string, method: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  const auth = headerJar.get("authorization");
  if (auth) headers.authorization = auth;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new NextRequest(`https://health.example${path}`, init as never);
}

async function enrolTotp(): Promise<string> {
  const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");
  const { encrypt } = await import("@/lib/crypto");
  const secret = generateTotpSecret();
  await getPrismaClient().user.update({
    where: { id: USER_ID },
    data: {
      totpSecretEncrypted: encrypt(secret),
      totpConfirmedAt: new Date(),
      totpLastStep: null,
    },
  });
  return secret;
}

function currentTotpCode(secretBase32: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: Date.now() });
}

async function mint(body: Record<string, unknown>): Promise<string> {
  const { POST } = await import("@/app/api/auth/step-up/route");
  const res = await POST(req("/api/auth/step-up", "POST", body));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { elevation: string } };
  return json.data.elevation;
}

async function deleteAccount(): Promise<Response> {
  const { DELETE } = await import("@/app/api/settings/account/route");
  return DELETE(
    req("/api/settings/account", "DELETE", { confirm: "DELETE_ACCOUNT" }),
  );
}

async function wipeData(): Promise<Response> {
  const { DELETE } = await import("@/app/api/settings/data/route");
  return DELETE(req("/api/settings/data", "DELETE", { confirm: "DELETE" }));
}

async function errorCodeOf(res: Response): Promise<string | undefined> {
  const json = (await res.json()) as { meta?: { errorCode?: string } };
  return json.meta?.errorCode;
}

async function userExists(): Promise<boolean> {
  return (
    (await getPrismaClient().user.findUnique({ where: { id: USER_ID } })) !==
    null
  );
}

async function auditReasons(action: string): Promise<string[]> {
  const rows = await getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(
    (r) => (JSON.parse(r.details ?? "{}") as { reason?: string }).reason ?? "",
  );
}

async function expectAuditReason(
  action: string,
  reason: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = await auditReasons(action);
    if (seen.includes(reason)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(seen).toContain(reason);
}

describe("DELETE /api/settings/account over Bearer with a second factor", () => {
  it("refuses a token alone with auth.stepup.required and deletes nothing", async () => {
    await enrolTotp();
    useToken((await mintToken("acc-none")).raw);
    useElevation(null);

    const res = await deleteAccount();

    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("auth.stepup.required");
    expect(await userExists()).toBe(true);
  });

  it("refuses a password-proved elevation and keeps it unspent", async () => {
    await enrolTotp();
    useToken((await mintToken("acc-pw")).raw);
    const elevation = await mint({ method: "password", password: PASSWORD });
    useElevation(elevation);

    const res = await deleteAccount();

    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("auth.stepup.required");
    expect(await userExists()).toBe(true);
    await expectAuditReason(
      "auth.stepup.elevation.rejected",
      "insufficient_factor",
    );
    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });

  it("refuses a narrow-scope token before any elevation is looked at", async () => {
    await enrolTotp();
    useToken((await mintToken("acc-narrow", ["fhir:read"])).raw);
    useElevation(`hle_${"f".repeat(64)}`);

    const res = await deleteAccount();

    expect(res.status).toBe(403);
    expect(await userExists()).toBe(true);
    expect(await auditReasons("auth.stepup.elevation.rejected")).toEqual([]);
  });

  it("refuses an elevation minted by another token of the same account", async () => {
    const secret = await enrolTotp();
    const minter = await mintToken("acc-minter");
    const redeemer = await mintToken("acc-redeemer");
    useToken(minter.raw);
    const elevation = await mint({
      method: "totp",
      code: currentTotpCode(secret),
    });
    useToken(redeemer.raw);
    useElevation(elevation);

    const res = await deleteAccount();

    expect(res.status).toBe(401);
    expect(await userExists()).toBe(true);
    await expectAuditReason("auth.stepup.elevation.rejected", "wrong_token");
  });

  it("deletes the account end to end on a TOTP-proved elevation", async () => {
    const secret = await enrolTotp();
    const token = await mintToken("acc-totp");
    useToken(token.raw);
    const elevation = await mint({
      method: "totp",
      code: currentTotpCode(secret),
    });
    useElevation(elevation);

    const res = await deleteAccount();

    expect(res.status).toBe(200);
    // No grace window in this suite: erased now, nothing scheduled.
    expect(await res.json()).toEqual({
      data: { deleted: true, scheduledPurgeAt: null },
      error: null,
    });
    expect(await userExists()).toBe(false);
    // The token and its elevation went with the account.
    expect(await getPrismaClient().apiToken.count()).toBe(0);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("still deletes a single-factor account on a bare wildcard token", async () => {
    useToken((await mintToken("acc-plain")).raw);
    useElevation(null);

    const res = await deleteAccount();

    expect(res.status).toBe(200);
    expect(await userExists()).toBe(false);
  });

  it("does not spend the elevation on a refused confirmation", async () => {
    const secret = await enrolTotp();
    useToken((await mintToken("acc-422")).raw);
    const elevation = await mint({
      method: "totp",
      code: currentTotpCode(secret),
    });
    useElevation(elevation);

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await DELETE(
      req("/api/settings/account", "DELETE", { confirm: "nope" }),
    );

    expect(res.status).toBe(422);
    expect(await userExists()).toBe(true);
    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });
});

describe("DELETE /api/settings/data over Bearer with a second factor", () => {
  it("refuses a token alone with auth.stepup.required", async () => {
    await enrolTotp();
    useToken((await mintToken("data-none")).raw);
    useElevation(null);

    const res = await wipeData();

    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("auth.stepup.required");
  });

  it("wipes on a TOTP-proved elevation and spends it exactly once", async () => {
    const secret = await enrolTotp();
    useToken((await mintToken("data-totp")).raw);
    await getPrismaClient().measurement.create({
      data: {
        userId: USER_ID,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(),
      },
    });
    const elevation = await mint({
      method: "totp",
      code: currentTotpCode(secret),
    });
    useElevation(elevation);

    const first = await wipeData();

    expect(first.status).toBe(200);
    expect(
      await getPrismaClient().measurement.count({ where: { userId: USER_ID } }),
    ).toBe(0);
    // The account and its second factor survive a record wipe.
    const user = await getPrismaClient().user.findUnique({
      where: { id: USER_ID },
      select: { totpConfirmedAt: true },
    });
    expect(user?.totpConfirmedAt).not.toBeNull();

    // The wipe's own model list carries `ApiToken` and `StepUpElevation`, so
    // the caller's credential goes with the record it erased. That is
    // pre-existing behaviour rather than anything this gate introduced — a
    // single-factor Bearer caller has always lost its token here — and it is
    // asserted rather than assumed, because a native client has to sign in
    // again afterwards.
    expect(
      await getPrismaClient().apiToken.count({ where: { userId: USER_ID } }),
    ).toBe(0);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);

    // Which means a replay of the very same request is refused outright.
    const second = await wipeData();
    expect(second.status).toBe(401);
  });
});
