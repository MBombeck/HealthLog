/**
 * The effective mood-tag taxonomy an account sees (`GET /api/mood/tags`), the
 * catalogue tags it hides (`PUT /api/mood/tags/{key}/hidden`) and the layout
 * it arranges them in (`/api/mood/tags/layout`), against the real database
 * and through the real API kit.
 *
 * The catalogue is reference data the migrations seed; the truncate between
 * tests puts it back, so every case reads the catalogue a fresh install
 * holds. Tags are picked from it by query rather than by name, because the
 * migrations retire and revive catalogue tags over time.
 *
 * What is pinned:
 *   - the read carries every live catalogue tag with its rated-factor
 *     metadata, the caller's own tags and groups with their labels unsealed,
 *     and nothing of another account's;
 *   - a hidden catalogue tag leaves the plain read and comes back flagged
 *     under `?include=hidden`; hiding is per account and idempotent;
 *   - the layout orders the groups and places catalogue tags into the
 *     caller's own groups without moving their stored category, and a stale
 *     entry is dropped at read time;
 *   - `?include=archived` returns the caller's retired tags and empty groups,
 *     never a retired catalogue tag; `?include=usage` counts the caller's
 *     live entries only;
 *   - the layout write merges what it is sent over what is stored, and a
 *     write against a stale token is refused without touching the row.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { MoodTag } from "@/generated/prisma/client";
import { GET as readTags } from "@/app/api/mood/tags/route";
import { PUT as putHidden } from "@/app/api/mood/tags/[key]/hidden/route";
import {
  GET as readLayout,
  PUT as putLayout,
} from "@/app/api/mood/tags/layout/route";

import { anonymous, callRoute } from "../../kit/call-route";
import {
  makeSession,
  makeUser,
  type SessionFixture,
} from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";
import {
  makeCustomGroup,
  makeCustomTag,
  makeMoodEntry,
} from "./mood-tag-fixtures";

const prisma = getPrismaClient();

interface TagOut {
  key: string;
  labelKey: string | null;
  label: string | null;
  icon: string | null;
  kind: string;
  scaleMin: number;
  scaleMax: number;
  inverse: boolean;
  custom: boolean;
  hidden?: boolean;
  archived?: boolean;
  usageCount?: number;
}

interface CategoryOut {
  key: string;
  labelKey: string | null;
  label: string | null;
  icon: string | null;
  custom: boolean;
  tags: TagOut[];
}

interface Layout {
  groupOrder: string[];
  placements: Record<string, string[]>;
  updatedAt?: string;
}

async function read(
  auth: SessionFixture,
  include?: string,
): Promise<CategoryOut[]> {
  const res = await callRoute<{ categories: CategoryOut[] }>(readTags, {
    method: "GET",
    route: "/api/mood/tags",
    query: { include },
    auth,
  });
  expect(res.status).toBe(200);
  return res.data.categories;
}

function tagsByKey(categories: CategoryOut[]): Map<string, TagOut> {
  return new Map(categories.flatMap((c) => c.tags.map((t) => [t.key, t])));
}

function category(
  categories: CategoryOut[],
  key: string,
): CategoryOut | undefined {
  return categories.find((c) => c.key === key);
}

/** The live catalogue as the migrations left it, with each tag's category. */
async function liveCatalogue() {
  return prisma.moodTag.findMany({
    where: {
      userId: null,
      isActive: true,
      category: { userId: null, isActive: true },
    },
    include: { category: true },
    orderBy: { sortOrder: "asc" },
  });
}

/** Two live catalogue tags that share a seeded category. */
async function twoSiblings(): Promise<{
  categoryKey: string;
  first: MoodTag;
  second: MoodTag;
}> {
  const tags = await liveCatalogue();
  for (const tag of tags) {
    const sibling = tags.find(
      (t) => t.categoryId === tag.categoryId && t.id !== tag.id,
    );
    if (sibling) {
      return { categoryKey: tag.category.key, first: tag, second: sibling };
    }
  }
  throw new Error("the seeded catalogue has no category with two live tags");
}

