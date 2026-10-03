/**
 * v1.40 (#1041) — the one helper that resolves and writes a medication's
 * category. Prisma is stubbed; the real-database contract lives in
 * `tests/integration/medication-custom-categories.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assignmentFindMany: vi.fn(),
  assignmentUpsert: vi.fn(),
  assignmentUpdateMany: vi.fn(),
  labelFindMany: vi.fn(),
  labelFindFirst: vi.fn(),
  labelDelete: vi.fn(),
  medicationFindUnique: vi.fn(),
  annotate: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/db", () => {
  const client = {
    medicationCategoryAssignment: {
      findMany: mocks.assignmentFindMany,
      upsert: mocks.assignmentUpsert,
      updateMany: mocks.assignmentUpdateMany,
    },
    medicationCategoryLabel: {
      findMany: mocks.labelFindMany,
      findFirst: mocks.labelFindFirst,
      delete: mocks.labelDelete,
    },
    medication: { findUnique: mocks.medicationFindUnique },
  };
  return {
    prisma: {
      ...client,
      $transaction: async (fn: (tx: typeof client) => unknown) => fn(client),
    },
  };
});
vi.mock("@/lib/logging/context", () => ({ annotate: mocks.annotate }));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(`sealed:${s}`),
  decryptFromBytes: (b: Uint8Array) =>
    new TextDecoder().decode(b).replace(/^sealed:/, ""),
}));

import {
  deleteMedicationCategoryLabel,
  isAssignableCategory,
  resolveMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";

const OWN = "custom:11111111-1111-4111-8111-111111111111";
const FOREIGN = "custom:22222222-2222-4222-8222-222222222222";
const GONE = "custom:33333333-3333-4333-8333-333333333333";
const sealed = (s: string) => new TextEncoder().encode(`sealed:${s}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
});

describe("resolveMedicationCategories", () => {
  it("resolves built-ins, the owner's own key with its label, and nothing else", async () => {
    mocks.assignmentFindMany.mockResolvedValue([
      { medicationId: "m1", category: "THYROID", medication: { userId: "u1" } },
      { medicationId: "m2", category: OWN, medication: { userId: "u1" } },
      { medicationId: "m3", category: FOREIGN, medication: { userId: "u1" } },
      { medicationId: "m4", category: GONE, medication: { userId: "u1" } },
      {
        medicationId: "m5",
        category: "NOT_A_VALUE",
        medication: { userId: "u1" },
      },
    ]);
    mocks.labelFindMany.mockResolvedValue([
      { key: OWN, userId: "u1", labelEncrypted: sealed("Travel kit") },
      { key: FOREIGN, userId: "u2", labelEncrypted: sealed("Theirs") },
    ]);

    const result = await resolveMedicationCategories([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);

    expect(result).toEqual({
      m1: { category: "THYROID", categoryLabel: null },
      m2: { category: OWN, categoryLabel: "Travel kit" },
      // Another account's label never resolves, even by its exact key.
      m3: { category: "OTHER", categoryLabel: null },
      m4: { category: "OTHER", categoryLabel: null },
      m5: { category: "OTHER", categoryLabel: null },
      // No row at all reads as OTHER.
      m6: { category: "OTHER", categoryLabel: null },
    });
    // The two custom keys that resolved to nothing are counted, not thrown.
    expect(mocks.annotate).toHaveBeenCalledWith({
      meta: { "medication.category.dangling": 2 },
    });
  });

  it("skips the label read when no custom key is in play", async () => {
    mocks.assignmentFindMany.mockResolvedValue([
      { medicationId: "m1", category: "VITAMIN", medication: { userId: "u1" } },
    ]);
    await resolveMedicationCategories(["m1"]);
    expect(mocks.labelFindMany).not.toHaveBeenCalled();
    expect(mocks.annotate).not.toHaveBeenCalled();
  });
});

describe("isAssignableCategory / setMedicationCategory", () => {
  it("admits built-ins and the owner's own key only", async () => {
    mocks.labelFindFirst.mockImplementation(
      async ({ where }: { where: { key: string; userId: string } }) =>
        where.key === OWN && where.userId === "u1" ? { key: OWN } : null,
    );
    expect(await isAssignableCategory("u1", "MENTAL_HEALTH")).toBe(true);
    expect(await isAssignableCategory("u1", OWN)).toBe(true);
    expect(await isAssignableCategory("u1", FOREIGN)).toBe(false);
    expect(await isAssignableCategory("u1", "custom")).toBe(false);
    expect(await isAssignableCategory("u1", "PIZZA")).toBe(false);
  });

  it("writes OTHER for a key the medication's owner does not hold", async () => {
    mocks.medicationFindUnique.mockResolvedValue({ userId: "u1" });
    mocks.labelFindFirst.mockResolvedValue(null);
    const written = await setMedicationCategory("m1", FOREIGN);
    expect(written).toBe("OTHER");
    expect(mocks.assignmentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { medicationId: "m1", category: "OTHER" },
        update: { category: "OTHER" },
      }),
    );
  });

  it("writes the owner's own key", async () => {
    mocks.medicationFindUnique.mockResolvedValue({ userId: "u1" });
    mocks.labelFindFirst.mockResolvedValue({ key: OWN });
    expect(await setMedicationCategory("m1", OWN)).toBe(OWN);
  });
});

describe("deleteMedicationCategoryLabel", () => {
  it("moves the category's medications to OTHER before the label goes", async () => {
    mocks.labelFindFirst.mockResolvedValue({ id: "label-1" });
    mocks.assignmentUpdateMany.mockImplementation(async () => {
      mocks.order.push("move");
      return { count: 3 };
    });
    mocks.labelDelete.mockImplementation(async () => {
      mocks.order.push("delete");
      return {};
    });

    const result = await deleteMedicationCategoryLabel("u1", OWN);

    expect(result).toEqual({ movedCount: 3 });
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith({
      where: { category: OWN, medication: { userId: "u1" } },
      data: { category: "OTHER" },
    });
    expect(mocks.order).toEqual(["move", "delete"]);
  });

  it("answers null and touches nothing for a key that is not the caller's", async () => {
    mocks.labelFindFirst.mockResolvedValue(null);
    expect(await deleteMedicationCategoryLabel("u1", FOREIGN)).toBeNull();
    expect(mocks.assignmentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.labelDelete).not.toHaveBeenCalled();
  });
});
