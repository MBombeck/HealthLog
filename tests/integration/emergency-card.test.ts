/**
 * The emergency card against real Postgres, driven through the shipped
 * routes: the owner's card carries every item; the QR link shows only the
 * ticked ones and never reads the rest; every access is counted and audited;
 * revoked, expired and malformed links read as the same miss; one live link
 * per record; a credential remediation ends it; the wallet PDF prints only
 * the caller's own live link; the offline copy escapes what it carries.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { credentialRevocations } from "@/lib/auth/credential-revocations";
import { readEmergencyCardByToken } from "@/lib/emergency-card/serve";
import { writeEmergencyProfile } from "@/lib/profile/emergency-profile";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-emergency-card-integration-32-bytes-min-1234567890";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

async function makeUser() {
  const suffix = `${counter++}`;
  return db().user.create({
    data: {
      username: `card-${suffix}`,
      email: `card-${suffix}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
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
  path: "link" | "wallet" | "offline" | "",
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
) {
  const route =
    path === "link"
      ? await import("@/app/api/emergency-card/link/route")
      : path === "wallet"
        ? await import("@/app/api/emergency-card/wallet/route")
        : path === "offline"
          ? await import("@/app/api/emergency-card/offline/route")
          : await import("@/app/api/emergency-card/route");
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

const tokenOf = (url: string) => url.split("/e/")[1];
const anon = () =>
  new Request("http://localhost/e", { headers: new Headers() });

async function seedCard(userId: string) {
  await writeEmergencyProfile(userId, {
    bloodType: "O_NEG",
    contacts: "Partner +49 170 0000000",
    note: "<script>alert(1)</script>",
  });
  await db().allergy.create({
    data: { userId, substance: "Penicillin", severity: "SEVERE" },
  });
  await db().medication.create({
    data: { userId, name: "Levothyroxine", dose: "50 µg" },
  });
}

beforeEach(async () => {
  await truncateAllTables(db());
});

describe("emergency card", () => {
  it("serves only the ticked items, counts and audits every access", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    await signIn(owner.id);

    const own = await call("", "GET");
    expect(own.status).toBe(200);
    const card = (await own.json()).data.card;
    expect(card.bloodType).toBe("O_NEG");
    expect(card.allergies[0]).toMatchObject({ substance: "Penicillin" });
    expect(card.medications[0]).toMatchObject({ name: "Levothyroxine" });

    const minted = await call("link", "POST", {
      fields: ["BLOOD_TYPE", "ALLERGIES"],
    });
    expect(minted.status).toBe(201);
    const { url, link } = (await minted.json()).data;
    expect(url).toMatch(/\/e\/hlm_[0-9a-f]{48}$/);
    expect(link.fields).toEqual(["BLOOD_TYPE", "ALLERGIES"]);

    const read = await readEmergencyCardByToken(anon(), tokenOf(url));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.view.bloodType).toBe("O_NEG");
    expect(read.view.allergies?.[0].substance).toBe("Penicillin");
    // Not ticked: never read, so never served.
    expect(read.view.contacts).toBeNull();
    expect(read.view.note).toBeNull();
    expect(read.view.medications).toBeNull();

    const row = await db().emergencyCardLink.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(row.accessCount).toBe(1);
    expect(row.lastAccessAt).not.toBeNull();
    expect(
      await db().auditLog.count({
        where: { userId: owner.id, action: "emergency-card.link.access" },
      }),
    ).toBe(1);

    // The status never carries the URL.
    const status = await call("link", "GET");
    const statusBody = JSON.stringify(await status.json());
    expect(statusBody).not.toContain(tokenOf(url));
  });

  it("keeps serving a card that is reloaded again and again, auditing a bounded number", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    await signIn(owner.id);
    const minted = await call("link", "POST", { fields: ["BLOOD_TYPE"] });
    const { url } = (await minted.json()).data;

    // Whoever has seen the card can reload it; that must not lock it for the
    // person who needs it next.
    for (let i = 0; i < 75; i++) {
      const read = await readEmergencyCardByToken(anon(), tokenOf(url));
      expect(read.ok).toBe(true);
    }
    const row = await db().emergencyCardLink.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(row.accessCount).toBe(60);
    expect(
      await db().auditLog.count({
        where: { userId: owner.id, action: "emergency-card.link.access" },
      }),
    ).toBe(60);
  });

  it("holds one live link, and revoked, expired or malformed links miss alike", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    await signIn(owner.id);
    const { url } = (
      await (
        await call("link", "POST", {
          fields: ["BLOOD_TYPE"],
          expiresInDays: 30,
        })
      ).json()
    ).data;
    const second = await call("link", "POST", { fields: ["BLOOD_TYPE"] });
    expect(second.status).toBe(409);

    expect((await readEmergencyCardByToken(anon(), "hlm_nope")).ok).toBe(false);
    expect(
      (await readEmergencyCardByToken(anon(), `hlm_${"0".repeat(48)}`)).ok,
    ).toBe(false);

    await db().emergencyCardLink.updateMany({
      where: { userId: owner.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await readEmergencyCardByToken(anon(), tokenOf(url))).ok).toBe(
      false,
    );

    expect((await call("link", "DELETE")).status).toBe(200);
    await db().emergencyCardLink.updateMany({
      where: { userId: owner.id },
      data: { expiresAt: null },
    });
    expect((await readEmergencyCardByToken(anon(), tokenOf(url))).ok).toBe(
      false,
    );
  });

  it("ends the link with a credential remediation", async () => {
    const owner = await makeUser();
    await signIn(owner.id);
    const { url } = (
      await (await call("link", "POST", { fields: ["BLOOD_TYPE"] })).json()
    ).data;
    await db().$transaction(credentialRevocations(db(), owner.id));
    expect((await readEmergencyCardByToken(anon(), tokenOf(url))).ok).toBe(
      false,
    );
  });

  it("prints only the caller's own live link and escapes the offline copy", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    await seedCard(owner.id);
    await signIn(other.id);
    const foreign = (
      await (await call("link", "POST", { fields: ["BLOOD_TYPE"] })).json()
    ).data.url;

    await signIn(owner.id);
    const { url } = (
      await (await call("link", "POST", { fields: ["BLOOD_TYPE"] })).json()
    ).data;

    const pdf = await call("wallet", "POST", { token: tokenOf(url) });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");

    const refused = await call("wallet", "POST", { token: tokenOf(foreign) });
    expect(refused.status).toBe(422);
    expect((await refused.json()).meta.errorCode).toBe(
      "emergency-card.wallet.token",
    );

    const html = await call("offline", "GET");
    expect(html.status).toBe(200);
    const text = await html.text();
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("Penicillin");
  });
});