async function storedLayout(userId: string): Promise<unknown> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
    .moodTagLayoutJson;
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("GET /api/mood/tags", () => {
  it("serves the seeded catalogue to an account with nothing of its own", async () => {
    const owner = await makeUser();
    const catalogue = await liveCatalogue();
    expect(catalogue.length).toBeGreaterThan(0);

    const categories = await read(await makeSession(owner));

    const tags = tagsByKey(categories);
    expect(new Set(tags.keys())).toEqual(new Set(catalogue.map((t) => t.key)));
    for (const row of catalogue) {
      expect(tags.get(row.key)).toEqual({
        key: row.key,
        labelKey: row.labelKey,
        label: null,
        icon: row.icon,
        kind: row.kind,
        scaleMin: row.scaleMin,
        scaleMax: row.scaleMax,
        inverse: row.inverse,
        custom: false,
      });
    }
    // Every category is a seeded one and holds at least one tag: the seeded
    // `custom` category, empty for this account, is left out.
    expect(new Set(categories.map((c) => c.key))).toEqual(
      new Set(catalogue.map((t) => t.category.key)),
    );
    expect(category(categories, "custom")).toBeUndefined();
    for (const c of categories) {
      expect(c).toMatchObject({ custom: false, label: null });
      expect(c.labelKey).not.toBeNull();
    }
  });

  it("carries the rated-factor metadata of a rated catalogue tag", async () => {
    const owner = await makeUser();
    const rated = (await liveCatalogue()).find((t) => t.kind === "RATED");
    expect(rated).toBeDefined();

    const tags = tagsByKey(await read(await makeSession(owner)));

    expect(tags.get(rated!.key)).toMatchObject({
      kind: "RATED",
      scaleMin: rated!.scaleMin,
      scaleMax: rated!.scaleMax,
      inverse: rated!.inverse,
    });
  });

  it("merges in the caller's own tags and groups with their labels, and nothing of another account's", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const group = await makeCustomGroup(owner, "Therapy", {
      icon: "Stethoscope",
    });
    const inGroup = await makeCustomTag(owner, "Session", {
      categoryId: group.id,
      icon: "Heart",
    });
    const plain = await makeCustomTag(owner, "Migraine");
    const theirGroup = await makeCustomGroup(other, "Theirs");
    const theirTag = await makeCustomTag(other, "Private");
    await makeCustomTag(other, "Private grouped", {
      categoryId: theirGroup.id,
    });

    const categories = await read(await makeSession(owner));

    expect(category(categories, group.key)).toEqual({
      key: group.key,
      labelKey: null,
      label: "Therapy",
      icon: "Stethoscope",
      custom: true,
      tags: [
        {
          key: inGroup.key,
          labelKey: null,
          label: "Session",
          icon: "Heart",
          kind: "BINARY",
          scaleMin: 1,
          scaleMax: 5,
          inverse: false,
          custom: true,
        },
      ],
    });
    expect(category(categories, "custom")?.tags.map((t) => t.key)).toEqual([
      plain.key,
    ]);
    expect(tagsByKey(categories).get(plain.key)).toMatchObject({
      label: "Migraine",
      labelKey: null,
      custom: true,
    });
    expect(category(categories, theirGroup.key)).toBeUndefined();
    expect(tagsByKey(categories).has(theirTag.key)).toBe(false);
  });

  it("refuses an anonymous caller", async () => {
    const res = await callRoute(readTags, {
      method: "GET",
      route: "/api/mood/tags",
      auth: anonymous,
    });

    expect(res.status).toBe(401);
  });
});

