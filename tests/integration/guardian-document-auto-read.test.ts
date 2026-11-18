/**
 * #1403 — a guardian switches automatic document reading for the profile.
 *
 * The switch is the profile's own (`documentsAutoAiRead` on the profile's
 * row, the column the upload pipeline and the summary job read for the
 * record). A guardian sets it through the record-settings `documents`
 * family; an adult's delegate cannot, at any level. Turning it on records
 * the profile's document-reading consent, with the guardian named on the
 * audit row, and an upload then queues reading for the profile under the
 * profile's own capability.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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

const enqueued = vi.hoisted(() => ({
  summary: [] as string[],
  catchUp: [] as string[],
}));
vi.mock("@/lib/jobs/document-index", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueDocumentIndex: vi.fn(async () => {}),
}));
vi.mock("@/lib/jobs/document-thumbnail", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueDocumentThumbnail: vi.fn(async () => {}),
}));
vi.mock("@/lib/jobs/document-summary", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueDocumentSummary: vi.fn(async (userId: string) => {
    enqueued.summary.push(userId);
  }),
}));
vi.mock("@/lib/jobs/document-summary-catchup", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueueSummaryCatchUp: vi.fn(async (userId: string) => {
    enqueued.catchUp.push(userId);
  }),
}));

import { documentAutoReadEnabled } from "@/lib/documents/document-settings";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `gar-${suffix}`,
      email: `gar-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      modulePreferencesJson: { inboundDocuments: true },
    },
  });
}

async function signIn(userId: string) {
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function operatorProvider() {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      adminAiKeyEncrypted: encrypt("sk-operator-integration-test"),
      adminAiModel: "gpt-4o",
    },
    update: {
      adminAiKeyEncrypted: encrypt("sk-operator-integration-test"),
      adminAiModel: "gpt-4o",
    },
  });
}

async function guardianInside() {
  const guardian = await makeUser("guardian");
  const { createManagedProfile } =
    await import("@/lib/managed-profiles/create");
  const { profile } = await createManagedProfile({
    creatorId: guardian.id,
    displayName: "Managed record",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  await getPrismaClient().user.update({
    where: { id: profile.id },
    data: { modulePreferencesJson: { inboundDocuments: true } },
  });
  const session = await signIn(guardian.id);
  await switchSessionTo(session.id, profile.id);
  return { guardian, profile, session };
}

async function documentsSettings(method: "GET" | "PATCH", body?: unknown) {
  const route = await import("@/app/api/record-settings/[family]/route");
  const { NextRequest } = await import("next/server");
  const handler = route[method] as unknown as (
    r: unknown,
    c: { params: Promise<{ family: string }> },
  ) => Promise<Response>;
  const res = await handler(
    new NextRequest("http://localhost/api/record-settings/documents", {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
    { params: Promise.resolve({ family: "documents" }) },
  );
  return { status: res.status, body: await res.json() };
}

async function upload() {
  const route = await import("@/app/api/documents/inbound/route");
  const form = new FormData();
  form.append(
    "file",
    new Blob([
      new TextEncoder().encode(
        `%PDF-1.7\n% auto read ${counter++}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`,
      ),
    ]),
    "scan.pdf",
  );
  const res = await (
    route.POST as unknown as (r: Request) => Promise<Response>
  )(
    new Request("http://localhost/api/documents/inbound", {
      method: "POST",
      body: form,
    }),
  );
  return res.status;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
  enqueued.summary.length = 0;
  enqueued.catchUp.length = 0;
});

describe("a guardian turns automatic reading on for the profile", () => {
  it("writes the profile's switch and consent, names the guardian, and the upload pipeline reads it", async () => {
    await operatorProvider();
    const { guardian, profile } = await guardianInside();
    const prisma = getPrismaClient();

    // Off by default, for the profile and therefore for the pipeline.
    const before = await documentsSettings("GET");
    expect(before.status).toBe(200);
    expect(before.body.data.settings).toEqual({ autoAiRead: false });
    expect(await documentAutoReadEnabled(profile.id)).toBe(false);

    const on = await documentsSettings("PATCH", { autoAiRead: true });
    expect(on.status).toBe(200);
    expect(on.body.data).toMatchObject({
      recordId: profile.id,
      family: "documents",
      settings: { autoAiRead: true },
    });

    // The profile's row and the profile's consent; the guardian's own
    // preference is untouched.
    const rows = await prisma.user.findMany({
      where: { id: { in: [profile.id, guardian.id] } },
      select: { id: true, documentsAutoAiRead: true },
    });
    expect(
      Object.fromEntries(rows.map((r) => [r.id, r.documentsAutoAiRead])),
    ).toEqual({ [profile.id]: true, [guardian.id]: false });
    const receipts = await prisma.consentReceipt.findMany({
      where: { kind: "ai_extraction" },
      select: { userId: true, artefact: true },
    });
    expect(receipts.map((r) => r.userId)).toEqual([profile.id]);
    expect(JSON.parse(receipts[0]!.artefact)).toMatchObject({
      grantedBy: "guardian",
    });

    const audit = await prisma.auditLog.findMany({
      where: { action: "record-settings.documents.update" },
      select: { userId: true, actorUserId: true },
    });
    expect(audit).toEqual([{ userId: profile.id, actorUserId: guardian.id }]);

    // The switch is what the summary job and the index job ask for the
    // record, the catch-up was queued for the profile, and an upload queues
    // its reading for the profile.
    expect(await documentAutoReadEnabled(profile.id)).toBe(true);
    expect(enqueued.catchUp).toEqual([profile.id]);
    expect(await upload()).toBe(201);
    expect(enqueued.summary).toEqual([profile.id]);

    // And off again, without touching the receipt.
    const off = await documentsSettings("PATCH", { autoAiRead: false });
    expect(off.status).toBe(200);
    expect(await documentAutoReadEnabled(profile.id)).toBe(false);
  });

  it("refuses an unknown field rather than writing a partial change", async () => {
    await guardianInside();
    const res = await documentsSettings("PATCH", {
      autoAiRead: true,
      documentsAutoAiRead: true,
    });
    expect(res.status).toBe(422);
  });
});

describe("an adult's delegate", () => {
  for (const access of ["READ", "WRITE", "MANAGE"] as const) {
    it(`cannot read or change the switch at ${access}`, async () => {
      const owner = await makeUser("owner");
      const delegate = await makeUser("delegate");
      const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
      const invited = await inviteGrant({
        grantorId: owner.id,
        granteeId: delegate.id,
        access,
        scope: null,
      });
      await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
      const session = await signIn(delegate.id);
      await switchSessionTo(session.id, owner.id);

      expect((await documentsSettings("GET")).status).toBe(403);
      expect(
        (await documentsSettings("PATCH", { autoAiRead: true })).status,
      ).toBe(403);
      expect(await documentAutoReadEnabled(owner.id)).toBe(false);
      expect(
        await getPrismaClient().consentReceipt.count({
          where: { userId: owner.id },
        }),
      ).toBe(0);
    });
  }
});
