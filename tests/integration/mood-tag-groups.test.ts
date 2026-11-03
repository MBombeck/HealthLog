/**
 * v1.17.0 — custom mood-tag groups + per-user layout against real Postgres.
 *
 * Pins the group lifecycle the unit mocks can't:
 *   - group create (encrypted label round-trip via the effective read),
 *     cap 422, cross-user 404 on PATCH/DELETE
 *   - custom-tag create into an own group via `categoryKey` (and the 422 on
 *     a foreign group key)
 *   - group delete: own tags re-home to the seeded `custom` category, the
 *     layout blob drops the group, default = retire vs `?purge=true` =
 *     hard delete of the emptied row
 *   - layout PUT preserve-when-absent + the resolved GET tree honouring
 *     group order and a catalogue-tag placement
 *   - `include=archived` surfacing an archived custom tag
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER_A = "user-mtg-a";
const USER_B = "user-mtg-b";

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

async function createUserSession(userId: string, username: string) {
  await getPrismaClient().user.create({
    data: {
      id: userId,
      username,
      email: `${username}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
  return getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
}

async function actAs(userId: string, username: string) {
  const session = await createUserSession(userId, username);
  cookieJar.set("healthlog_session", session.id);
}

function jsonReq(url: string, method: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const params = (key: string) => ({ params: Promise.resolve({ key }) });

async function createGroup(label: string, icon?: string): Promise<string> {
  const { POST } = await import("@/app/api/mood/tags/groups/route");
  const res = await POST(
    jsonReq("http://localhost/api/mood/tags/groups", "POST", { label, icon }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { key: string } };
  return body.data.key;
}

async function createTag(label: string, categoryKey?: string): Promise<string> {
  const { POST } = await import("@/app/api/mood/tags/custom/route");
  const res = await POST(
    jsonReq("http://localhost/api/mood/tags/custom", "POST", {
      label,
      ...(categoryKey ? { categoryKey } : {}),
    }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { key: string } };
  return body.data.key;
}

interface TreeCategory {
  key: string;
  label: string | null;
  custom: boolean;
  tags: Array<{ key: string; label: string | null; archived?: boolean }>;
}

async function readTree(include?: string): Promise<TreeCategory[]> {
  const { GET } = await import("@/app/api/mood/tags/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/mood/tags${include ? `?include=${include}` : ""}`,
    ),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { categories: TreeCategory[] } };
  return body.data.categories;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
});

describe("custom mood-tag groups (real Postgres)", () => {
  it("exposes alcohol, caffeine, and nicotine from the built-in binary catalogue", async () => {
    await actAs(USER_A, "mtg-a");
    const tree = await readTree();
    const health = tree.find((category) => category.key === "health");
    expect(health).toBeDefined();
    expect(
      health!.tags
        .filter((tag) => ["alcohol", "caffeine", "nicotine"].includes(tag.key))
        .map((tag) => tag.key)
        .sort(),
    ).toEqual(["alcohol", "caffeine", "nicotine"]);

    const rows = await getPrismaClient().moodTag.findMany({
      where: { key: { in: ["alcohol", "caffeine", "nicotine"] } },
      select: { key: true, userId: true, kind: true, isActive: true },
      orderBy: { key: "asc" },
    });
    expect(rows).toEqual([
      { key: "alcohol", userId: null, kind: "BINARY", isActive: true },
      { key: "caffeine", userId: null, kind: "BINARY", isActive: true },
      { key: "nicotine", userId: null, kind: "BINARY", isActive: true },
    ]);
  });

  it("creates a group, stores the label encrypted, and resolves it on the management read", async () => {
    await actAs(USER_A, "mtg-a");
    const groupKey = await createGroup("Therapie", "Stethoscope");
    expect(groupKey.startsWith("customcat:")).toBe(true);

    const row = await getPrismaClient().moodTagCategory.findUnique({
      where: { key: groupKey },
    });
    expect(row?.userId).toBe(USER_A);
    expect(row?.labelEncrypted).not.toBeNull();
    expect(row?.labelEncrypted).not.toContain("Therapie");

    // Empty group surfaces only on a management read.
    const plain = await readTree();
    expect(plain.find((c) => c.key === groupKey)).toBeUndefined();
    const manage = await readTree("hidden,archived");
    expect(manage.find((c) => c.key === groupKey)).toMatchObject({
      custom: true,
      label: "Therapie",
      tags: [],
    });
  });

  it("422s over the 12-group cap", async () => {
    await actAs(USER_A, "mtg-a");
    for (let i = 0; i < 12; i++) await createGroup(`G${i}`);
    const { POST } = await import("@/app/api/mood/tags/groups/route");
    const res = await POST(
      jsonReq("http://localhost/api/mood/tags/groups", "POST", {
        label: "Nope",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("404s a cross-user PATCH / DELETE and a 422 on a foreign categoryKey", async () => {
    await actAs(USER_A, "mtg-a");
    const groupKey = await createGroup("Privat");

    await actAs(USER_B, "mtg-b");
    const { PATCH, DELETE } =
      await import("@/app/api/mood/tags/groups/[key]/route");
    const patch = await PATCH(
      jsonReq(`http://localhost/api/mood/tags/groups/${groupKey}`, "PATCH", {
        label: "Hijack",
      }),
      params(groupKey),
    );
    expect(patch.status).toBe(404);
    const del = await DELETE(
      new NextRequest(`http://localhost/api/mood/tags/groups/${groupKey}`),
      params(groupKey),
    );
    expect(del.status).toBe(404);

    // B cannot create a tag inside A's group either.
    const { POST } = await import("@/app/api/mood/tags/custom/route");
    const tag = await POST(
      jsonReq("http://localhost/api/mood/tags/custom", "POST", {
        label: "X",
        categoryKey: groupKey,
      }),
    );
    expect(tag.status).toBe(422);
  });

  it("group delete re-homes own tags, strips the layout, retires by default and purges on demand", async () => {
    await actAs(USER_A, "mtg-a");
    const groupKey = await createGroup("Hobbys 2");
    const tagKey = await createTag("Bouldern", groupKey);

    // Seed a layout that references the group.
    const { PUT: putLayout } = await import("@/app/api/mood/tags/layout/route");
    const layoutRes = await putLayout(
      jsonReq("http://localhost/api/mood/tags/layout", "PUT", {
        groupOrder: [groupKey, "feelings"],
        placements: { [groupKey]: ["grateful"] },
      }),
    );
    expect(layoutRes.status).toBe(200);

    const { DELETE } = await import("@/app/api/mood/tags/groups/[key]/route");
    const res = await DELETE(
      new NextRequest(`http://localhost/api/mood/tags/groups/${groupKey}`),
      params(groupKey),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { purged: boolean; rehomedCount: number };
    };
    expect(body.data).toMatchObject({ purged: false, rehomedCount: 1 });

    // The tag survived, re-homed to the seeded custom category.
    const tagRow = await getPrismaClient().moodTag.findUnique({
      where: { key: tagKey },
    });
    expect(tagRow?.categoryId).toBe("mtc_custom");
    // The group row is retired, not gone.
    const groupRow = await getPrismaClient().moodTagCategory.findUnique({
      where: { key: groupKey },
    });
    expect(groupRow?.isActive).toBe(false);
    // The layout no longer references the group.
    const userRow = await getPrismaClient().user.findUnique({
      where: { id: USER_A },
      select: { moodTagLayoutJson: true },
    });
    expect(JSON.stringify(userRow?.moodTagLayoutJson)).not.toContain(groupKey);

    // Purge a second (empty) group → the row is gone.
    const group2 = await createGroup("Weg damit");
    const purge = await DELETE(
      new NextRequest(
        `http://localhost/api/mood/tags/groups/${group2}?purge=true`,
      ),
      params(group2),
    );
    expect(purge.status).toBe(200);
    expect(
      await getPrismaClient().moodTagCategory.findUnique({
        where: { key: group2 },
      }),
    ).toBeNull();
  });

  it("layout PUT merges preserve-when-absent and the GET tree honours order + placement", async () => {
    await actAs(USER_A, "mtg-a");
    const groupKey = await createGroup("Sport");
    await createTag("Klettern", groupKey);

    const { PUT: putLayout, GET: getLayout } =
      await import("@/app/api/mood/tags/layout/route");
    // 1st PUT: placements only.
    await putLayout(
      jsonReq("http://localhost/api/mood/tags/layout", "PUT", {
        placements: { [groupKey]: ["grateful"] },
      }),
    );
    // 2nd PUT: groupOrder only — must keep the stored placements.
    await putLayout(
      jsonReq("http://localhost/api/mood/tags/layout", "PUT", {
        groupOrder: [groupKey],
      }),
    );
    const layoutRes = await getLayout();
    const layout = (await layoutRes.json()) as {
      data: { groupOrder: string[]; placements: Record<string, string[]> };
    };
    expect(layout.data.groupOrder[0]).toBe(groupKey);
    expect(layout.data.placements).toEqual({ [groupKey]: ["grateful"] });

    // The effective tree leads with the group and carries the placed
    // catalogue tag inside it (placement, not a categoryId change).
    const tree = await readTree();
    expect(tree[0].key).toBe(groupKey);
    expect(tree[0].tags.map((t) => t.key)).toContain("grateful");
    const gratefulRow = await getPrismaClient().moodTag.findUnique({
      where: { key: "grateful" },
      select: { category: { select: { key: true } } },
    });
    expect(gratefulRow?.category.key).not.toBe(groupKey);
  });

  it("include=archived surfaces an archived custom tag for restore", async () => {
    await actAs(USER_A, "mtg-a");
    const tagKey = await createTag("Alt");
    const { DELETE } = await import("@/app/api/mood/tags/custom/[key]/route");
    const res = await DELETE(
      new NextRequest(`http://localhost/api/mood/tags/custom/${tagKey}`),
      params(tagKey),
    );
    expect(res.status).toBe(200);

    const plain = await readTree();
    expect(
      plain.flatMap((c) => c.tags).find((t) => t.key === tagKey),
    ).toBeUndefined();

    const manage = await readTree("archived");
    const archived = manage
      .flatMap((c) => c.tags)
      .find((t) => t.key === tagKey);
    expect(archived).toMatchObject({ archived: true, label: "Alt" });
  });
});