describe("PUT /api/mood/tags/{key}/hidden", () => {
  it("hides a catalogue tag from the caller's read only, and shows it again", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { first } = await twoSiblings();
    const auth = await makeSession(owner);
    const own = await makeCustomTag(owner, "Mine");

    for (let i = 0; i < 2; i++) {
      const res = await callRoute(putHidden, {
        method: "PUT",
        route: "/api/mood/tags/{key}/hidden",
        params: { key: first.key },
        body: { hidden: true },
        auth,
      });
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ key: first.key, hidden: true });
    }
    // Hiding twice keeps one row, and the catalogue row is untouched.
    expect(
      await prisma.moodTagHidden.findMany({ where: { userId: owner.id } }),
    ).toEqual([expect.objectContaining({ moodTagId: first.id })]);
    expect(
      (await prisma.moodTag.findUniqueOrThrow({ where: { id: first.id } }))
        .isActive,
    ).toBe(true);

    expect(tagsByKey(await read(auth)).has(first.key)).toBe(false);
    const withHidden = tagsByKey(await read(auth, "hidden"));
    expect(withHidden.get(first.key)?.hidden).toBe(true);
    const visible = [...withHidden.values()].filter(
      (t) => !t.custom && t.key !== first.key,
    );
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((t) => t.hidden === false)).toBe(true);
    // A custom tag never carries the flag; it hides through its own isActive.
    expect(withHidden.get(own.key)).not.toHaveProperty("hidden");
    // Another account still sees the tag.
    expect(tagsByKey(await read(await makeSession(other))).has(first.key)).toBe(
      true,
    );

    const shown = await callRoute(putHidden, {
      method: "PUT",
      route: "/api/mood/tags/{key}/hidden",
      params: { key: first.key },
      body: { hidden: false },
      auth,
    });
    expect(shown.status).toBe(200);
    expect(
      await prisma.moodTagHidden.count({ where: { userId: owner.id } }),
    ).toBe(0);
    expect(tagsByKey(await read(auth)).has(first.key)).toBe(true);
  });

  it("refuses a custom key with 400, an unknown key with 404, and a malformed body with 422", async () => {
    const owner = await makeUser();
    const own = await makeCustomTag(owner, "Mine");
    const { first } = await twoSiblings();
    const auth = await makeSession(owner);

    const custom = await callRoute(putHidden, {
      method: "PUT",
      route: "/api/mood/tags/{key}/hidden",
      params: { key: own.key },
      body: { hidden: true },
      auth,
    });
    const unknown = await callRoute(putHidden, {
      method: "PUT",
      route: "/api/mood/tags/{key}/hidden",
      params: { key: "no_such_tag" },
      body: { hidden: true },
      auth,
    });
    const malformed = await callRoute(putHidden, {
      method: "PUT",
      route: "/api/mood/tags/{key}/hidden",
      params: { key: first.key },
      body: { hidden: "yes" },
      auth,
    });

    expect(custom.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(422);
    expect(
      await prisma.moodTagHidden.count({ where: { userId: owner.id } }),
    ).toBe(0);
  });
});

describe("the layout on the read", () => {
  it("orders the groups and places a catalogue tag into the caller's group without moving it", async () => {
    const owner = await makeUser();
    const { categoryKey, first, second } = await twoSiblings();
    const group = await makeCustomGroup(owner, "Therapy");
    await prisma.user.update({
      where: { id: owner.id },
      data: {
        moodTagLayoutJson: {
          groupOrder: [group.key, categoryKey],
          placements: { [group.key]: [first.key] },
        },
      },
    });

    const categories = await read(await makeSession(owner));

    expect(categories.slice(0, 2).map((c) => c.key)).toEqual([
      group.key,
      categoryKey,
    ]);
    expect(category(categories, group.key)?.tags.map((t) => t.key)).toEqual([
      first.key,
    ]);
    const home = category(categories, categoryKey)?.tags.map((t) => t.key);
    expect(home).not.toContain(first.key);
    expect(home).toContain(second.key);
    // Placement is display only: the stored category is the seeded one.
    expect(
      (await prisma.moodTag.findUniqueOrThrow({ where: { id: first.id } }))
        .categoryId,
    ).toBe(first.categoryId);
  });

  it("drops a placement of a hidden or unknown tag, and the group it leaves empty", async () => {
    const owner = await makeUser();
    const { first } = await twoSiblings();
    const group = await makeCustomGroup(owner, "Therapy");
    await prisma.moodTagHidden.create({
      data: { userId: owner.id, moodTagId: first.id },
    });
    await prisma.user.update({
      where: { id: owner.id },
      data: {
        moodTagLayoutJson: {
          placements: { [group.key]: [first.key, "ghost"] },
        },
      },
    });

    const categories = await read(await makeSession(owner));

    expect(category(categories, group.key)).toBeUndefined();
    expect(tagsByKey(categories).has(first.key)).toBe(false);
    expect(tagsByKey(categories).has("ghost")).toBe(false);
  });
});

