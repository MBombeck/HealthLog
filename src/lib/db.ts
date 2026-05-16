import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Prisma's `InputJsonValue` requires an explicit index signature that
// typed application shapes (Zod-validated, hand-written interfaces)
// don't carry. Every JSON-column write would otherwise repeat the same
// `value as unknown as Prisma.InputJsonValue` escape hatch — this one
// helper centralises the cast so the WHY stays in a single place.
export const toJson = <T>(v: T) => v as unknown as Prisma.InputJsonValue;
