import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  CUSTOM_MEDICATION_CATEGORY_PREFIX,
  MEDICATION_CATEGORY_VALUES,
  isCustomMedicationCategoryKey,
} from "@/lib/validations/medication";

const MEDICATION_CATEGORIES = MEDICATION_CATEGORY_VALUES;

export type MedicationCategory = (typeof MEDICATION_CATEGORIES)[number];

/**
 * What a medication's `category` resolves to: a built-in value, or the
 * `custom:<uuid>` key of one of its owner's own categories.
 */
export type MedicationCategoryKey = MedicationCategory | `custom:${string}`;

export interface ResolvedMedicationCategory {
  category: MedicationCategoryKey;
  /** The decrypted label of a custom category; null for a built-in one. */
  categoryLabel: string | null;
}

const DEFAULT_CATEGORY: MedicationCategory = "OTHER";

/**
 * The client surface the helpers below need. The default is the shared
 * client; the backup builder and the restore pass their own (the restore's
 * transaction client, so a category row lands in the same transaction as
 * the medication it points at and its foreign key can see that row).
 */
type CategoryClient = Pick<
  Prisma.TransactionClient,
  "medicationCategoryAssignment" | "medicationCategoryLabel"
>;

function isBuiltIn(input: string): input is MedicationCategory {
  return MEDICATION_CATEGORIES.includes(input as MedicationCategory);
}

/**
 * Each medication's category, resolved against its owner's own labels. A
 * custom key resolves only to a label owned by the medication's owner (active
 * or hidden: hiding affects the picker, not what a medication shows). A key
 * with no such label — a restore that carried the medication but not the
 * label — reads as OTHER and is counted on the wide event, never a 500.
 */
export async function resolveMedicationCategories(
  medicationIds: string[],
  client: CategoryClient = prisma,
): Promise<Record<string, ResolvedMedicationCategory>> {
  if (medicationIds.length === 0) return {};

  const rows = await client.medicationCategoryAssignment.findMany({
    where: { medicationId: { in: medicationIds } },
    select: {
      medicationId: true,
      category: true,
      medication: { select: { userId: true } },
    },
  });

  const customKeys = [
    ...new Set(
      rows
        .map((row) => row.category)
        .filter((c) => isCustomMedicationCategoryKey(c)),
    ),
  ];
  const labels =
    customKeys.length === 0
      ? []
      : await client.medicationCategoryLabel.findMany({
          where: { key: { in: customKeys } },
          select: { key: true, userId: true, labelEncrypted: true },
        });
  const labelByKey = new Map(labels.map((l) => [l.key, l]));

  const map: Record<string, ResolvedMedicationCategory> = {};
  for (const id of medicationIds) {
    map[id] = { category: DEFAULT_CATEGORY, categoryLabel: null };
  }
  let dangling = 0;
  for (const row of rows) {
    if (isBuiltIn(row.category)) {
      map[row.medicationId] = { category: row.category, categoryLabel: null };
      continue;
    }
    const label = labelByKey.get(row.category);
    if (
      isCustomMedicationCategoryKey(row.category) &&
      label &&
      label.userId === row.medication.userId
    ) {
      map[row.medicationId] = {
        category: row.category as MedicationCategoryKey,
        categoryLabel: decryptFromBytes(label.labelEncrypted),
      };
      continue;
    }
    if (isCustomMedicationCategoryKey(row.category)) dangling += 1;
  }
  if (dangling > 0) {
    annotate({ meta: { "medication.category.dangling": dangling } });
  }
  return map;
}

/** Each medication's resolved category key (built-in or custom), no labels. */
export async function getMedicationCategories(
  medicationIds: string[],
  client: CategoryClient = prisma,
): Promise<Record<string, MedicationCategoryKey>> {
  const resolved = await resolveMedicationCategories(medicationIds, client);
  return Object.fromEntries(
    Object.entries(resolved).map(([id, r]) => [id, r.category]),
  );
}

/**
 * Whether `category` may be written onto a medication of `userId`: any
 * built-in value, or a custom key whose label belongs to that account.
 */
export async function isAssignableCategory(
  userId: string,
  category: string,
  client: CategoryClient = prisma,
): Promise<boolean> {
  if (isBuiltIn(category)) return true;
  if (!isCustomMedicationCategoryKey(category)) return false;
  const label = await client.medicationCategoryLabel.findFirst({
    where: { key: category, userId },
    select: { key: true },
  });
  return label !== null;
}