describe("GET /api/mood/tags with include", () => {
  it("returns the caller's retired tags flagged and its empty groups under archived, never a retired catalogue tag", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const active = await makeCustomTag(owner, "Active");
    const retired = await makeCustomTag(owner, "Retired", { isActive: false });
    const empty = await makeCustomGroup(owner, "Empty");
    const theirRetired = await makeCustomTag(other, "Theirs", {
      isActive: false,
    });
    const retiredCatalogue = await prisma.moodTag.findFirst({
      where: { userId: null, isActive: false },
    });
    const auth = await makeSession(owner);

    const plain = tagsByKey(await read(auth));
    expect(plain.has(retired.key)).toBe(false);

    const categories = await read(auth, "hidden,archived");
    const tags = tagsByKey(categories);
    expect(tags.get(retired.key)).toMatchObject({
      custom: true,
      archived: true,
      label: "Retired",
    });
    expect(tags.get(active.key)).toMatchObject({ archived: false });
    expect(tags.has(theirRetired.key)).toBe(false);
    // The migrations retire catalogue tags; one of them must stay retired.
    expect(retiredCatalogue).not.toBeNull();
    expect(tags.has(retiredCatalogue!.key)).toBe(false);
    const catalogueTag = [...tags.values()].find((t) => !t.custom);
    expect(catalogueTag).not.toHaveProperty("archived");
    expect(category(categories, empty.key)).toMatchObject({
      custom: true,
      label: "Empty",
      tags: [],
    });
  });

  it("counts each tag's use over the caller's live entries only under usage", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const { first, second } = await twoSiblings();
    const own = await makeCustomTag(owner, "Mine");
    await makeMoodEntry(owner, [first, own]);
    await makeMoodEntry(owner, [first]);
    await makeMoodEntry(owner, [first, second], { deletedAt: new Date() });
    await makeMoodEntry(other, [first, second]);

    const tags = tagsByKey(await read(await makeSession(owner), "usage"));

    expect(tags.get(first.key)?.usageCount).toBe(2);
    expect(tags.get(second.key)?.usageCount).toBe(0);
    expect(tags.get(own.key)?.usageCount).toBe(1);
    // The plain read carries no count.
    expect(
      tagsByKey(await read(await makeSession(owner))).get(first.key),
    ).not.toHaveProperty("usageCount");
  });
});

describe("GET /api/mood/tags/layout", () => {
  it("resolves the seeded order with the caller's groups when nothing is stored", async () => {
    const owner = await makeUser();
    const group = await makeCustomGroup(owner, "Therapy", { sortOrder: 500 });
    await makeCustomGroup(await makeUser(), "Theirs");
    const seeded = await prisma.moodTagCategory.findMany({
      where: { userId: null, isActive: true },
      orderBy: { sortOrder: "asc" },
    });

    const res = await callRoute<Layout>(readLayout, {
      method: "GET",
      route: "/api/mood/tags/layout",
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    expect(res.data.groupOrder).toEqual([
      ...seeded.map((c) => c.key),
      group.key,
    ]);
    expect(res.data.placements).toEqual({});
    // The account's row always exists, so the read always carries a token.
    expect(res.data.updatedAt).toBe(
      (
        await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })
      ).moodTagLayoutRevisedAt.toISOString(),
    );
  });

  it("puts the stored order first, drops unknown keys and appends the rest", async () => {
    const owner = await makeUser();
    const group = await makeCustomGroup(owner, "Therapy");
    const seeded = await prisma.moodTagCategory.findMany({
      where: { userId: null, isActive: true },
      orderBy: { sortOrder: "asc" },
    });
    const last = seeded[seeded.length - 1]!.key;
    await prisma.user.update({
      where: { id: owner.id },
      data: {
        moodTagLayoutJson: {
          groupOrder: [group.key, "ghost", last],
          placements: { [group.key]: ["some_tag"] },
        },
      },
    });

    const res = await callRoute<Layout>(readLayout, {
      method: "GET",
      route: "/api/mood/tags/layout",
      auth: await makeSession(owner),
    });

    expect(res.data.groupOrder).toEqual([
      group.key,
      last,
      ...seeded.map((c) => c.key).filter((k) => k !== last),
    ]);
    expect(res.data.placements).toEqual({ [group.key]: ["some_tag"] });
  });
});

