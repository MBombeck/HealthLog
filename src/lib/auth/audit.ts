import { prisma } from "@/lib/db";
import { lookupIpLocation } from "@/lib/geo";

export async function auditLog(
  action: string,
  opts: {
    userId?: string | null;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  } = {},
) {
  const entry = await prisma.auditLog.create({
    data: {
      action,
      userId: opts.userId ?? null,
      details: opts.details ? JSON.stringify(opts.details) : null,
      ipAddress: opts.ipAddress ?? null,
    },
  });

  // Fire-and-forget: resolve IP location and update the entry
  if (opts.ipAddress && action.startsWith("auth.")) {
    lookupIpLocation(opts.ipAddress)
      .then((location) => {
        if (location) {
          return prisma.auditLog.update({
            where: { id: entry.id },
            data: { location },
          });
        }
      })
      .catch(() => {
        // Silently ignore geo lookup failures
      });
  }
}
