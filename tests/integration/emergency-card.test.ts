/**
 * The emergency card against real Postgres, driven through the shipped
 * routes: the owner's card carries every item; the QR link shows only the
 * ticked ones and never reads the rest; every access is counted and audited;
 * revoked, expired and malformed links read as the same miss; one live link
 * per record; a credential remediation ends it; the wallet PDF prints only
 * the caller's own link, and only while it opens; the offline copy escapes what it carries.
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

// The renderer runs as shipped; the spy only records what it was handed.
const pdfCalls = vi.hoisted(
  () => [] as { linkUrl: string | null; fields: string[] }[],
);
vi.mock("@/lib/emergency-card/wallet-pdf", async (orig) => {
  const real = await orig<typeof import("@/lib/emergency-card/wallet-pdf")>();
  return {
    ...real,
    buildWalletCardPdf: async (
      args: Parameters<typeof real.buildWalletCardPdf>[0],
    ) => {
      pdfCalls.push({ linkUrl: args.linkUrl, fields: [...args.view.fields] });
      return real.buildWalletCardPdf(args);
    },
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
  pdfCalls.length = 0;
});

describe("emergency card", () => {
  it("serves only the ticked items, counts and audits every access", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    await signIn(owner.id);

    const own = await call("", "GET");
    expect(own.status).toBe(200);
    const { card, targets } = (await own.json()).data;
    expect(card.bloodType).toBe("O_NEG");
    expect(card.allergies[0]).toMatchObject({ substance: "Penicillin" });
    expect(card.medications[0]).toMatchObject({ name: "Levothyroxine" });
    // The owner's read says where each line is edited: the medication on
    // its own page, the allergy and the emergency details in the history.
    const medication = await db().medication.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(targets.medications).toEqual([`/medications/${medication.id}`]);
    expect(targets.fields.ALLERGIES).toBe("/settings/anamnesis#allergies");
    expect(targets.fields.BLOOD_TYPE).toBe("/settings/anamnesis#emergency");

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
    // The link's read carries no record ids and no edit targets.
    expect(JSON.stringify(read)).not.toContain(medication.id);
    expect(read).not.toHaveProperty("targets");

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

  it("answers /e/<token> as one script-free document, and every miss as the same 404", async () => {
    const owner = await makeUser();
    await seedCard(owner.id);
    await signIn(owner.id);
    const { url } = (
      await (await call("link", "POST", { fields: ["BLOOD_TYPE"] })).json()
    ).data;
    // The reader is a stranger: no session.
    cookieJar.clear();
    const { GET } = await import("@/app/e/[token]/route");
    const open = (token: string) =>
      GET(new NextRequest(`http://localhost/e/${token}`), {
        params: Promise.resolve({ token }),
      });

    const hit = await open(tokenOf(url));
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toContain("text/html");
    expect(hit.headers.get("cache-control")).toContain("no-store");
    expect(hit.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await hit.text();
    // No script: nothing registers a service worker on the reader's phone.
    expect(page).not.toMatch(/<script/i);
    // The phone's own light or dark setting decides the colours.
    expect(page).toContain("prefers-color-scheme:dark");
    expect(page).toContain("color-scheme:light dark");

    const misses = ["hlm_nope", `hlm_${"0".repeat(48)}`, "not-even-close"];
    await db().emergencyCardLink.updateMany({
      where: { userId: owner.id },
      data: { revokedAt: new Date() },
    });
    misses.push(tokenOf(url));
    const bodies = new Set<string>();
    for (const token of misses) {
      const miss = await open(token);
      expect(miss.status, token).toBe(404);
      expect(miss.headers.get("cache-control"), token).toContain("no-store");
      const body = await miss.text();
      expect(body).not.toMatch(/<script|href=/i);
      bodies.add(body);
    }
    // One document for every miss class.
    expect(bodies.size).toBe(1);
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

  it("prints no code for a revoked link or on a switched-off instance", async () => {
    const owner = await makeUser();
    await signIn(owner.id);
    const { url } = (
      await (await call("link", "POST", { fields: ["BLOOD_TYPE"] })).json()
    ).data;

    await db().appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", apiGlobal: false },
      update: { apiGlobal: false },
    });
    const off = await call("wallet", "POST", { token: tokenOf(url) });
    expect(off.status).toBe(422);
    await db().appSettings.update({
      where: { id: "singleton" },
      data: { apiGlobal: true },
    });
    expect((await call("wallet", "POST", { token: tokenOf(url) })).status).toBe(
      200,
    );

    await db().emergencyCardLink.updateMany({
      where: { userId: owner.id },
      data: { revokedAt: new Date() },
    });
    const revoked = await call("wallet", "POST", { token: tokenOf(url) });
    expect(revoked.status).toBe(422);
    expect(pdfCalls).toHaveLength(1);
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
    // The card with the code carries what the code shows.
    expect(pdfCalls.at(-1)).toEqual({
      linkUrl: expect.stringMatching(/\/e\/hlm_[0-9a-f]{48}$/),
      fields: ["BLOOD_TYPE"],
    });

    const refused = await call("wallet", "POST", { token: tokenOf(foreign) });
    expect(refused.status).toBe(422);
    expect((await refused.json()).meta.errorCode).toBe(
      "emergency-card.wallet.token",
    );

    // A link past its end answers nothing, so its code is not printed.
    await db().emergencyCardLink.updateMany({
      where: { userId: owner.id, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const ended = await call("wallet", "POST", { token: tokenOf(url) });
    expect(ended.status).toBe(422);
    expect((await ended.json()).meta.errorCode).toBe(
      "emergency-card.wallet.token",
    );
    expect((await call("wallet", "POST", {})).status).toBe(200);
    expect(pdfCalls.at(-1)?.linkUrl).toBeNull();
    expect(pdfCalls.at(-1)?.fields.length).toBeGreaterThan(1);

    const html = await call("offline", "GET");
    expect(html.status).toBe(200);
    const text = await html.text();
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("Penicillin");
  });
});