describe("PUT /api/mood/tags/layout", () => {
  it("keeps the stored placements on an order-only write, and the order on a placements-only write", async () => {
    const owner = await makeUser();
    const auth = await makeSession(owner);
    await prisma.user.update({
      where: { id: owner.id },
      data: { moodTagLayoutJson: { placements: { feelings: ["sad"] } } },
    });

    const ordered = await callRoute<Layout>(putLayout, {
      method: "PUT",
      route: "/api/mood/tags/layout",
      body: { groupOrder: ["custom", "feelings"] },
      auth,
    });
    expect(ordered.status).toBe(200);
    expect(ordered.data.groupOrder.slice(0, 2)).toEqual(["custom", "feelings"]);
    expect(ordered.data.placements).toEqual({ feelings: ["sad"] });
    expect(await storedLayout(owner.id)).toEqual({
      groupOrder: ["custom", "feelings"],
      placements: { feelings: ["sad"] },
    });

    const placed = await callRoute<Layout>(putLayout, {
      method: "PUT",
      route: "/api/mood/tags/layout",
      body: { placements: { custom: ["tired"] } },
      auth,
    });
    expect(placed.status).toBe(200);
    expect(await storedLayout(owner.id)).toEqual({
      groupOrder: ["custom", "feelings"],
      placements: { custom: ["tired"] },
    });

    // The next read answers what was written.
    const back = await callRoute<Layout>(readLayout, {
      method: "GET",
      route: "/api/mood/tags/layout",
      auth,
    });
    expect(back.data).toEqual(placed.data);
  });

  it("writes against a current token, refuses a stale one with 409, and leaves the row as the first writer left it", async () => {
    const owner = await makeUser();
    const auth = await makeSession(owner);
    const loaded = await callRoute<Layout>(readLayout, {
      method: "GET",
      route: "/api/mood/tags/layout",
      auth,
    });
    const base = loaded.data.updatedAt;
    expect(base).toBeDefined();

    const first = await callRoute<Layout>(putLayout, {
      method: "PUT",
      route: "/api/mood/tags/layout",
      body: { groupOrder: ["custom"], baseUpdatedAt: base },
      auth,
    });
    expect(first.status).toBe(200);
    expect(Date.parse(first.data.updatedAt ?? "")).toBeGreaterThan(
      Date.parse(base ?? ""),
    );

    // A second card loaded the same version and writes the other field.
    const second = await callRoute(putLayout, {
      method: "PUT",
      route: "/api/mood/tags/layout",
      body: { placements: { custom: ["tired"] }, baseUpdatedAt: base },
      auth,
    });
    expect(second.status).toBe(409);
    expect(second.meta?.errorCode).toBe("mood_tag_layout_conflict");
    expect(await storedLayout(owner.id)).toEqual({ groupOrder: ["custom"] });

    // Retried against the token the first write answered with, it lands.
    const retried = await callRoute<Layout>(putLayout, {
      method: "PUT",
      route: "/api/mood/tags/layout",
      body: {
        placements: { custom: ["tired"] },
        baseUpdatedAt: first.data.updatedAt,
      },
      auth,
    });
    expect(retried.status).toBe(200);
    expect(await storedLayout(owner.id)).toEqual({
      groupOrder: ["custom"],
      placements: { custom: ["tired"] },
    });
  });

  it("writes unconditionally without a token", async () => {
    const owner = await makeUser();
    const auth = await makeSession(owner);
    await prisma.user.update({
      where: { id: owner.id },
      data: { moodTagLayoutJson: { groupOrder: ["feelings"] } },
    });

    const res = await callRoute<Layout>(putLayout, {
      method: "PUT",
      route: "/api/mood/tags/layout",
      body: { groupOrder: ["custom", "feelings"] },
      auth,
    });

    expect(res.status).toBe(200);
    expect(res.data.updatedAt).toBe(
      (
        await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })
      ).moodTagLayoutRevisedAt.toISOString(),
    );
    expect(await storedLayout(owner.id)).toEqual({
      groupOrder: ["custom", "feelings"],
    });
  });

  it("refuses a malformed token, an over-long order and a malformed order without writing", async () => {
    const owner = await makeUser();
    const auth = await makeSession(owner);
    const stored = { groupOrder: ["feelings"] };
    await prisma.user.update({
      where: { id: owner.id },
      data: { moodTagLayoutJson: stored },
    });

    const token = await callRoute(putLayout, {
      method: "PUT",
      route: "/api/mood/tags/layout",
      body: { groupOrder: ["custom"], baseUpdatedAt: "not-a-date" },
      auth,
    });
    expect(token.status).toBe(422);
    expect(token.meta?.errorCode).toBe("invalid_base_updated_at");

    for (const groupOrder of [
      Array.from({ length: 51 }, (_, i) => `g${i}`),
      "feelings",
    ]) {
      const res = await callRoute(putLayout, {
        method: "PUT",
        route: "/api/mood/tags/layout",
        body: { groupOrder },
        auth,
      });
      expect(res.status).toBe(422);
    }
    expect(await storedLayout(owner.id)).toEqual(stored);
  });
});
