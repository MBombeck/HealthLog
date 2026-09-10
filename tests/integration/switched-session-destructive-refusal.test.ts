/**
 * The three destructive account routes, driven with a live record switch on.
 *
 * `DELETE /api/settings/data` wipes a record, `DELETE /api/settings/account`
 * erases an account, and `POST /api/export/encrypted` puts a whole record into
 * one file. None of them names a record: they resolve the CALLER and act on
 * whatever that caller owns. So the question a switched session asks of them is
 * not "may I do this to the record I am inside" — it is "what happens when the
 * browser believes it is somewhere else and the route does not check".
 *
 * The answer must be a refusal, and the same one every undeclared route gives:
 * 403, `sharing.not_permitted`, "cannot be used while acting on another
 * account". Silently serving the delegate's own record is the failure this
 * pins against, and it is the worst-shaped one in the product — a person who
 * believes they are looking after somebody else's record presses "delete
 * everything" and erases their own.
 *
 * Both halves are asserted: the status AND that nothing moved. A refusal that
 * happens after the transaction would satisfy the first alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER_ID = "switch-destructive-owner";
const DELEGATE_ID = "switch-destructive-delegate";

/** The delegate's own reading. It must still be there afterwards. */
async function seedRecords() {
  const prisma = getPrismaClient();
  for (const [id, name] of [
    [OWNER_ID, "owner"],
    [DELEGATE_ID, "delegate"],
  ] as const) {
    await prisma.user.create({
      data: {
        id,
        username: `switch-destructive-${name}`,
        email: `switch-destructive-${name}@example.test`,
        timezone: "UTC",
      },
    });
  }
  await prisma.measurement.create({
    data: {
      userId: DELEGATE_ID,
      type: "WEIGHT",
      value: 72,
      unit: "kg",
      measuredAt: new Date(),
    },
  });
}

/**
 * Sign the delegate in and switch into the owner's record at MANAGE — the
 * widest grant the product mints, so nothing below can be explained away by
 * the grant simply being too narrow.
 */
async function switchIntoOwnersRecord() {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: OWNER_ID,
    granteeId: DELEGATE_ID,
    access: "MANAGE",
    scope: null,
  });
  await acceptGrant({ grantId: invited.id, granteeId: DELEGATE_ID });
  const session = await getPrismaClient().session.create({
    data: {
      userId: DELEGATE_ID,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  await switchSessionTo(session.id, OWNER_ID);
}

/** The one refusal all three must give. */
async function expectSwitchRefusal(response: Response) {
  expect(response.status).toBe(403);
  const body = (await response.json()) as {
    error: string;
    meta?: { errorCode?: string };
  };
  expect(body.meta?.errorCode).toBe("sharing.not_permitted");
  expect(body.error).toBe(
    "This endpoint cannot be used while acting on another account",
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedRecords();
  await switchIntoOwnersRecord();
});

describe("a switched session reaches none of the record-wide destructive routes", () => {
  it("refuses the record wipe and wipes neither record", async () => {
    const { DELETE } = await import("@/app/api/settings/data/route");
    await expectSwitchRefusal(
      await DELETE(
        new Request("http://localhost/api/settings/data", {
          method: "DELETE",
          body: JSON.stringify({ confirm: "DELETE" }),
        }) as never,
      ),
    );

    const prisma = getPrismaClient();
    expect(
      await prisma.measurement.count({ where: { userId: DELEGATE_ID } }),
      "the delegate's own reading survived",
    ).toBe(1);
    expect(
      await prisma.user.count({
        where: { id: { in: [OWNER_ID, DELEGATE_ID] } },
      }),
    ).toBe(2);
  });

  it("refuses the account deletion and deletes neither account", async () => {
    const { DELETE } = await import("@/app/api/settings/account/route");
    await expectSwitchRefusal(
      await DELETE(
        new Request("http://localhost/api/settings/account", {
          method: "DELETE",
          body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
        }) as never,
      ),
    );

    expect(
      await getPrismaClient().user.count({
        where: { id: { in: [OWNER_ID, DELEGATE_ID] } },
      }),
    ).toBe(2);
  });

  it("refuses the encrypted export and hands out no archive", async () => {
    const { POST } = await import("@/app/api/export/encrypted/route");
    const response = await POST(
      new Request("http://localhost/api/export/encrypted", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: "a-long-enough-passphrase-123" }),
      }) as never,
    );
    await expectSwitchRefusal(response);
    // Not an archive under any content type: a refusal that still streamed the
    // bytes would read as a 403 to a status check and as an export to a user.
    expect(response.headers.get("content-type")).not.toContain(
      "application/octet-stream",
    );
  });
});