/**
 * Write a medication's category. A built-in value is stored as given; a
 * custom key only when it belongs to the medication's owner, otherwise the
 * write falls back to OTHER (the routes refuse a foreign key with a 422
 * before they get here; this is the floor for every other caller).
 */
export async function setMedicationCategory(
  medicationId: string,
  category: unknown,
  client: CategoryClient &
    Pick<Prisma.TransactionClient, "medication"> = prisma,
): Promise<MedicationCategoryKey> {
  let normalized: MedicationCategoryKey = DEFAULT_CATEGORY;
  if (typeof category === "string") {
    if (isBuiltIn(category)) {
      normalized = category;
    } else if (isCustomMedicationCategoryKey(category)) {
      const owner = await client.medication.findUnique({
        where: { id: medicationId },
        select: { userId: true },
      });
      if (
        owner &&
        (await isAssignableCategory(owner.userId, category, client))
      ) {
        normalized = category as MedicationCategoryKey;
      }
    }
  }

  await client.medicationCategoryAssignment.upsert({
    where: { medicationId },
    create: { medicationId, category: normalized },
    update: { category: normalized },
  });

  return normalized;
}

export async function deleteMedicationCategory(
  medicationId: string,
  client: CategoryClient = prisma,
) {
  await client.medicationCategoryAssignment.deleteMany({
    where: { medicationId },
  });
}

// ── The person's own categories ─────────────────────────────────────────────

export interface MedicationCategoryLabelDto {
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  /** How many of the owner's medications are filed under it. */
  medicationCount: number;
}

/** Mint the key of a new custom category. */
export function mintCustomMedicationCategoryKey(): string {
  return `${CUSTOM_MEDICATION_CATEGORY_PREFIX}${randomUUID()}`;
}

export function encryptCategoryLabel(label: string): Uint8Array<ArrayBuffer> {
  return encryptToBytes(label);
}

export function decryptCategoryLabel(bytes: Uint8Array): string {
  return decryptFromBytes(bytes);
}

/** Every custom category of `userId`, hidden ones included, in picker order. */
export async function listMedicationCategoryLabels(
  userId: string,
  client: CategoryClient = prisma,
): Promise<MedicationCategoryLabelDto[]> {
  const rows = await client.medicationCategoryLabel.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      key: true,
      labelEncrypted: true,
      sortOrder: true,
      isActive: true,
    },
  });
  if (rows.length === 0) return [];
  const counts = await client.medicationCategoryAssignment.groupBy({
    by: ["category"],
    where: {
      category: { in: rows.map((r) => r.key) },
      medication: { userId },
    },
    _count: { _all: true },
  });
  const countByKey = new Map(counts.map((c) => [c.category, c._count._all]));
  return rows.map((r) => ({
    key: r.key,
    label: decryptCategoryLabel(r.labelEncrypted),
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    medicationCount: countByKey.get(r.key) ?? 0,
  }));
}

/**
 * Every custom category of `userId` as the backup carries it: the decrypted
 * label (re-encrypted under the restoring instance's key) and its creation
 * instant, hidden ones included.
 */
export async function readMedicationCategoryLabelsForBackup(
  userId: string,
  client: CategoryClient = prisma,
): Promise<
  Array<{
    key: string;
    label: string;
    sortOrder: number;
    isActive: boolean;
    createdAt: string;
  }>
> {
  const rows = await client.medicationCategoryLabel.findMany({
    where: { userId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      key: true,
      labelEncrypted: true,
      sortOrder: true,
      isActive: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    key: r.key,
    label: decryptCategoryLabel(r.labelEncrypted),
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Delete one of `userId`'s custom categories. Its medications move to OTHER
 * in the same transaction, so no medication is ever left pointing at a key
 * that no longer exists. Returns how many moved, or null when the key is not
 * one of the caller's.
 */
export async function deleteMedicationCategoryLabel(
  userId: string,
  key: string,
): Promise<{ movedCount: number } | null> {
  return prisma.$transaction(async (tx) => {
    const owned = await tx.medicationCategoryLabel.findFirst({
      where: { key, userId },
      select: { id: true },
    });
    if (!owned) return null;
    const moved = await tx.medicationCategoryAssignment.updateMany({
      where: { category: key, medication: { userId } },
      data: { category: DEFAULT_CATEGORY },
    });
    await tx.medicationCategoryLabel.delete({ where: { id: owned.id } });
    return { movedCount: moved.count };
  });
}
