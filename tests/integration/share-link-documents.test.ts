/**
 * Document vault, Phase 3 — share a document through the clinician link, then
 * serve it through the public token, end-to-end against a real Postgres.
 *
 * Covers the properties the unit mocks cannot pin:
 *   1. Migration 0229: the `clinician_share_link_documents` join + its cascade.
 *   2. Create-with-documents: own live doc frozen onto the link in one txn;
 *      a foreign / unknown id is refused at create (no link minted).
 *   3. The public serve route: passphrase-gated, token-confined to the frozen
 *      set, serves the exact stored bytes with the class-correct posture; a
 *      foreign id and a revoked link both 404.
 *   4. Deleting the document cascades its membership out of the link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "integration-share-link-hmac-key-at-least-32-chars";

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

const PDF_SMALL = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

async function seedVaultUser(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      modulePreferencesJson: { inboundDocuments: true },
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

function uploadRequest(bytes: Buffer, filename: string): Request {
  const payload = new Uint8Array(bytes.byteLength);
  payload.set(bytes);
  const formData = new FormData();
  formData.append("file", new Blob([payload]), filename);
  return new Request("http://localhost/api/documents/inbound", {
    method: "POST",
    body: formData,
  });
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function routes() {
  const upload = await import("@/app/api/documents/inbound/route");
  const shareLinks = await import("@/app/api/share-links/route");
  const unlock = await import("@/app/api/c/[token]/unlock/route");
  const serve = await import("@/app/c/[token]/d/[id]/route");
  return {
    upload: upload.POST as unknown as (r: Request) => Promise<Response>,
    createShare: shareLinks.POST as unknown as (
      r: Request,
    ) => Promise<Response>,
    unlock: unlock.POST as unknown as (
      r: Request,
      c: { params: Promise<{ token: string }> },
    ) => Promise<Response>,
    serve: serve.GET as unknown as (
      r: Request,
      c: { params: Promise<{ token: string; id: string }> },
    ) => Promise<Response>,
  };
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("share-link documents — end-to-end", () => {
  it("attaches an own document, then serves it through the unlocked token", async () => {
    await seedVaultUser("share-owner");
    const prisma = getPrismaClient();
    const { upload, createShare, unlock, serve } = await routes();

    // Upload a document the owner will share.
    const up = await upload(uploadRequest(PDF_SMALL, "befund.pdf"));
    expect(up.status).toBe(201);
    const docId = (await up.json()).data.id as string;

    // Create a share link carrying exactly that document.
    const created = await createShare(
      jsonRequest("http://localhost/api/share-links", "POST", {
        label: "Cardiology",
        rangeStart: "2026-01-01T00:00:00Z",
        rangeEnd: null,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        documentIds: [docId],
      }),
    );
    expect(created.status).toBe(201);
    const share = (await created.json()).data as {
      token: string;
      passphrase: string;
      documentCount: number;
    };
    expect(share.documentCount).toBe(1);

    // The membership row exists in the DB (join table, migration 0229).
    expect(await prisma.clinicianShareLinkDocument.count()).toBe(1);

    const serveUrl = `http://localhost/c/${share.token}/d/${docId}`;

    // Before unlock: the passphrase gate serves nothing.
    const locked = await serve(new Request(serveUrl), {
      params: Promise.resolve({ token: share.token, id: docId }),
    });
    expect(locked.status).toBe(404);

    // Unlock with the passphrase → the token-scoped cookie is set.
    const unlocked = await unlock(
      jsonRequest(`http://localhost/api/c/${share.token}/unlock`, "POST", {
        passphrase: share.passphrase,
      }),
      { params: Promise.resolve({ token: share.token }) },
    );
    expect(unlocked.status).toBe(200);

    // Now the blob serves: exact bytes, Class A inline posture.
    const ok = await serve(new Request(serveUrl), {
      params: Promise.resolve({ token: share.token, id: docId }),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("application/pdf");
    expect(ok.headers.get("Content-Disposition")).toContain("inline");
    expect(ok.headers.get("Cache-Control")).toBe("private, no-store");
    expect(ok.headers.get("Content-Security-Policy")).toBeNull();
    const served = Buffer.from(await ok.arrayBuffer());
    expect(served.equals(PDF_SMALL)).toBe(true);

    // A document id NOT on the frozen set is unreachable through the token.
    const foreign = await serve(
      new Request(`http://localhost/c/${share.token}/d/does-not-exist`),
      { params: Promise.resolve({ token: share.token, id: "does-not-exist" }) },
    );
    expect(foreign.status).toBe(404);

    // Revoke the link → the blob serves nothing (revocation before decrypt).
    await prisma.clinicianShareLink.updateMany({
      data: { revokedAt: new Date() },
    });
    const revoked = await serve(new Request(serveUrl), {
      params: Promise.resolve({ token: share.token, id: docId }),
    });
    expect(revoked.status).toBe(404);
  });

  it("refuses a share create referencing a document the caller does not own", async () => {
    // Owner A uploads a document.
    await seedVaultUser("share-a");
    const { upload, createShare } = await routes();
    const up = await upload(uploadRequest(PDF_SMALL, "a.pdf"));
    const aDocId = (await up.json()).data.id as string;

    // Owner B tries to attach A's document id to their own link.
    cookieJar.clear();
    await seedVaultUser("share-b");
    const created = await createShare(
      jsonRequest("http://localhost/api/share-links", "POST", {
        label: "Steal",
        rangeStart: "2026-01-01T00:00:00Z",
        rangeEnd: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        documentIds: [aDocId],
      }),
    );
    expect(created.status).toBe(422);
    // No link and no membership row were created.
    expect(await getPrismaClient().clinicianShareLink.count()).toBe(0);
    expect(await getPrismaClient().clinicianShareLinkDocument.count()).toBe(0);
  });

  it("drops a shared document out of the link when the owner deletes it (cascade)", async () => {
    await seedVaultUser("share-cascade");
    const prisma = getPrismaClient();
    const { upload, createShare } = await routes();

    const up = await upload(uploadRequest(PDF_SMALL, "c.pdf"));
    const docId = (await up.json()).data.id as string;
    await createShare(
      jsonRequest("http://localhost/api/share-links", "POST", {
        label: "Cascade",
        rangeStart: "2026-01-01T00:00:00Z",
        rangeEnd: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        documentIds: [docId],
      }),
    );
    expect(await prisma.clinicianShareLinkDocument.count()).toBe(1);

    // Hard-delete the document → its membership cascades away cleanly.
    await prisma.inboundDocument.delete({ where: { id: docId } });
    expect(await prisma.clinicianShareLinkDocument.count()).toBe(0);
    // The link itself survives (a share can lose all its documents).
    expect(await prisma.clinicianShareLink.count()).toBe(1);
  });
});
