import { prisma } from "@/lib/db";

let medicationSchemaPromise: Promise<void> | null = null;

async function ensureMedicationSchema() {
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "medications"
    ADD COLUMN IF NOT EXISTS "notifications_enabled" BOOLEAN NOT NULL DEFAULT true;
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "medications"
    ADD COLUMN IF NOT EXISTS "paused_at" TIMESTAMP(3);
  `);
}

export async function ensureDbCompatibility() {
  if (!medicationSchemaPromise) {
    medicationSchemaPromise = ensureMedicationSchema().catch((error) => {
      medicationSchemaPromise = null;
      throw error;
    });
  }

  await medicationSchemaPromise;
}
