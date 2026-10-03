/**
 * Custom medication categories (#1041) against a real Postgres, through the
 * shipped route exports.
 *
 * What the file pins:
 *   - a category is created, listed with its medication count, renamed and
 *     hidden through its own routes, and capped at twenty per account;
 *   - a medication can be filed under one of the caller's own categories and
 *     the list and detail reads publish the decrypted label beside the key;
 *   - another account's key is refused (422 `medications.category.unknown`)
 *     on create and on update, and never resolves on a read;
 *   - deleting a category moves its medications to OTHER in the same
 *     transaction, so no medication is left pointing at a key that is gone;
 *   - a key left behind anyway (written past the routes) reads as OTHER.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER = "user-med-categories";
const OTHER_USER = "user-med-categories-other";

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

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  for (const id of [OWNER, OTHER_USER]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        email: `${id}@example.test`,
        timezone: "UTC",
      },
    });
  }
  await signIn(OWNER);
});

function req(method: string, path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createCategory(label: string): Promise<string> {
  const { POST } = await import("@/app/api/medications/categories/route");
  const res = await POST(req("POST", "/api/medications/categories", { label }));
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body.data.key as string;
}

async function createMedication(category?: string) {
  const { POST } = await import("@/app/api/medications/route");
  return POST(
    req("POST", "/api/medications", {
      name: "Tamiflu",
      dose: "75 mg",
      ...(category ? { category } : {}),
      schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
    }),
  );
}

describe("custom medication categories", () => {
  it("files a medication under an own category and publishes its label", async () => {
    const key = await createCategory("  Travel kit ");
    expect(key).toMatch(/^custom:[0-9a-f-]{36}$/);

    const created = await createMedication(key);
    const createdBody = await created.json();
    expect(created.status, JSON.stringify(createdBody)).toBe(201);
    expect(createdBody.data.category).toBe(key);
    expect(createdBody.data.categoryLabel).toBe("Travel kit");

    const { GET: list } = await import("@/app/api/medications/route");
    const listBody = await (await list()).json();
    expect(listBody.data[0]).toMatchObject({
      category: key,
      categoryLabel: "Travel kit",
    });

    const { GET: detail } = await import("@/app/api/medications/[id]/route");
    const detailBody = await (
      await detail(req("GET", `/api/medications/${createdBody.data.id}`), {
        params: Promise.resolve({ id: createdBody.data.id }),
      })
    ).json();
    expect(detailBody.data).toMatchObject({
      category: key,
      categoryLabel: "Travel kit",
    });

    const { GET: categories } =
      await import("@/app/api/medications/categories/route");
    const categoriesBody = await (await categories()).json();
    expect(categoriesBody.data.categories).toEqual([
      {
        key,
        label: "Travel kit",
        sortOrder: 0,
        isActive: true,
        medicationCount: 1,
      },
    ]);

    // The label is ciphertext at rest.
    const row =
      await getPrismaClient().medicationCategoryLabel.findUniqueOrThrow({
        where: { key },
      });
    expect(Buffer.from(row.labelEncrypted).toString("utf8")).not.toContain(
      "Travel kit",
    );
  });

  it("refuses another account's key on create and on update", async () => {
    await signIn(OTHER_USER);
    const foreignKey = await createCategory("Theirs");
    await signIn(OWNER);

    const refused = await createMedication(foreignKey);
    const refusedBody = await refused.json();
    expect(refused.status).toBe(422);
    expect(refusedBody.meta.errorCode).toBe("medications.category.unknown");
    expect(await getPrismaClient().medication.count()).toBe(0);

    const ok = await createMedication("VITAMIN");
    const okBody = await ok.json();
    const { PUT } = await import("@/app/api/medications/[id]/route");
    const updated = await PUT(
      req("PUT", `/api/medications/${okBody.data.id}`, {
        category: foreignKey,
      }),
      { params: Promise.resolve({ id: okBody.data.id }) },
    );
    expect(updated.status).toBe(422);
    expect((await updated.json()).meta.errorCode).toBe(
      "medications.category.unknown",
    );
    const assignment =
      await getPrismaClient().medicationCategoryAssignment.findUniqueOrThrow({
        where: { medicationId: okBody.data.id },
      });
    expect(assignment.category).toBe("VITAMIN");
  });

  it("keeps the category on an update that does not name it", async () => {
    const key = await createCategory("Heart");
    const created = await (await createMedication(key)).json();
    const { PUT } = await import("@/app/api/medications/[id]/route");
    const res = await PUT(
      req("PUT", `/api/medications/${created.data.id}`, { name: "Renamed" }),
      { params: Promise.resolve({ id: created.data.id }) },
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ category: key, categoryLabel: "Heart" });
  });

  it("keeps a custom category when an older iPhone build sends OTHER back", async () => {
    const key = await createCategory("Heart");
    const created = await (await createMedication(key)).json();
    const { hashToken } = await import("@/lib/auth/hmac");
    const raw = "hlk_custom-category-native-0000";
    await getPrismaClient().apiToken.create({
      data: {
        userId: OWNER,
        name: "native",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });
    cookieJar.clear();
    headerJar.set("authorization", `Bearer ${raw}`);
    const { PUT } = await import("@/app/api/medications/[id]/route");
    const res = await PUT(
      req("PUT", `/api/medications/${created.data.id}`, {
        name: "Renamed",
        category: "OTHER",
      }),
      { params: Promise.resolve({ id: created.data.id }) },
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ category: key, categoryLabel: "Heart" });
    headerJar.clear();
    await signIn(OWNER);
  });

  it("moves a custom category back to OTHER when the web asks", async () => {
    const key = await createCategory("Heart");
    const created = await (await createMedication(key)).json();
    const { PUT } = await import("@/app/api/medications/[id]/route");
    const res = await PUT(
      req("PUT", `/api/medications/${created.data.id}`, { category: "OTHER" }),
      { params: Promise.resolve({ id: created.data.id }) },
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data.category).toBe("OTHER");
  });

  it("renames, hides and caps", async () => {
    const key = await createCategory("Heart");
    const { PATCH } =
      await import("@/app/api/medications/categories/[key]/route");
    const res = await PATCH(
      req("PATCH", `/api/medications/categories/${key}`, {
        label: "Heart and vessels",
        isActive: false,
        sortOrder: 4,
      }),
      { params: Promise.resolve({ key }) },
    );
    expect(await res.json()).toMatchObject({
      data: {
        key,
        label: "Heart and vessels",
        isActive: false,
        sortOrder: 4,
        medicationCount: 0,
      },
    });

    // Hidden ones count toward the cap: nineteen more fill it.
    for (let i = 0; i < 19; i += 1) await createCategory(`Group ${i}`);
    const { POST } = await import("@/app/api/medications/categories/route");
    const over = await POST(
      req("POST", "/api/medications/categories", { label: "One too many" }),
    );
    expect(over.status).toBe(422);
    expect((await over.json()).meta.errorCode).toBe(
      "medications.category.limitReached",
    );
  });

  it("does not let one account rename or delete another's category", async () => {
    await signIn(OTHER_USER);
    const foreignKey = await createCategory("Theirs");
    await signIn(OWNER);
    const { PATCH, DELETE } =
      await import("@/app/api/medications/categories/[key]/route");
    const patched = await PATCH(
      req("PATCH", `/api/medications/categories/${foreignKey}`, {
        label: "Mine now",
      }),
      { params: Promise.resolve({ key: foreignKey }) },
    );
    expect(patched.status).toBe(404);
    const deleted = await DELETE(
      req("DELETE", `/api/medications/categories/${foreignKey}`),
      { params: Promise.resolve({ key: foreignKey }) },
    );
    expect(deleted.status).toBe(404);
    expect(
      await getPrismaClient().medicationCategoryLabel.count({
        where: { key: foreignKey },
      }),
    ).toBe(1);
  });

  it("moves the medications of a deleted category to OTHER", async () => {
    const key = await createCategory("Short courses");
    const first = await (await createMedication(key)).json();
    const second = await (await createMedication(key)).json();
    const untouched = await (await createMedication("THYROID")).json();

    const { DELETE } =
      await import("@/app/api/medications/categories/[key]/route");
    const res = await DELETE(
      req("DELETE", `/api/medications/categories/${key}`),
      { params: Promise.resolve({ key }) },
    );
    expect(await res.json()).toEqual({
      data: { key, movedCount: 2 },
      error: null,
    });

    const rows = await getPrismaClient().medicationCategoryAssignment.findMany({
      orderBy: { medicationId: "asc" },
    });
    const byId = Object.fromEntries(
      rows.map((r) => [r.medicationId, r.category]),
    );
    // The stored value itself, not what a read resolves it to: a dangling key
    // would also READ as OTHER, which is exactly what this must not rely on.
    expect(byId[first.data.id]).toBe("OTHER");
    expect(byId[second.data.id]).toBe("OTHER");
    expect(byId[untouched.data.id]).toBe("THYROID");
    expect(rows.filter((r) => r.category.startsWith("custom:"))).toEqual([]);
  });

  it("reads a key with no label as OTHER", async () => {
    const created = await (await createMedication("VITAMIN")).json();
    await getPrismaClient().medicationCategoryAssignment.update({
      where: { medicationId: created.data.id },
      data: { category: "custom:00000000-0000-4000-8000-000000000000" },
    });
    const { GET } = await import("@/app/api/medications/[id]/route");
    const body = await (
      await GET(req("GET", `/api/medications/${created.data.id}`), {
        params: Promise.resolve({ id: created.data.id }),
      })
    ).json();
    expect(body.data).toMatchObject({ category: "OTHER", categoryLabel: null });
  });
});
