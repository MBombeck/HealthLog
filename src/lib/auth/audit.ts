import { prisma } from "@/lib/db";
import { lookupIpAsn, lookupIpLocation } from "@/lib/geo";

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

  // Fire-and-forget: resolve IP location + carrier and update the entry
  // with whichever fields the resolver could fill. v1.4.27 B3 — carrier
  // resolution is synchronous offline MMDB read so it cannot outrun the
  // location-lookup 3 s race; we run both inside the same race so a
  // hung online provider still bounds the await window.
  if (opts.ipAddress && action.startsWith("auth.")) {
    const ipAddress = opts.ipAddress;
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 3000),
    );

    Promise.race([
      Promise.all([
        lookupIpLocation(ipAddress),
        Promise.resolve(lookupIpAsn(ipAddress)),
      ]),
      timeout,
    ])
      .then((result) => {
        if (!result) return;
        const [location, asnRow] = result;
        const data: {
          location?: string;
          asn?: number;
          carrier?: string | null;
        } = {};
        if (location) data.location = location;
        if (asnRow) {
          data.asn = asnRow.asn;
          data.carrier = asnRow.carrier;
        }
        if (Object.keys(data).length === 0) return;
        return prisma.auditLog.update({
          where: { id: entry.id },
          data,
        });
      })
      .catch(() => {
        // Silently ignore geo lookup failures
      });
  }
}
