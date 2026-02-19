import { prisma } from "@/lib/db";

export async function auditLog(
  action: string,
  opts: {
    userId?: string | null;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  } = {},
) {
  await prisma.auditLog.create({
    data: {
      action,
      userId: opts.userId ?? null,
      details: opts.details ? JSON.stringify(opts.details) : null,
      ipAddress: opts.ipAddress ?? null,
    },
  });
}
