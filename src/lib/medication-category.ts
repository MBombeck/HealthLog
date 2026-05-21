import { prisma } from "@/lib/db";
import { MEDICATION_CATEGORY_VALUES } from "@/lib/validations/medication";

const MEDICATION_CATEGORIES = MEDICATION_CATEGORY_VALUES;

export type MedicationCategory = (typeof MEDICATION_CATEGORIES)[number];

const DEFAULT_CATEGORY: MedicationCategory = "OTHER";

let ensureTablePromise: Promise<void> | null = null;

function normalizeCategory(input: unknown): MedicationCategory {
  if (typeof input !== "string") return DEFAULT_CATEGORY;
  return MEDICATION_CATEGORIES.includes(input as MedicationCategory)
    ? (input as MedicationCategory)
    : DEFAULT_CATEGORY;
}

async function ensureMedicationCategoryTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS medication_categories (
          medication_id TEXT PRIMARY KEY REFERENCES medications(id) ON DELETE CASCADE,
          category TEXT NOT NULL DEFAULT 'OTHER',
          updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS medication_categories_category_idx
        ON medication_categories(category);
      `);
    })().catch((err) => {
      ensureTablePromise = null;
      throw err;
    });
  }

  await ensureTablePromise;
}

export async function getMedicationCategories(
  medicationIds: string[],
): Promise<Record<string, MedicationCategory>> {
  if (medicationIds.length === 0) return {};
  await ensureMedicationCategoryTable();

  const rows = await prisma.$queryRawUnsafe<
    Array<{ medication_id: string; category: string }>
  >(
    `
      SELECT medication_id, category
      FROM medication_categories
      WHERE medication_id = ANY($1::text[])
    `,
    medicationIds,
  );

  const map: Record<string, MedicationCategory> = {};
  for (const id of medicationIds) {
    map[id] = DEFAULT_CATEGORY;
  }
  for (const row of rows) {
    map[row.medication_id] = normalizeCategory(row.category);
  }
  return map;
}

export async function setMedicationCategory(
  medicationId: string,
  category: unknown,
) {
  await ensureMedicationCategoryTable();
  const normalized = normalizeCategory(category);

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO medication_categories (medication_id, category, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (medication_id)
      DO UPDATE SET category = EXCLUDED.category, updated_at = NOW()
    `,
    medicationId,
    normalized,
  );

  return normalized;
}

export async function deleteMedicationCategory(medicationId: string) {
  await ensureMedicationCategoryTable();
  await prisma.$executeRawUnsafe(
    `DELETE FROM medication_categories WHERE medication_id = $1`,
    medicationId,
  );
}
